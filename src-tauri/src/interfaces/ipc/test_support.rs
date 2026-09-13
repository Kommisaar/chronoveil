//! IPC 命令测试共享夹具：临时主目录与示例角色卡。
//!
//! 各命令域的 `#[cfg(test)]` 测试共用（原先内聚在单文件 ipc.rs 的 tests 模块里，
//! 拆分后抽到此处避免跨域复制）；绝不写真实 home（ADR-012）。

use std::sync::atomic::{AtomicU32, Ordering};

use crate::domain::models;
use crate::domain::ports::StoragePort;
use crate::interfaces::ipc::character_inputs::CharacterInput;
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

/// 由基准负载派生更新入参（create / update 共用同一负载形态，整卡覆盖）。
pub(super) fn upd_input(name: &str, base: &CharacterInput) -> CharacterInput {
    CharacterInput {
        name: name.into(),
        avatar: base.avatar.clone(),
        persona: base.persona.clone(),
        gender: base.gender.clone(),
        age: base.age.clone(),
        render_style: base.render_style.clone(),
        model_config: base.model_config.clone(),
        accent_color: base.accent_color.clone(),
        voice_config: base.voice_config.clone(),
    }
}
