//! Provider 的 API 兼容协议标识（2026-09-14 三协议分派）：一套 Provider 服务以
//! 哪种 API 形态暴露 chat 能力。持久化（config.json 的 providers[].api）与
//! IPC wire（ProviderDto.api，经 bindings 导出前端）同源引用本类型。
//!
//! wire/存储值为 snake_case（`openai` / `anthropic` / `openai_responses`）。
//! 缺省 [`ProviderApi::OpenAi`]：旧 config.json 无此键零迁移兼容（应用未发布、
//! 无存量数据负担，AGENTS.md）；未知值 serde 反序列化失败 → `ConfigError::Parse`
//! 快速失败（ADR-012 坏文件语义，不静默回落）。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ProviderApi {
    /// OpenAI Chat Completions 兼容（`/chat/completions`，Bearer）。现状默认路径，
    /// 行为零变化。
    // wire 值显式钉死 "openai"（snake_case 派生会把 OpenAi 变成 "open_ai"，
    // 与任务约定的 wire 值 "openai" 不符，故逐变体显式 rename）。
    #[serde(rename = "openai")]
    #[default]
    OpenAi,
    /// Anthropic Messages API（`/v1/messages`，x-api-key + anthropic-version）。
    Anthropic,
    /// OpenAI Responses API（`/responses`）。
    #[serde(rename = "openai_responses")]
    OpenAiResponses,
}
