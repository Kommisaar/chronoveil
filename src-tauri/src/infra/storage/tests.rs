//! `storage` 门面级测试（自 storage.rs 外置，源文件 500 行上限）：
//! 迁移幂等与 schema 形态、外键约束、端口实现断言、commit_settlement 结算
//! 单事务（成功落库 / 首边界 / 任一支路失败整体回滚）。
use super::test_support::{cleanup, temp_storage};
use super::*;
use crate::domain::models::{NewCharacter, NewSession, RosterPick};
use rusqlite::Connection;
use std::path::PathBuf;

/// 迁移幂等（验收 3）：同一库文件重复打开，版本记录不重复、建表语句不报错。
#[test]
fn reopen_same_db_is_idempotent() {
    let dir = std::env::temp_dir().join(format!("chronoveil_test_{}_reopen", std::process::id()));
    cleanup(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("test.db");

    drop(Storage::open(&db_path).unwrap());
    drop(Storage::open(&db_path).unwrap());
    drop(Storage::open(&db_path).unwrap());

    let conn = Connection::open(&db_path).unwrap();
    let versions: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT version FROM schema_version ORDER BY version")
            .unwrap();
        let rows = stmt.query_map([], |r| r.get(0)).unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    };
    assert_eq!(
        versions,
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
        "schema_version 各版本只记录一次"
    );

    let tables: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN \
                     ('characters', 'sessions', 'messages', 'scenes', 'character_state', \
                     'character_instances', 'llm_calls') \
                     ORDER BY name",
            )
            .unwrap();
        let rows = stmt.query_map([], |r| r.get(0)).unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    };
    assert_eq!(
        tables,
        vec![
            "character_instances".to_string(),
            "character_state".to_string(),
            "characters".to_string(),
            "llm_calls".to_string(),
            "messages".to_string(),
            "scenes".to_string(),
            "sessions".to_string(),
        ],
        "v1 三表 + 5b 两新表（迁移 0002）+ 调用轨迹表（迁移 0008）+ 实例表（迁移 0009）"
    );
    drop(conn);
    cleanup(&dir);
}

/// 验收 3：avatar 列、三表 deleted_at、两个索引都在迁移产物中。
#[test]
fn schema_has_avatar_deleted_at_and_indexes() {
    let (storage, dir): (_, PathBuf) = temp_storage("schema");
    let db_path = dir.join("test.db");
    drop(storage);

    let conn = Connection::open(&db_path).unwrap();
    let column_names = |table: &str| -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(1)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    };

    let char_cols = column_names("characters");
    assert!(
        char_cols.iter().any(|c| c == "avatar"),
        "characters.avatar 缺失（data_model rev 6）"
    );
    for table in ["characters", "sessions", "messages"] {
        assert!(
            column_names(table).iter().any(|c| c == "deleted_at"),
            "{table}.deleted_at 缺失（ADR-009 全库软删除）"
        );
    }

    let indexes: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'index' \
                     AND name IN ('idx_sessions_updated', 'idx_messages_session') ORDER BY name",
            )
            .unwrap();
        let rows = stmt.query_map([], |r| r.get(0)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    };
    assert_eq!(
        indexes,
        vec!["idx_messages_session", "idx_sessions_updated"],
        "验收 3 要求的两个索引必须存在"
    );
    drop(conn);
    cleanup(&dir);
}

/// 阵容引用不存在的卡：实例化路径逐卡 NotFound（多角色换挂后不再是无名外键冲突）。
#[test]
fn foreign_keys_enforced() {
    let (storage, dir) = temp_storage("fk");
    let err = storage
        .create_session(&NewSession {
            roster: vec![
                RosterPick {
                    character_id: 999_999,
                    is_user: true,
                },
                RosterPick {
                    character_id: 999_998,
                    is_user: false,
                },
            ],
            title: String::new(),
            opening: None,
        })
        .unwrap_err();
    assert!(
        matches!(err, StorageError::NotFound { .. }),
        "实际：{err:?}"
    );
    drop(storage);
    cleanup(&dir);
}

/// Storage 必须实现存储端口（DIP：上层只依赖 domain::ports）。
#[test]
fn storage_impls_storage_port() {
    fn assert_impl<T: StoragePort>(_: &T) {}
    let (storage, dir) = temp_storage("port");
    assert_impl(&storage);
    let _ = storage
        .create_character(&NewCharacter {
            name: "经端口创建".into(),
            ..Default::default()
        })
        .unwrap();
    drop(storage);
    cleanup(&dir);
}

// ---- commit_settlement（FR-011：结算单事务）----

use crate::domain::models::{CharacterStateScope, NewCharacterState};
use crate::domain::ports::AttachRange;

/// 在世消息的 scene_id 列快照（按 id 升序）：scene_id 已开进 Message 读路径，
/// 直接经端口（list_messages，id ASC）读取断言，不再另开只读连接。
fn attached_scene_ids(storage: &Storage, session_id: i64) -> Vec<Option<i64>> {
    storage
        .list_messages(session_id)
        .unwrap()
        .into_iter()
        .map(|message| message.scene_id)
        .collect()
}

