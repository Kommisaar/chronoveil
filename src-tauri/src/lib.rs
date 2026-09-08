//! ChronoVeil — Tauri 2 桌面应用。
//! 四层结构（ADR-010）：interfaces → services → domain ← infra；state 为组合根。
//! 设计基线在 relay-harbor 项目，改码前查对应条目（AGENTS.md）。

// pub 可见性：lib 需被集成测试（tests/）与 tauri::generate_context 以公开 API 消费。
pub mod domain;
pub mod infra;
pub mod interfaces;
pub mod services;
pub mod state;

use state::AppState;

pub fn run() {
    // 组合根装配：~/.chronoveil/ 主目录（ADR-012）+ chronoveil.db 迁移打开（CMP-003）。
    // 启动期失败属致命（个人应用，无库即无一切），直接带错误信息退出。
    let app_state = AppState::init().expect("初始化应用主目录与数据库失败");

    // 命令与事件统一经 tauri-specta 注册（ADR-010 类型同源）：命令面见 interfaces::ipc，
    // 事件面见 interfaces::events；新增命令须同步登记 config/ipc-command-whitelist.json。
    let specta_builder = interfaces::ipc::builder();

    // 调试构建时再生成 src/api/generated/bindings.ts（cargo test 的 export_ts_bindings
    // 测试也会生成）；文件入库，前端构建不依赖 Rust 工具链。
    #[cfg(debug_assertions)]
    specta_builder
        .export(
            specta_typescript::Typescript::new()
                .bigint(specta_typescript::BigIntExportBehavior::Number)
                .header("// @ts-nocheck\n"),
            "../src/api/generated/bindings.ts",
        )
        .expect("导出 TS bindings 失败");

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            // 挂载事件注册表（INT-001：StreamEvent 经 TauriEventSink 广播）。
            specta_builder.mount_events(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}
