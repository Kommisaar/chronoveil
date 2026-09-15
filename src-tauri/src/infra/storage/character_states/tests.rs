//! character_state 存储测试（自 character_states.rs 外置，源文件 500 行上限）：
//! 追加式历史链（迁移 0010 状态历史化）、墓碑交互、生效行读路径、as_of 时间点还原。

use super::*;
use crate::domain::models::{NewCharacter, NewCharacterInstance, NewScene, NewSession, RosterPick};
use crate::domain::ports::StoragePort;
use crate::infra::storage::{test_support::{seed_world, temp_storage}, Storage};
use rusqlite::Connection;
use std::path::PathBuf;
use std::thread::sleep;
use std::time::Duration;

/// 测试夹具：建角色卡 + 会话（1 用户位 + 1 LLM 位），返回
/// (storage, dir, user_instance_id, llm_instance_id, session_id)。
fn setup(tag: &str) -> (Storage, PathBuf, i64, i64, i64) {
    let (storage, dir) = temp_storage(tag);
    let user_card = storage
        .create_character(&NewCharacter { name: "旅人".into(), ..Default::default() })
        .unwrap()
        .id;
    let llm_card = storage
        .create_character(&NewCharacter { name: "艾莉".into(), ..Default::default() })
        .unwrap()
        .id;
    let session_id = storage
        .create_session(&NewSession {
            roster: vec![
                RosterPick { character_id: user_card, is_user: true },
                RosterPick { character_id: llm_card, is_user: false },
            ],
            title: String::new(),
            opening: None,
        
            default_render_style: "type".to_string(),
            world_id: seed_world(&storage),
        })
        .unwrap()
        .id;
    let instances = storage.list_instances(session_id).unwrap();
    // list_instances：用户位在前（is_user DESC），LLM 位随后（id ASC）。
    let user_instance = instances.iter().find(|i| i.is_user).unwrap().id;
    let llm_instance = instances.iter().find(|i| !i.is_user).unwrap().id;
    (storage, dir, user_instance, llm_instance, session_id)
}

fn state(instance_id: i64, key: &str, value: &str) -> NewCharacterState {
    NewCharacterState {
        instance_id,
        scope: CharacterStateScope::State,
        key: key.into(),
        value: value.into(),
        expiry: Some("scene_end".into()),
        source_scene: None,
    }
}

/// 极简场景行（as_of 用例的时间锚）：按插入序自增 idx（开场锚行 idx 0 之上）。
fn scene_at(session_id: i64) -> NewScene {
    NewScene {
        session_id,
        location: None,
        time_note: None,
        fic_day: None,
        fic_part: None,
        date_label: None,
        summary: None,
        recap: None,
        present: Vec::new(),
    }
}