/// 夹具：两张卡（「旅人」用户位 + 「苏鸢」LLM 位）+ 会话 + 两条消息（user、
/// assistant 各一），返回各 id（llm_instance = 装配/结算的生成位实例）。
fn settlement_fixture(tag: &str) -> (Storage, PathBuf, i64, i64, i64, i64) {
    let (storage, dir) = temp_storage(tag);
    let user_card = storage
        .create_character(&NewCharacter {
            name: "旅人".into(),
            ..Default::default()
        })
        .unwrap()
        .id;
    let llm_card = storage
        .create_character(&NewCharacter {
            name: "苏鸢".into(),
            ..Default::default()
        })
        .unwrap()
        .id;
    let session_id = storage
        .create_session(&NewSession {
            roster: vec![
                RosterPick {
                    character_id: user_card,
                    is_user: true,
                },
                RosterPick {
                    character_id: llm_card,
                    is_user: false,
                },
            ],
            title: String::new(),
            opening: None,
        })
        .unwrap()
        .id;
    // roster 输入序 = 实例创建序：LLM 位放首位 → 实例 id 1（与旧用例的 char_id=1 断言最小差异）。
    let llm_instance = storage
        .list_instances(session_id)
        .unwrap()
        .into_iter()
        .find(|i| !i.is_user)
        .unwrap()
        .id;
    let user_id = storage
        .insert_message(&NewMessage::new(
            session_id,
            MessageRole::User,
            "推门进去。",
        ))
        .unwrap()
        .id;
    let assistant_id = storage
        .insert_message(&NewMessage::new(
            session_id,
            MessageRole::Assistant,
            "她抬头。\n\n---\n\n新的开始。",
        ))
        .unwrap()
        .id;
    (
        storage,
        dir,
        llm_instance,
        session_id,
        user_id,
        assistant_id,
    )
}

fn new_scene(session_id: i64) -> NewScene {
    NewScene {
        session_id,
        location: Some("旧书店 · 打烊后".into()),
        time_note: Some("次日清晨".into()),
        fic_day: Some(2),
        fic_part: Some("清晨".into()),
        date_label: Some("第2日·清晨".into()),
        summary: Some("昨夜争执后两人无言告别".into()),
        recap: None,
        present: vec![1],
    }
}

