//! ChronoVeil — Tauri 2 桌面应用。
//! 四层结构（ADR-010）：interfaces → services → domain ← infra；state 为组合根。
//! 设计基线在 relay-harbor 项目，改码前查对应条目（AGENTS.md）。

mod domain;
mod infra;
mod interfaces;
mod services;
mod state;

use state::AppState;

pub fn run() {
    // 组合根装配：~/.chronoveil/ 主目录（ADR-012）+ chronoveil.db 迁移打开（CMP-003）。
    // 启动期失败属致命（个人应用，无库即无一切），直接带错误信息退出。
    let app_state = AppState::init().expect("初始化应用主目录与数据库失败");

    tauri::Builder::default()
        .manage(app_state)
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}