/// 验收 2（迁移 0010 状态历史化）：同 key 三次变更保留全链——
/// 「警惕 → 释然 → 悲伤」三行都在（append-only，历史不丢），
/// 而读路径（list_character_states 生效行视角）只见最后一行。
#[test]
fn upsert_appends_history_chain_and_reads_latest_only() {
    let (storage, dir, _uid, lid, sid) = setup("state_append_chain");
    let first = storage
        .upsert_character_state(&state(lid, "情绪", "警惕"))
        .unwrap();
    assert_eq!(first.scope, CharacterStateScope::State);
    assert_eq!(first.expiry.as_deref(), Some("scene_end"));
    assert_eq!(first.deleted_at, None);
    assert_eq!(first.superseded_at, None, "新行即生效行");

    sleep(Duration::from_millis(4));
    let second = storage
        .upsert_character_state(&NewCharacterState {
            expiry: Some("event:亮灯".into()),
            source_scene: Some(7),
            ..state(lid, "情绪", "释然")
        })
        .unwrap();
    assert_ne!(second.id, first.id, "历史化后同键变更为追加新行，不覆盖");
    assert_eq!(second.value, "释然");
    assert_eq!(second.expiry.as_deref(), Some("event:亮灯"));
    assert_eq!(second.source_scene, Some(7));
    assert!(second.updated_at > first.updated_at, "时间序随追加前进");
    assert_eq!(second.superseded_at, None);

    sleep(Duration::from_millis(4));
    let third = storage
        .upsert_character_state(&state(lid, "情绪", "悲伤"))
        .unwrap();
    assert_ne!(third.id, second.id);

    // 读路径（生效行视角）：只见最后一行——装配 / 结算 / 状态面板行为不变（验收 1）。
    let live = storage
        .list_character_states(sid)
        .unwrap()
        .into_iter()
        .filter(|s| s.instance_id == lid)
        .collect::<Vec<_>>();
    assert_eq!(live.len(), 1, "生效行视角同键只有一行");
    assert_eq!(live[0].id, third.id);
    assert_eq!(live[0].value, "悲伤");

    // 历史链：三行全在（警惕→释然→悲伤），前两行已打 superseded_at，末行生效。
    drop(storage);
    let conn = Connection::open(dir.join("test.db")).unwrap();
    let chain: Vec<(String, Option<i64>)> = {
        let mut stmt = conn
            .prepare(
                "SELECT value, superseded_at FROM character_state \
                 WHERE instance_id = ?1 ORDER BY id ASC",
            )
            .unwrap();
        let rows = stmt
            .query_map(params![lid], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    };
    assert_eq!(chain.len(), 3, "append-only 全链保留：警惕→释然→悲伤");
    assert_eq!(chain[0].0, "警惕");
    assert_eq!(chain[1].0, "释然");
    assert_eq!(chain[2].0, "悲伤");
    assert!(chain[0].1.is_some() && chain[1].1.is_some(), "被取代行必须带 superseded_at");
    assert_eq!(chain[2].1, None, "末行生效（未取代）");
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 验收 2（迁移 0002 决策、0010 收窄沿用）：软删墓碑行同键重插——partial unique
/// index 只约束生效行，重插为新行（新 id），墓碑原样保留。
#[test]
fn tombstone_does_not_block_same_key_reinsert() {
    let (storage, dir, _uid, lid, _sid) = setup("state_tomb");
    let gone = storage
        .upsert_character_state(&state(lid, "情绪", "警觉"))
        .unwrap();
    storage.soft_delete_character_state(gone.id).unwrap();
    assert!(
        storage
            .list_character_states(_sid)
            .unwrap()
            .iter()
            .all(|s| s.instance_id != lid),
        "软删后列表不得含墓碑行（ADR-009）"
    );
    assert!(matches!(
        storage.soft_delete_character_state(gone.id),
        Err(StorageError::NotFound { .. })
    ));

    let again = storage
        .upsert_character_state(&state(lid, "情绪", "平静"))
        .unwrap();
    assert_ne!(again.id, gone.id, "重插是新行");
    assert_eq!(again.value, "平静");
    let mine = storage
        .list_character_states(_sid)
        .unwrap()
        .into_iter()
        .filter(|s| s.instance_id == lid)
        .collect::<Vec<_>>();
    assert_eq!(mine.len(), 1, "墓碑行不入列表，重插行可见");
    assert_eq!(mine[0].id, again.id);
    drop(storage);
    let _ = std::fs::remove_dir_all(&dir);
}

/// FR-012 + 迁移 0009 换挂：状态挂实例、按会话查询跨实例可见（经实例表过滤）、
/// 软删过滤生效；scope=relation 与 state 并存；同键不同实例互不冲突。
#[test]
fn list_by_session_filters_and_covers_scopes() {
    let (storage, dir, uid, lid, sid) = setup("state_list");
    // 动态造人式第二实例（D6 同权）：直接走 create_instance。
    let other = storage
        .create_instance(&NewCharacterInstance {
            session_id: sid,
            character_id: None,
            name: "乙".into(),
            persona: String::new(),
            render_style: "type".into(),
            is_user: false,
        })
        .unwrap();

    let mut relation = state(lid, "对乙的态度", "戒备");
    relation.scope = CharacterStateScope::Relation;
    let a = storage.upsert_character_state(&state(lid, "情绪", "警觉")).unwrap();
    let b = storage.upsert_character_state(&relation).unwrap();
    // 另一实例、同一会话：按会话查询应一并返回（FR-012 会话内全景）。
    let c = storage
        .upsert_character_state(&state(other.id, "情绪", "平静"))
        .unwrap();
    // 干扰项：另一会话的同名实例不可见。
    let user_card = storage.list_characters().unwrap()[0].id;
    let llm_card = storage.list_characters().unwrap()[1].id;
    let other_session = storage
        .create_session(&NewSession {
            roster: vec![
                RosterPick { character_id: user_card, is_user: true },
                RosterPick { character_id: llm_card, is_user: false },
            ],
            title: String::new(),
            opening: None,
        
            default_render_style: "type".to_string(),
            world_id: seed_world(&storage),
        })
        .unwrap()
        .id;
    let other_session_llm = storage
        .list_instances(other_session)
        .unwrap()
        .into_iter()
        .find(|i| !i.is_user)
        .unwrap()
        .id;
    storage
        .upsert_character_state(&state(other_session_llm, "情绪", "别串场"))
        .unwrap();

    let list = storage.list_character_states(sid).unwrap();
    let ids: Vec<i64> = list.iter().map(|s| s.id).collect();
    assert_eq!(ids, vec![a.id, b.id, c.id], "按 id 升序，跨实例、限会话");
    assert_eq!(list[1].scope, CharacterStateScope::Relation, "scope 往返一致");
    assert_eq!(list[1].instance_id, lid, "归属实例往返一致");

    // 软删过滤
    storage.soft_delete_character_state(b.id).unwrap();
    let list = storage.list_character_states(sid).unwrap();
    let ids: Vec<i64> = list.iter().map(|s| s.id).collect();
    assert_eq!(ids, vec![a.id, c.id], "墓碑行被过滤");

    // 同键不同实例互不冲突（唯一键 = (instance_id, key)，迁移 0009 换挂）。
    let same_key_other = storage.upsert_character_state(&state(uid, "情绪", "坦然")).unwrap();
    assert_ne!(same_key_other.id, a.id, "同键挂不同实例为新行");
    drop(storage);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 验收 3（迁移 0010）：时间点查询还原「第 N 场时的状态」——
/// 第 2 场设 A、第 4 场设 B：取第 3 场时点得 A；锚点早于一切时返回空；
/// 每 key 独立取「锚点前最新行」。
#[test]
fn as_of_scene_restores_state_at_anchor() {
    let (storage, dir, _uid, lid, sid) = setup("state_as_of");
    // 开场锚行（idx 0）之上落四场：idx 1..4。
    let s1 = storage.insert_scene(&scene_at(sid)).unwrap();
    let s2 = storage.insert_scene(&scene_at(sid)).unwrap();
    let _s3 = storage.insert_scene(&scene_at(sid)).unwrap();
    let s4 = storage.insert_scene(&scene_at(sid)).unwrap();
    assert_eq!((s1.idx, s2.idx, s4.idx), (1, 2, 4));

    // 第 2 场设 A（情绪 = 警觉），第 4 场设 B（情绪 = 释然）；第 1 场另设一 key。
    let key_a = storage
        .upsert_character_state(&NewCharacterState {
            source_scene: Some(s2.id),
            ..state(lid, "情绪", "警觉")
        })
        .unwrap();
    sleep(Duration::from_millis(4));
    let key_b = storage
        .upsert_character_state(&NewCharacterState {
            source_scene: Some(s4.id),
            expiry: None,
            ..state(lid, "情绪", "释然")
        })
        .unwrap();
    storage
        .upsert_character_state(&NewCharacterState {
            source_scene: Some(s1.id),
            expiry: None,
            ..state(lid, "持有", "黄铜钥匙")
        })
        .unwrap();

    let value_at = |idx: i64| -> Vec<(String, String)> {
        storage
            .list_character_states_as_of_scene(sid, idx)
            .unwrap()
            .into_iter()
            .map(|s| (s.key, s.value))
            .collect()
    };

    // 锚点早于一切：第 0 / 1 场时点，情绪（第 2 场才设）尚不存在。
    assert_eq!(value_at(0), vec![], "锚点早于一切时返回空");
    assert_eq!(value_at(1), vec![], "第 1 场进行中：情绪未设（持有也是本场所设，自下场起生效）");
    assert_eq!(value_at(2), vec![("持有".into(), "黄铜钥匙".into())], "第 2 场：持有已在，情绪未生效");

    // 取第 3 场时点得 A（第 4 场所设 B 尚未生效）；结果按 id 升序（插入序）。
    let at3 = value_at(3);
    assert_eq!(at3, vec![("情绪".into(), "警觉".into()), ("持有".into(), "黄铜钥匙".into())]);

    // 第 5 场时点（B 的来源场 idx 4 之后）：情绪翻到 B，每 key 独立取最新。
    let at5 = value_at(5);
    assert_eq!(at5, vec![("情绪".into(), "释然".into()), ("持有".into(), "黄铜钥匙".into())]);

    // as_of 行可能含历史链行（当下已被取代）：at3 里的情绪行正是当下生效行 key_b
    // 的前身 key_a——字段往返完整。
    let restored = storage
        .list_character_states_as_of_scene(sid, 3)
        .unwrap()
        .into_iter()
        .find(|s| s.key == "情绪")
        .unwrap();
    assert_eq!(restored.id, key_a.id);
    assert_ne!(restored.id, key_b.id);
    drop(storage);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 验收 3 补充（迁移 0010）：NULL source 视为自会话之始（任何锚点可还原）；
/// 墓碑交互——清除动作未锚定场景，被清除过的 key 在任何锚点都不还原
///（宁可缺失、不虚构复活，契约见 ports），重设只在重设场之后可见。
#[test]
fn as_of_scene_honors_null_source_and_tombstones() {
    let (storage, dir, _uid, lid, sid) = setup("state_as_of_tomb");
    let s2 = storage.insert_scene(&scene_at(sid)).unwrap();
    let _s3 = storage.insert_scene(&scene_at(sid)).unwrap();
    let s4 = storage.insert_scene(&scene_at(sid)).unwrap();

    // NULL source：首场结算无上一行的状态 / 手工设置——自会话之始存在。
    storage.upsert_character_state(&state(lid, "情绪", "平静")).unwrap();
    sleep(Duration::from_millis(4));
    let token = storage
        .upsert_character_state(&NewCharacterState {
            source_scene: Some(s2.id),
            expiry: None,
            ..state(lid, "信物", "戒指")
        })
        .unwrap();
    let at = |idx: i64| -> Vec<(String, String)> {
        storage
            .list_character_states_as_of_scene(sid, idx)
            .unwrap()
            .into_iter()
            .map(|s| (s.key, s.value))
            .collect()
    };
    assert_eq!(
        at(0),
        vec![("情绪".into(), "平静".into())],
        "NULL source 自会话之始可还原（含开场锚行时点）"
    );
    assert_eq!(
        at(3),
        vec![("情绪".into(), "平静".into()), ("信物".into(), "戒指".into())]
    );

    // 清除「信物」：墓碑行一律排除，且清除动作本身没有场景锚——该 key 自此在任何
    // 锚点都还原不出（含清除前时点，宁缺不虚构；第 3 步如需精确还原须给清除补锚）。
    storage.soft_delete_character_state(token.id).unwrap();
    assert_eq!(at(3), vec![("情绪".into(), "平静".into())], "清除后 key 在任何锚点不可见");
    assert_eq!(at(9), vec![("情绪".into(), "平静".into())]);

    // 第 4 场重设「信物」：锚点 3 仍不可见（旧链墓碑排除、新行未生效），锚点 5 取新值。
    sleep(Duration::from_millis(4));
    storage
        .upsert_character_state(&NewCharacterState {
            source_scene: Some(s4.id),
            expiry: None,
            ..state(lid, "信物", "怀表")
        })
        .unwrap();
    assert_eq!(at(3), vec![("情绪".into(), "平静".into())]);
    assert_eq!(
        at(5),
        vec![("情绪".into(), "平静".into()), ("信物".into(), "怀表".into())],
        "重设后新链生效"
    );
    // 当下生效视角不受 as_of 干扰：情绪 + 信物（怀表）两行。
    assert_eq!(storage.list_character_states(sid).unwrap().len(), 2);
    drop(storage);
    let _ = std::fs::remove_dir_all(&dir);
}

/// scope 库值防御：非法值视为数据损坏（后端错误），不 panic。
#[test]
fn scope_from_db_rejects_unknown() {
    assert!(matches!(
        CharacterStateScope::from_db("mood"),
        Err(StorageError::Backend(_))
    ));
}