/// 结算成功路径：上一行 summary 回写、收束段消息归属、新行 idx 自增、
/// 状态 upsert 与软删清除一次落库（FR-011 / INT-003）。
#[test]
fn commit_settlement_lands_all_branches_in_one_transaction() {
    let (storage, dir, llm_instance, session_id, _user_id, assistant_id) =
        settlement_fixture("settle_ok");
    // 上一结算的边界快照行（开场段）+ 一条待清除状态。
    let previous = storage.insert_scene(&new_scene(session_id)).unwrap();
    let stale = storage
        .upsert_character_state(&NewCharacterState {
            instance_id: llm_instance,
            scope: CharacterStateScope::State,
            key: "别扭".into(),
            value: "欲言又止".into(),
            expiry: Some("scene_end".into()),
            source_scene: Some(previous.id),
        })
        .unwrap();

    let write = SettlementWrite {
        scene: NewScene {
            summary: Some("钟楼下的对峙无果而终".into()),
            ..new_scene(session_id)
        },
        close_scene_id: Some(previous.id),
        close_summary: Some("昨夜争执后两人无言告别".into()),
        close_recap: Some(
            "争执从一句误口信开始。两人隔着柜台沉默了很久。最后她把伞留下，独自走进雨夜。".into(),
        ),
        attach: Some(AttachRange {
            scene_id: previous.id,
            after_message_id: 0,
            upto_message_id: assistant_id,
        }),
        state_upserts: vec![NewCharacterState {
            instance_id: llm_instance,
            scope: CharacterStateScope::State,
            key: "情绪".into(),
            value: "释然".into(),
            expiry: Some("event:亮灯".into()),
            source_scene: Some(previous.id),
        }],
        state_clears: vec![stale.id],
    };
    let scene = storage.commit_settlement(&write).unwrap();

    // 新行：idx 沿上一行单调自增，边界快照字段原样落库。
    assert_eq!(scene.idx, previous.idx + 1);
    assert_eq!(scene.location.as_deref(), Some("旧书店 · 打烊后"));
    assert_eq!(scene.summary.as_deref(), Some("钟楼下的对峙无果而终"));
    assert_eq!(scene.present, vec![1]);
    // 上一行 summary / recap 回写（Task-03 同路径）+ 收束段两条消息归属到上一行
    // （边界快照语义）。
    let reloaded = storage.list_scenes(session_id).unwrap();
    assert_eq!(reloaded.len(), 3, "开场锚行（FR-014 seed）+ 上一行 + 新行");
    let previous_row = reloaded.iter().find(|s| s.id == previous.id).unwrap();
    assert_eq!(
        previous_row.summary.as_deref(),
        Some("昨夜争执后两人无言告别")
    );
    assert_eq!(
        previous_row.recap.as_deref(),
        Some("争执从一句误口信开始。两人隔着柜台沉默了很久。最后她把伞留下，独自走进雨夜。"),
        "recap 随 summary 同路径回写上一行"
    );
    assert_eq!(
        reloaded.last().unwrap().recap,
        None,
        "新行 recap 按调用方原样落库并往返读出（存储层不设策略；\
             编排层恒传 None，见 director::build_write 的 2026-09-12 裁决修订）"
    );
    assert_eq!(
        attached_scene_ids(&storage, session_id),
        vec![Some(previous.id), Some(previous.id)],
        "收束段消息挂到上一行"
    );
    // 状态清算：新键 upsert、旧键软删（墓碑可还原，ADR-009）。
    let states = storage.list_character_states(session_id).unwrap();
    assert_eq!(states.len(), 1);
    assert_eq!(states[0].key, "情绪");
    assert_eq!(states[0].value, "释然");
    assert_eq!(states[0].source_scene, Some(previous.id));
    assert_eq!(states[0].deleted_at, None);
    assert!(
        storage.soft_delete_character_state(stale.id).is_err(),
        "清除支路已置墓碑：再删报 NotFound"
    );
    drop(storage);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 「无上一行」支路（close / attach / 回写全部缺席）：仅落新场景行。
/// FR-014 起建会话必 seed 开场锚行，本用例在锚行之上验证 None 支路不失败。
#[test]
fn commit_settlement_first_boundary_only_inserts_scene() {
    let (storage, dir, _char_id, session_id, _user_id, _assistant_id) =
        settlement_fixture("settle_first");
    let scene = storage
        .commit_settlement(&SettlementWrite {
            scene: new_scene(session_id),
            close_scene_id: None,
            close_summary: None,
            close_recap: None,
            attach: None,
            state_upserts: Vec::new(),
            state_clears: Vec::new(),
        })
        .unwrap();
    assert_eq!(scene.idx, 1, "开场锚行（idx 0）之上自增");
    assert_eq!(storage.list_scenes(session_id).unwrap().len(), 2);
    assert!(
        attached_scene_ids(&storage, session_id)
            .iter()
            .all(|id| id.is_none()),
        "无上一行不产生消息归属（留待后续结算自愈，§7-2）"
    );
    drop(storage);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 回滚测试（INT-003 未成功的结算无副作用）：清除支路指向不存在行 → 整体失败，
/// 新场景行 / summary 回写 / 消息归属 / upsert 一律不留痕迹。
#[test]
fn commit_settlement_rolls_back_on_any_branch_failure() {
    let (storage, dir, llm_instance, session_id, _user_id, assistant_id) =
        settlement_fixture("settle_rollback");
    let previous = storage.insert_scene(&new_scene(session_id)).unwrap();
    let before_summary = previous.summary.clone();
    let before_scenes = storage.list_scenes(session_id).unwrap().len();

    let err = storage
        .commit_settlement(&SettlementWrite {
            scene: new_scene(session_id),
            close_scene_id: Some(previous.id),
            close_summary: Some("不该被写进去的摘要".into()),
            close_recap: Some("不该被写进去的回顾".into()),
            attach: Some(AttachRange {
                scene_id: previous.id,
                after_message_id: 0,
                upto_message_id: assistant_id,
            }),
            state_upserts: vec![NewCharacterState {
                instance_id: llm_instance,
                scope: CharacterStateScope::State,
                key: "情绪".into(),
                value: "释然".into(),
                expiry: None,
                source_scene: None,
            }],
            state_clears: vec![999_999], // 不存在的状态行 → NotFound → 整体回滚
        })
        .unwrap_err();
    assert!(
        matches!(err, StorageError::NotFound { .. }),
        "实际：{err:?}"
    );

    assert_eq!(
        storage.list_scenes(session_id).unwrap().len(),
        before_scenes,
        "无新场景行"
    );
    assert_eq!(
        storage.latest_scene(session_id).unwrap().unwrap().summary,
        before_summary,
        "summary 回写未发生"
    );
    assert_eq!(
        storage.latest_scene(session_id).unwrap().unwrap().recap,
        None,
        "recap 回写未发生（回滚覆盖 Task-03 同路径支路）"
    );
    assert!(
        attached_scene_ids(&storage, session_id)
            .iter()
            .all(|id| id.is_none()),
        "消息归属未发生"
    );
    assert!(
        storage
            .list_character_states(session_id)
            .unwrap()
            .is_empty(),
        "upsert 未发生"
    );
    drop(storage);
    let _ = std::fs::remove_dir_all(&dir);
}
