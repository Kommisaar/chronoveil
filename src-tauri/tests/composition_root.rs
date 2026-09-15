//! 组合根冒烟集成测试（TASK-005）：以公开 API 走通「装配 → 存储 → 配置」全链路，
//! 与单元测试互补；同时使包内存在 tests/ 目标（build.rs 的 rustc-link-arg-tests
//! 才会被 cargo 接受，测试二进制因此带上 comctl32 v6 manifest）。

use chronoveil_lib::domain::models::{NewCharacter, NewMessage, NewSession, NewWorld, RosterPick};
use chronoveil_lib::domain::ports::StoragePort;
use chronoveil_lib::state::AppState;

use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn temp_home(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "chronoveil_integration_test_{}_{}_{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed),
        tag
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// 装配 → 建角色 → 建会话（阵容实例化）→ 插消息 → 读回，全链路落在注入的临时主目录内。
#[test]
fn composition_root_end_to_end() {
    let home = temp_home("e2e");
    let app = AppState::init_with_home(Some(home.clone())).unwrap();

    let user_card = app
        .storage
        .create_character(&NewCharacter {
            name: "旅人".into(),
            ..Default::default()
        })
        .unwrap();
    let llm_card = app
        .storage
        .create_character(&NewCharacter {
            name: "苏鸢".into(),
            ..Default::default()
        })
        .unwrap();
    let world = app
        .storage
        .create_world(&NewWorld {
            name: "雨夜港都".into(),
            worldbook: String::new(),
            calendar_config: None,
        })
        .unwrap();
    let session = app
        .storage
        .create_session(&NewSession {
            world_id: world.id,
            default_render_style: "type".to_string(),
            roster: vec![
                RosterPick { character_id: user_card.id, is_user: true },
                RosterPick { character_id: llm_card.id, is_user: false },
            ],
            title: "雨夜来电".into(),
            opening: None,
        })
        .unwrap();
    // 建会话阵容实例化（多角色换挂）：两卡两实例，用户位恰一；世界实例恰一。
    let instances = app.storage.list_instances(session.id).unwrap();
    assert_eq!(instances.len(), 2, "阵容逐卡实例化");
    assert_eq!(instances.iter().filter(|i| i.is_user).count(), 1, "is_user 恰一（D2）");
    let world_instance = app
        .storage
        .world_instance_by_session(session.id)
        .unwrap()
        .expect("会话恰一世界实例");
    assert_eq!(world_instance.world_id, world.id, "世界实例记模板溯源");
    let message = app
        .storage
        .insert_message(&NewMessage::new(session.id, chronoveil_lib::domain::models::MessageRole::User, "是我。"))
        .unwrap();

    let listed = app.storage.list_messages(session.id).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, message.id);
    assert_eq!(listed[0].content, "是我。");
    assert!(app.storage.list_sessions().unwrap().iter().any(|s| s.id == session.id));

    // 配置读取（无文件 → 全默认，FR-009）。
    let config = app.config.load().unwrap();
    assert_eq!(config.rhythm_ms_per_char, 45);

    drop(app);
    let _ = std::fs::remove_dir_all(&home);
}
