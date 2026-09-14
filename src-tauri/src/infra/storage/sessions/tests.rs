//! sessions 表的行为验收测试（自 sessions.rs 外置，源文件 500 行上限）：
//! 阵容实例化 / 会话日历 / 开场锚行事务性 / CRUD 与排序；新用例在此追加。
use super::*;
use crate::domain::fiction_time;
use crate::domain::models::{MessageRole, NewCharacter, OpeningSeed, RosterPick};
use crate::domain::ports::StoragePort;
use crate::infra::storage::test_support::{cleanup, temp_storage};
use crate::infra::storage::Storage;
use rusqlite::Connection;
use std::thread::sleep;
use std::time::Duration;

/// 阵容便捷构造：用户位卡 + 单张 LLM 位卡（保持 roster 输入序 = 实例创建序）。
fn roster(user_card: i64, llm_card: i64) -> Vec<RosterPick> {
    vec![
        RosterPick { character_id: user_card, is_user: true },
        RosterPick { character_id: llm_card, is_user: false },
    ]
}

fn make_session(storage: &crate::infra::storage::Storage, title: &str) -> i64 {
    let user_card = storage
        .create_character(&NewCharacter { name: "旅人".into(), ..Default::default() })
        .unwrap()
        .id;
    let llm_card = storage
        .create_character(&NewCharacter { name: "卡".into(), ..Default::default() })
        .unwrap()
        .id;
    storage
        .create_session(&NewSession {
            roster: roster(user_card, llm_card),
            title: title.into(),
            opening: None,
        
            default_render_style: "type".to_string(),
        })
        .unwrap()
        .id
}

// ---- FR-014：开局包单事务落库 ----

/// 夹具：建用户位卡「苏鸢」+ LLM 位卡「阿烬」，返回 (storage, dir, user_card, llm_card)。
fn char_fixture(tag: &str) -> (Storage, std::path::PathBuf, i64, i64) {
    let (storage, dir) = temp_storage(tag);
    let user_card = storage
        .create_character(&NewCharacter { name: "苏鸢".into(), ..Default::default() })
        .unwrap()
        .id;
    let llm_card = storage
        .create_character(&NewCharacter { name: "阿烬".into(), ..Default::default() })
        .unwrap()
        .id;
    (storage, dir, user_card, llm_card)
}

/// 显式开局：向导指定的日历 / 锚 / 场景字段逐一落库——日历直接落存储（snake_case
/// 存储 JSON）、锚行 idx=0、date_label 经 date_label 派生、present = 全部实例 id。
#[test]
fn opening_seeds_explicit_calendar_and_anchor_scene() {
    let (storage, dir, user_card, llm_card) = char_fixture("opening_explicit");
    let preset = fiction_time::presets::fantasy();
    let session = storage
        .create_session(&NewSession {
            roster: roster(user_card, llm_card),
            title: String::new(),
            opening: Some(OpeningSeed {
                calendar: Some(preset.clone()),
                fic_day: Some(45),
                fic_part: Some("夜".into()),
                location: Some("旧都 · 灯市".into()),
                time_note: Some("灯节点亮的那一刻".into()),
            }),
        
            default_render_style: "type".to_string(),
        })
        .unwrap();

    // 日历显式指定直接落库（JSON 为 Rust 序列化产物）。
    let stored = session.calendar_config.as_deref().unwrap();
    assert_eq!(fiction_time::parse(Some(stored)), preset, "显式日历原样落库");
    assert!(stored.contains("days_per_month"), "存储 JSON 为 snake_case：{stored}");

    let scene = storage.latest_scene(session.id).unwrap().unwrap();
    assert_eq!(scene.idx, 0, "开场锚 = 首场景行");
    assert_eq!(scene.fic_day, Some(45));
    assert_eq!(scene.fic_part.as_deref(), Some("夜"));
    assert_eq!(
        scene.date_label.as_deref(),
        Some("白蜡月·潮汐日·夜（灯节）"),
        "date_label 与结算共用 date_label 派生（日名按年内日序取模）"
    );
    assert_eq!(scene.location.as_deref(), Some("旧都 · 灯市"));
    assert_eq!(scene.time_note.as_deref(), Some("灯节点亮的那一刻"));
    assert_eq!(scene.summary, None, "开场行无摘要");
    // 在场 = 全部阵容实例（roster 输入序 = 实例创建序：用户位在前）。
    assert_eq!(scene.present, vec![1, 2], "在场 = 全部实例 id（迁移 0009 语义）");
    // 实例化本身：用户位在前（is_user DESC 排序），快照值逐一正确。
    let instances = storage.list_instances(session.id).unwrap();
    assert_eq!(instances.len(), 2);
    assert!(instances[0].is_user && !instances[1].is_user, "用户位排在首位");
    assert_eq!(instances[0].name, "苏鸢");
    assert_eq!(instances[1].name, "阿烬");
    assert_eq!(instances[1].character_id, Some(llm_card), "实例记模板溯源");
    drop(storage);
    cleanup(&dir);
}

