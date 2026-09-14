//! 协议分派面（2026-09-14 三协议）：把「请求构造（endpoint / 认证头 / payload，
//! 含 tools 变体）+ 响应解析（SSE `data:` 帧 → 统一 [`SseItem`] 语义；非流式 JSON →
//! content / reasoning / usage / tool_calls）」抽象为 [`ApiProtocol`]，三种 API 兼容
//! 形态各自实现（wire_openai / wire_anthropic / wire_responses），`LlmClient` 与
//! gateway 按 `LlmConfig.api` 经 [`of`] 分派。本文件只做分派面、统一语义类型与
//! 跨协议复用的小工具，不含任何具体协议逻辑。

use reqwest::RequestBuilder;

use super::contract::{ChatMessage, ChatRole, LlmConfig, LlmError, ToolSpec};
use super::provider_api::ProviderApi;
use super::sse::SseItem;
use super::trace::CallObservation;

// ---------------------------------------------------------------------------
// 统一分派面
// ---------------------------------------------------------------------------

/// 三协议的统一分派面。实现体全部无状态（流内累积状态见 [`StreamFrameParser`]），
/// 以单元结构体静态实例 + trait 对象分派（协议集合封闭，无需 dyn 构造）。
pub(super) trait ApiProtocol: Sync {
    /// chat endpoint；`base_url` 已由调用方去除尾部 `/`。
    fn endpoint(&self, base_url: &str) -> String;

    /// 认证与协议必需头（OpenAI/Responses：Bearer；Anthropic：x-api-key +
    /// anthropic-version）。密钥为空时不附加认证头（本地免鉴权推理服务兼容，
    /// 与既有 OpenAI 路径同法）。
    fn apply_auth(&self, rb: RequestBuilder, api_key: &str) -> RequestBuilder;

    /// chat 请求体（`stream` 指示流式；`tools` / `tool_choice` 仅提供时随附，
    /// 空工具切片视同未提供）。构造失败（如工具回路历史里的 arguments 非法 JSON）
    /// 以 `LlmError::Protocol` 提前报错——同一输入重发必然复现，不可重试。
    fn payload(
        &self,
        config: &LlmConfig,
        messages: &[ChatMessage],
        stream: bool,
        tools: Option<&[ToolSpec]>,
        tool_choice: Option<&str>,
    ) -> Result<serde_json::Value, LlmError>;

    /// 每次流式尝试新建一个帧解析器（有累积状态的协议在此持状态）。
    fn new_stream_parser(&self) -> Box<dyn StreamFrameParser>;

    /// 非流式结构化调用（complete_json）的响应解析：从协议 wire 形态提取正文 /
    /// reasoning / usage 并填充观测，返回正文（缺失即协议错误，消息由各协议自定）。
    fn parse_content_reply(
        &self,
        payload: &serde_json::Value,
        obs: &mut CallObservation,
    ) -> Result<String, LlmError>;

    /// 非流式工具回路（complete_with_tools）的响应解析：tool_calls / 正文分支 +
    /// 观测填充。观测字段（usage / 正文）在解析失败时也尽量保留（与既有行为一致：
    /// 失败轨迹同样记 usage 与已取得的正文）。
    fn parse_tool_turn(
        &self,
        payload: &serde_json::Value,
        obs: &mut CallObservation,
    ) -> Result<super::contract::ToolLoopTurn, LlmError>;

    /// 流在终态帧之前正常 EOF 的断流错误（可重试）。哨兵名随协议不同，错误文本
    /// 各自表述（OpenAI 保持既有文案零变化）。
    fn interrupted_error(&self) -> LlmError;
}

/// 单次流式尝试的帧解析器：一条 `data:` 负载 → 统一条目。协议终态帧
/// （OpenAI `[DONE]` / Anthropic `message_stop` / Responses `response.completed`）
/// 统一翻译为 [`SseItem::Done`]，usage 翻译为 [`SseItem::Usage`]（先于 Done 产出，
/// 客户端见 Done 即收流，迟到的 Usage 会被丢弃）。Send 上界：解析器随流式尝试
/// 存活跨 await 点，chat_stream 的 future 须保持 Send。
pub(super) trait StreamFrameParser: Send {
    fn parse(&mut self, data: &str) -> Result<Vec<SseItem>, LlmError>;
}

/// 按 `LlmConfig.api` 取协议实现（分派唯一入口）。
pub(super) fn of(api: ProviderApi) -> &'static dyn ApiProtocol {
    match api {
        ProviderApi::OpenAi => &super::wire_openai::OpenAiCompat,
        ProviderApi::Anthropic => &super::wire_anthropic::AnthropicMessages,
        ProviderApi::OpenAiResponses => &super::wire_responses::OpenAiResponses,
    }
}

// ---------------------------------------------------------------------------
// 跨协议复用的小工具
// ---------------------------------------------------------------------------

/// System 消息文本按序拼接（`\n\n` 分隔）：Anthropic 顶层 `system` 参数与
/// Responses `instructions` 参数共用的提升语义（两协议均无 messages 内 system 角色）。
/// 无 System 消息 → None（调用方不发该键）。
pub(super) fn join_system_text(messages: &[ChatMessage]) -> Option<String> {
    let parts: Vec<&str> = messages
        .iter()
        .filter(|m| m.role == ChatRole::System)
        .map(|m| m.content.as_str())
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}
