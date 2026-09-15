//! 世界域 IPC 冒烟：CRUD 往返、历法 wire↔存储 JSON 换算、入口校验、软删。

use super::*;
use crate::interfaces::ipc::test_support::temp_state;

/// wire 历法夹具（满足 validate：天数 > 0 且月名非空）。
fn calendar_dto() -> CalendarConfigDto {
    CalendarConfigDto {
        name: Some("七曜和历".to_string()),
        months: vec!["日曜".to_string(), "月曜".to_string()],
        days_per_month: 30,
        day_names: vec![],
        festivals: None,
    }
}

fn input(name: &str) -> WorldInput {
    WorldInput {
        name: name.to_string(),
        worldbook: String::new(),
        calendar: None,
    }
}

#[test]
fn world_crud_wire_roundtrip() {
    let (app, dir) = temp_state("worlds_ipc");
    let created = create_world_impl(
        &app,
        WorldInput {
            worldbook: "永夜的海上城市。".to_string(),
            calendar: Some(calendar_dto()),
            ..input("末班航船")
        },
    )
    .unwrap();
    assert_eq!(created.name, "末班航船");
    // wire 历法往返无损（wire → 存储 snake_case JSON → wire）
    let back = list_worlds_impl(&app).unwrap();
    assert_eq!(back.len(), 1);
    assert_eq!(back[0].calendar, Some(calendar_dto()));
    assert_eq!(back[0].worldbook, "永夜的海上城市。");

    // 更新：历法清 None（回落默认历）+ 改名
    update_world_impl(&app, created.id, input("改名世界")).unwrap();
    let back = list_worlds_impl(&app).unwrap();
    assert_eq!(back[0].name, "改名世界");
    assert_eq!(back[0].calendar, None);

    // 软删 → 列表清空
    delete_world_impl(&app, created.id).unwrap();
    assert!(list_worlds_impl(&app).unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn world_input_validation() {
    let (app, dir) = temp_state("worlds_ipc_valid");
    // 空白名称拒绝（同 CharacterInput）
    let err = create_world_impl(&app, input("   ")).unwrap_err();
    assert!(matches!(err, IpcError::Conflict { .. }));
    // 显式历法不满足命名皮肤可用性（月名 / 日名全空）拒绝
    let err = create_world_impl(
        &app,
        WorldInput {
            calendar: Some(CalendarConfigDto {
                name: None,
                months: vec![],
                days_per_month: 30,
                day_names: vec![],
                festivals: None,
            }),
            ..input("坏历法")
        },
    )
    .unwrap_err();
    assert!(matches!(err, IpcError::Conflict { .. }));
    assert!(list_worlds_impl(&app).unwrap().is_empty(), "校验失败零落库");
    let _ = std::fs::remove_dir_all(&dir);
}