/// 降级路径（opening = None）也无条件 seed 默认锚行：day=1 / part=夜；日历取
/// 内置默认历（角色卡不持有历法，会话行是唯一归属），date_label 为数字形式
/// （§7-6：从第一拍有账可记）。
#[test]
fn degraded_path_still_seeds_default_anchor() {
    let (storage, dir, user_card, llm_card) = char_fixture("opening_degraded");

    let session = storage
        .create_session(&NewSession {
            roster: roster(user_card, llm_card),
            title: String::new(),
            opening: None,
        
            default_render_style: "type".to_string(),
        })
        .unwrap();
    assert_eq!(
        session.calendar_config, None,
        "降级路径无显式日历 = 内置默认历"
    );
    let scene = storage.latest_scene(session.id).unwrap().unwrap();
    assert_eq!(scene.idx, 0);
    assert_eq!(scene.fic_day, Some(1), "day 缺省 1");
    assert_eq!(scene.fic_part.as_deref(), Some("夜"), "part 缺省「夜」");
    assert_eq!(
        scene.date_label.as_deref(),
        Some("第1日·夜"),
        "date_label 按内置默认历派生（数字形式）"
    );
    assert_eq!(scene.location, None, "降级路径无用户场景字段");
    assert_eq!(scene.time_note, None);
    drop(storage);
    cleanup(&dir);
}

