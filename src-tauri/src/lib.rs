//! ChronoVeil — Tauri 2 桌面应用。
//! 四层结构（ADR-010）：interfaces → services → domain ← infra；state 为组合根。
//! 设计基线在 relay-harbor 项目，改码前查对应条目（AGENTS.md）。

mod domain;
mod infra;
mod interfaces;
mod services;
mod state;

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}
