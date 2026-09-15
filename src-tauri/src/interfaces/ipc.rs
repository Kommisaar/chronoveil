//! Tauri 命令层（ADR-010 interfaces 层；TASK-005）。
//!
//! 命令面（验收 4）：会话列表/创建/软删、消息列表、发送消息、取消生成、重新生成最后一条、
//! 场景 / 人物状态列表（叙事账本读路径）、人物状态手动清除（FR-012，Task-09）、
//! 角色 CRUD（含 avatar）、角色卡单卡导出/导入（Task-04，原生文件对话框）、config.json 读取/保存。
//!
//! wire 契约（类型同源，ADR-010）：
//! - DTO 统一 `#[serde(rename_all = "camelCase")]`，与 `src/api/types.ts` 一一对应；
//!   TS 侧类型经 tauri-specta 同源生成于 `src/api/generated/bindings.ts`（`builder()` +
//!   `export_ts_bindings` 测试负责再生成，勿手改）；
//! - 错误统一 [`IpcError`]：`Serialize` + `std::error::Error`，前端拿到可判别的结构化错误；
//! - 新增命令必须同步登记 `config/ipc-command-whitelist.json`（ADR-010 守卫）。
//!
//! 生成编排边界（TASK-006 已接线）：`send_message` / `regenerate_last` 校验入参、落库用户条
//! （重新生成为软删旧条 + 新条从零演出，FR-008）、装配生成任务交异步运行时 spawn；
//! 生成闭环本体（prompt 装配 → LLM 流式 → 终态落库）在 services/generation。
//! 事件经 `AppState::sink`（setup 注入的 `TauriEventSink`）广播；`cancel_generation`
//! 经生成注册表取消，无活跃生成时为幂等 no-op（返回 false）。
//!
//! 本模块是命令域子模块的注册壳（500 行规范拆分，纯搬移）：按命令域分驻
//! `ipc/` 子模块——sessions（会话/开局包/会话日历）、fork（时间线分叉，Task-44
//! 契约冻结 stub）、messages（消息）、scenes（场景与人物状态）、llm_calls（调用轨迹）、
//! generation（生成闭环）、characters（角色 CRUD）、character_cards（卡文件导出/导入）、
//! config（配置）、error（统一错误）、test_support（测试夹具）。全部 pub 项经下方
//! `pub use` 原路径再导出，`crate::interfaces::ipc::*` 对外 API 与拆分前逐项一致。

mod character_cards;
mod character_inputs;
mod characters;
mod config;
mod error;
mod fork;
mod generation;
mod llm_calls;
mod messages;
mod scenes;
mod sessions;
mod worlds;
#[cfg(test)]
mod test_support;

// ---------------------------------------------------------------------------
// 对外 API 再导出：pub 项路径保持 `crate::interfaces::ipc::*` 不变（拆分前逐项对照）
// ---------------------------------------------------------------------------

pub use error::IpcError;

pub use sessions::{
    create_session, delete_session, list_sessions, CalendarConfigDto, RosterPickInput,
    SessionInstanceDto, SessionOpeningInput, SessionSummary,
};

// 分叉域（时间线分叉，Task-44 契约冻结 stub；独立成文件因 sessions.rs 500 行纪律）
pub use fork::fork_session;

pub use messages::{list_messages, ChatMessage, MessageRole};

pub use scenes::{
    clear_character_state, list_character_states, list_scenes, CharacterStateDto,
    CharacterStateScope, SceneDto,
};

pub use llm_calls::{
    list_llm_calls, DEFAULT_LLM_CALL_LIST_LIMIT, LlmCallDto, LlmCallKindDto, LlmCallStatusDto,
};

pub use generation::{cancel_generation, regenerate_last, send_message};
// API 对位再导出：拆分前 GenerationSpawner 即为 ipc 模块的 pub(crate) 项（无 crate 内
// 消费方，纯保路径），故此再导出必然"未使用"，需最小范围抑制 unused_imports。
#[allow(unused_imports)]
pub(crate) use generation::GenerationSpawner;

pub use characters::{
    create_character, delete_character, list_characters, update_character, CharacterSummary,
};

pub use worlds::{create_world, delete_world, list_worlds, update_world, WorldInput, WorldSummary};

pub use character_inputs::CharacterInput;

pub use character_cards::{export_character, import_character};

pub use config::{get_config, save_config, ConfigDto, ProviderDto};

/// 命令注册：collect_commands（Rust 侧）与 config/ipc-command-whitelist.json（登记表）
/// 双处登记，一致性由 scripts/check-ipc-whitelist.mjs 守卫（ADR-010）。
///
/// 命令按域分驻子模块后，此处必须写模块限定路径：`#[tauri::command]` /
/// `#[specta::specta]` 展开出的辅助 macro_rules（`__tauri_command_name_*` /
/// `__specta__fn__*`）留在定义模块内，不随函数的 `pub use` 再导出走；
/// 限定路径使宏按定义模块解析，命令 wire 名只取函数名，与拆分前逐字一致。
pub fn builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            sessions::list_sessions,
            sessions::create_session,
            sessions::delete_session,
            fork::fork_session,
            messages::list_messages,
            scenes::list_scenes,
            scenes::list_character_states,
            scenes::clear_character_state,
            llm_calls::list_llm_calls,
            generation::send_message,
            generation::cancel_generation,
            generation::regenerate_last,
            characters::list_characters,
            characters::create_character,
            characters::update_character,
            characters::delete_character,
            worlds::list_worlds,
            worlds::create_world,
            worlds::update_world,
            worlds::delete_world,
            character_cards::export_character,
            character_cards::import_character,
            config::get_config,
            config::save_config,
        ])
        .events(tauri_specta::collect_events![
            crate::interfaces::events::StreamEvent,
        ])
        // Result 模式：生成的 bindings 返回 Result<T, IpcError>（结构化错误可判别），
        // 由 src/api/commands.ts 统一解包成 ApiError。
        .error_handling(tauri_specta::ErrorHandlingMode::Result)
}

#[cfg(test)]
mod tests {
    use super::builder;

    // ---- bindings 生成（类型同源，ADR-010）----

    #[test]
    fn export_ts_bindings() {
        // cargo test 时再生成 src/api/generated/bindings.ts：与 Rust 命令/事件面同步，
        // 漂移会在 git diff 中暴露。前端构建只消费该文件，不运行 Rust。
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/api/generated/bindings.ts");
        builder()
            .export(
                specta_typescript::Typescript::new()
                    .bigint(specta_typescript::BigIntExportBehavior::Number)
                    .header("// @ts-nocheck\n"),
                &out,
            )
            .expect("导出 TS bindings 失败");
        let content = std::fs::read_to_string(&out).unwrap();
        for cmd in [
            "listSessions", "createSession", "deleteSession", "forkSession",
            "listMessages",
            "listScenes", "listCharacterStates", "clearCharacterState",
            "sendMessage", "cancelGeneration", "regenerateLast",
            "listCharacters", "createCharacter", "updateCharacter", "deleteCharacter",
            "exportCharacter", "importCharacter",
            "getConfig", "saveConfig",
        ] {
            assert!(content.contains(cmd), "bindings 缺少命令 {cmd}");
        }
        assert!(content.contains("streamEvent"), "bindings 缺少 stream-event 事件");
        // INT-001 负载字段在生成的类型里逐一可见。
        for field in ["session_id", "message_id", "think_ms", "interrupted", "reset"] {
            assert!(content.contains(field), "bindings 缺少事件负载字段 {field}");
        }
    }
}