/// 事务原子性：阵容含不存在的卡 → 会话行 / 实例 / 开场锚行都不留痕迹；
/// 错误为逐卡 NotFound（实例化路径的真实语义，不再是无名外键冲突）。
#[test]
fn opening_rolls_back_session_and_scene_together() {
    let (storage, dir, user_card, _llm_card) = char_fixture("opening_rollback");
    let err = storage
        .create_session(&NewSession {
            roster: roster(user_card, 999_999),
            title: String::new(),
            opening: Some(OpeningSeed {
                calendar: Some(fiction_time::presets::modern()),
                fic_day: None,
                fic_part: None,
                location: None,
                time_note: None,
            }),
        
            default_render_style: "type".to_string(),
        })
        .unwrap_err();
    assert!(matches!(err, StorageError::NotFound { .. }), "实际：{err:?}");

    // scenes / sessions / character_instances 表全库无行（会话行未落 → 后续全部回滚）。
    let conn = Connection::open(dir.join("test.db")).unwrap();
    let scenes: i64 = conn
        .query_row("SELECT COUNT(*) FROM scenes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(scenes, 0, "开场锚行随会话行一并回滚");
    let sessions: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(sessions, 0, "会话行回滚");
    let instances: i64 = conn
        .query_row("SELECT COUNT(*) FROM character_instances", [], |r| r.get(0))
        .unwrap();
    assert_eq!(instances, 0, "实例随会话一并回滚");
    drop(storage);
    cleanup(&dir);
}

/// 阵容结构校验（D2 / D3）：零成员、双用户位、纯 LLM 位（零扮演位）、
/// 只有用户位（无 LLM 位）都被拒绝，零落库。
#[test]
fn create_session_rejects_invalid_rosters() {
    let (storage, dir, user_card, llm_card) = char_fixture("roster_invalid");
    let cases: Vec<(&str, Vec<RosterPick>)> = vec![
        ("空阵容", vec![]),
        ("双用户位", roster(user_card, llm_card)),
        (
            "纯 LLM 位",
            vec![
                RosterPick { character_id: user_card, is_user: false },
                RosterPick { character_id: llm_card, is_user: false },
            ],
        ),
        ("只有用户位", vec![RosterPick { character_id: user_card, is_user: true }]),
    ];
    // 「双用户位」用两张不同的卡各标 is_user 构造真正的双扮演位。
    let mut double_user = roster(user_card, llm_card);
    double_user[1].is_user = true;
    let cases: Vec<(&str, Vec<RosterPick>)> = cases
        .into_iter()
        .map(|(name, picks)| if name == "双用户位" { (name, double_user.clone()) } else { (name, picks) })
        .collect();
    for (name, picks) in cases {
        let err = storage
            .create_session(&NewSession { roster: picks, title: String::new(), opening: None,
            default_render_style: "type".to_string(),
        })
            .unwrap_err();
        assert!(matches!(err, StorageError::Conflict(_)), "{name} 应被拒绝：{err:?}");
    }
    assert!(storage.list_sessions().unwrap().is_empty(), "全部拒绝：零落库");
    drop(storage);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 建会话阵容实例化验收（方案 §6 验收总纲 1）：1 用户位 + 2 LLM 位 → 3 实例，
/// is_user 恰一、快照值与卡一致、present 写全部实例 id。
#[test]
fn create_session_instantiates_full_roster() {
    let (storage, dir, user_card, llm_card) = char_fixture("roster_full");
    let second = storage
        .create_character(&NewCharacter {
            name: "路人".into(),
            persona: "恰好路过".into(),
            ..Default::default()
        })
        .unwrap()
        .id;
    let session = storage
        .create_session(&NewSession {
            roster: vec![
                RosterPick { character_id: user_card, is_user: true },
                RosterPick { character_id: llm_card, is_user: false },
                RosterPick { character_id: second, is_user: false },
            ],
            title: String::new(),
            opening: None,
        
            default_render_style: "type".to_string(),
        })
        .unwrap();

    let instances = storage.list_instances(session.id).unwrap();
    assert_eq!(instances.len(), 3, "三卡三实例");
    assert_eq!(
        instances.iter().filter(|i| i.is_user).count(),
        1,
        "is_user 恰好一（D2）"
    );
    // 用户位在前（is_user DESC），LLM 位按创建序（id ASC）。
    assert!(instances[0].is_user);
    assert_eq!(instances[0].name, "苏鸢");
    assert_eq!(instances[0].character_id, Some(user_card));
    assert_eq!(instances[1].name, "阿烬");
    assert_eq!(instances[2].name, "路人");
    assert_eq!(instances[2].persona, "恰好路过", "persona 随卡快照");
    // 锚行 present = 全部实例 id。
    let scene = storage.latest_scene(session.id).unwrap().unwrap();
    let ids: Vec<i64> = instances.iter().map(|i| i.id).collect();
    assert_eq!(scene.present, ids, "开场锚行在场名单 = 全部实例");
    drop(storage);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn session_crud_and_title_update() {
    let (storage, dir) = temp_storage("sess_crud");
    let id = make_session(&storage, "");

    assert_eq!(storage.get_session(id).unwrap().title, "");

    storage.update_session_title(id, "第一夜").unwrap();
    assert_eq!(storage.get_session(id).unwrap().title, "第一夜");

    // 软删过滤 + NotFound + 还原
    storage.soft_delete_session(id).unwrap();
    assert!(storage.list_sessions().unwrap().is_empty());
    assert!(matches!(
        storage.get_session(id),
        Err(StorageError::NotFound { .. })
    ));
    storage.restore_session(id).unwrap();
    assert_eq!(storage.list_sessions().unwrap().len(), 1);
    drop(storage);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn sessions_listed_by_updated_at_desc() {
    let (storage, dir) = temp_storage("sess_order");
    let s1 = make_session(&storage, "一");
    sleep(Duration::from_millis(4));
    let s2 = make_session(&storage, "二");
    sleep(Duration::from_millis(4));
    let s3 = make_session(&storage, "三");

    let ids: Vec<i64> = storage
        .list_sessions()
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .collect();
    assert_eq!(ids, vec![s3, s2, s1], "默认按 updated_at 倒序（FR-007）");

    // 触碰最旧的 s1 → 跳到最前
    sleep(Duration::from_millis(4));
    storage.touch_session(s1).unwrap();
    let ids: Vec<i64> = storage
        .list_sessions()
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .collect();
    assert_eq!(ids, vec![s1, s3, s2]);

    // 新消息刷新 updated_at：往 s2 插一条后 s2 应排最前
    sleep(Duration::from_millis(4));
    let _ = storage
        .insert_message(&crate::domain::models::NewMessage::new(
            s2,
            MessageRole::User,
            "你好",
        ))
        .unwrap();
    let ids: Vec<i64> = storage
        .list_sessions()
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .collect();
    assert_eq!(ids, vec![s2, s1, s3]);
    drop(storage);
    let _ = std::fs::remove_dir_all(&dir);
}
