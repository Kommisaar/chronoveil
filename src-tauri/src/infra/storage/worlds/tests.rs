//! worlds CRUD 回归（2026-09-15 世界卡定稿）：插入回读、整卡覆盖、软删 / 还原。

use crate::domain::models::{NewWorld, UpdateWorld};
use crate::domain::ports::StoragePort;
use crate::infra::storage::test_support::{cleanup, temp_storage};

fn sample(name: &str) -> NewWorld {
    NewWorld {
        name: name.to_string(),
        worldbook: String::new(),
        calendar_config: None,
    }
}

#[test]
fn world_crud_roundtrip() {
    let (store, dir) = temp_storage("world_crud");
    let created = store.create_world(&sample("末班航船")).unwrap();
    assert_eq!(created.name, "末班航船");
    assert_eq!(created.worldbook, "", "世界观允许空白（装配省略）");
    assert_eq!(created.calendar_config, None, "历法预设缺省 = 默认历");

    // 整卡覆盖：worldbook + 历法 JSON（存储形态 = Rust serde 产出，透传不解析）
    let calendar_json = r#"{"name":"七曜和历","months":["日曜","月曜"],"days_per_month":30,"day_names":[],"festivals":[]}"#;
    store
        .update_world(
            created.id,
            &UpdateWorld {
                name: "末班航船（修订）".to_string(),
                worldbook: "永夜的海上城市。".to_string(),
                calendar_config: Some(calendar_json.to_string()),
            },
        )
        .unwrap();
    let reloaded = store.get_world(created.id).unwrap();
    assert_eq!(reloaded.name, "末班航船（修订）");
    assert_eq!(reloaded.worldbook, "永夜的海上城市。");
    assert_eq!(reloaded.calendar_config.as_deref(), Some(calendar_json));

    // 软删 → 列表 / 单查不可见；还原恢复
    store.soft_delete_world(created.id).unwrap();
    assert!(store.list_worlds().unwrap().is_empty());
    assert!(store.get_world(created.id).is_err());
    store.restore_world(created.id).unwrap();
    assert_eq!(store.list_worlds().unwrap().len(), 1);
    cleanup(&dir);
}

#[test]
fn world_update_missing_rejected() {
    let (store, dir) = temp_storage("world_update_missing");
    let err = store
        .update_world(
            999,
            &UpdateWorld {
                name: "无".to_string(),
                worldbook: String::new(),
                calendar_config: None,
            },
        )
        .unwrap_err();
    assert!(matches!(err, crate::domain::error::StorageError::NotFound { .. }));
    cleanup(&dir);
}
