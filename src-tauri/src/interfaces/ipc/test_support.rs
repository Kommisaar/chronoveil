//! IPC 命令测试共享夹具：临时主目录与示例角色卡。
//!
//! 各命令域的 `#[cfg(test)]` 测试共用（原先内聚在单文件 ipc.rs 的 tests 模块里，
//! 拆分后抽到此处避免跨域复制）；绝不写真实 home（ADR-012）。

use std::sync::atomic::{AtomicU32, Ordering};

use crate::domain::models;
use crate::domain::ports::StoragePort;
use crate::interfaces::ipc::character_inputs::{CharacterInput, UpdateCharacterInput};
use crate::interfaces::ipc::sessions::CalendarConfigDto;
use crate::state::AppState;

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// 每个测试独享的临时主目录；绝不写真实 home（ADR-012）。
pub(super) fn temp_state(tag: &str) -> (AppState, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "chronoveil_ipc_test_{}_{}_{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed),
        tag
    ));
    let _ = std::fs::remove_dir_all(&dir);
    (AppState::init_with_home(Some(dir.clone())).unwrap(), dir)
}

pub(super) fn sample_character(app: &AppState, name: &str) -> models::Character {
    app.storage
        .create_character(&models::NewCharacter {
            name: name.into(),
            ..Default::default()
        })
        .unwrap()
}

/// 历法样例 DTO（含节日，覆盖月换算 / 日名取模 / 时段缀 / 节日命中全部分支）。
pub(super) fn sample_calendar_dto() -> CalendarConfigDto {
    CalendarConfigDto {
        name: Some("星槎历".into()),
        months: vec!["潮生月".into(), "风信月".into()],
        days_per_month: 12,
        day_names: vec!["潮日".into(), "汐日".into(), "星日".into()],
        festivals: Some(std::collections::BTreeMap::from([(2, "归潮祭".to_string())])),
    }
}

/// 全空槽位的 create 负载（可空字段恒 None，历法不入 create 入参）。
pub(super) fn sample_bare_input() -> CharacterInput {
    CharacterInput {
        name: String::new(),
        avatar: None,
        persona: String::new(),
        gender: None,
        age: None,
        render_style: "typewriter".into(),
        model_config: None,
        accent_color: None,
        voice_config: None,
    }
}

/// 由 create 负载派生更新入参（历法缺省 None = 清除；历法用例按需覆写 calendar_config）。
pub(super) fn upd_input(name: &str, base: &CharacterInput) -> UpdateCharacterInput {
    UpdateCharacterInput {
        name: name.into(),
        avatar: base.avatar.clone(),
        persona: base.persona.clone(),
        gender: base.gender.clone(),
        age: base.age.clone(),
        render_style: base.render_style.clone(),
        model_config: base.model_config.clone(),
        accent_color: base.accent_color.clone(),
        voice_config: base.voice_config.clone(),
        calendar_config: None,
    }
}
