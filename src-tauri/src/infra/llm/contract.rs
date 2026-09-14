//! LLM 网关的对外契约面：配置（RetryPolicy / LlmConfig）、错误（LlmError）、
//! 事件（LlmEvent / ActivityPhase / EventSink）、取消（CancelSignal / CancelHandle）
//! 与消息 / 工具入参类型（ChatMessage / ToolSpec / ToolLoopTurn）及其 wire 形态。
//! 纯搬移自原 llm.rs 单文件；模块级职责与事件语义见 llm.rs 壳文档。

use serde::Serialize;
use tokio::sync::watch;

use super::provider_api::ProviderApi;

// ---------------------------------------------------------------------------
// 配置（INT-002：base_url + api_key + model；Character 级覆写由上层合成）
// ---------------------------------------------------------------------------

/// 重试策略：消息级重发（验收 5）。总尝试次数 = 1 + max_retries。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// 首次尝试之后的最大重发次数。
    pub max_retries: u32,
    /// 首次重发前的退避毫秒数；其后按 `backoff_multiplier` 指数增长，封顶 `max_backoff_ms`。
    pub initial_backoff_ms: u64,
    pub backoff_multiplier: u32,
    pub max_backoff_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self { max_retries: 2, initial_backoff_ms: 500, backoff_multiplier: 2, max_backoff_ms: 8_000 }
    }
}

/// Provider 连接配置（INT-002；2026-09-14 起 API 兼容协议随 Provider 走）。
/// 不再派生 Eq：temperature 为 f64（f64 无 Eq）；等值断言走 PartialEq。
#[derive(Debug, Clone, PartialEq)]
pub struct LlmConfig {
    /// 服务根地址（如 `https://api.deepseek.com`），结尾 `/` 会被容忍。
    pub base_url: String,
    /// 认证密钥；为空时不附加认证头（本地免鉴权推理服务兼容）。
    pub api_key: String,
    pub model: String,
    /// API 兼容协议（三选一）：请求构造与响应解析按此分派（见 protocol.rs）。
    /// 缺省 OpenAi（现状默认路径，行为零变化）。
    pub api: ProviderApi,
    /// 采样温度（0–2）：随三协议 payload 的 temperature 参数下发。默认值与
    /// 设置侧全局默认同源（infra/config.rs 的 DEFAULT_TEMPERATURE = 0.7；
    /// 本层不反向 import config——config 已依赖本层，互指靠此注释维系同值）。
    pub temperature: f64,
    /// 建连超时（毫秒）。
    pub connect_timeout_ms: u64,
    /// 单次读取空闲超时（毫秒）：超时未到任何字节视为超时（可重试）。
    pub read_timeout_ms: u64,
    pub retry: RetryPolicy,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            api: ProviderApi::OpenAi,
            temperature: 0.7,
            connect_timeout_ms: 10_000,
            read_timeout_ms: 30_000,
            retry: RetryPolicy::default(),
        }
    }
}

// ---------------------------------------------------------------------------
// 错误（验收 8：401 / 429 / 5xx / 超时 各自可判别）
// ---------------------------------------------------------------------------

/// LLM 网关错误：按可重试性与处置方式分型（验收 8：401 / 429 / 5xx / 超时各自可判别）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LlmError {
    /// 客户端配置非法（缺 base_url / model 等）。
    Config(String),
    /// 建连或读取超时。
    Timeout,
    /// 连接失败 / 断流等网络层错误。
    Network(String),
    /// 401：密钥无效。不重试。
    Unauthorized,
    /// 429：限流。可重试。
    RateLimited,
    /// 其余非 2xx 状态；5xx 可重试。
    Status { status: u16, body: String },
    /// 响应不符合 OpenAI 兼容协议。
    Protocol(String),
    /// 结构化调用的 JSON 提取/解析失败（验收 7：失败返回可判断错误）。
    Json(String),
}

impl LlmError {
    /// 是否值得按整条重发：超时 / 网络 / 限流 / 5xx。
    pub fn is_retryable(&self) -> bool {
        match self {
            LlmError::Timeout | LlmError::Network(_) | LlmError::RateLimited => true,
            LlmError::Status { status, .. } => *status >= 500,
            _ => false,
        }
    }
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LlmError::Config(msg) => write!(f, "LLM 配置错误：{msg}"),
            LlmError::Timeout => write!(f, "LLM 请求超时"),
            LlmError::Network(msg) => write!(f, "LLM 网络错误：{msg}"),
            LlmError::Unauthorized => write!(f, "LLM 认证失败（401）：请检查 API Key"),
            LlmError::RateLimited => write!(f, "LLM 触发限流（429）：请稍后重试"),
            LlmError::Status { status, body } => write!(f, "LLM 服务返回状态 {status}：{body}"),
            LlmError::Protocol(msg) => write!(f, "LLM 协议错误：{msg}"),
            LlmError::Json(msg) => write!(f, "LLM JSON 解析失败：{msg}"),
        }
    }
}

impl std::error::Error for LlmError {}

// pub(super)：client.rs（流式）与 gateway.rs（非流式两路）的连接失败 / 状态映射共用。
pub(super) fn map_reqwest_error(e: reqwest::Error) -> LlmError {
    if e.is_timeout() {
        LlmError::Timeout
    } else {
        LlmError::Network(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// 事件契约（FR-001：token / reasoning / done / error，携 session_id + message_id）
// ---------------------------------------------------------------------------

/// 一条生成消息的双标识（会话内定位 + 前端流式气泡归属）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MessageIds {
    pub session_id: i64,
    pub message_id: i64,
}

/// 网关类型化事件。经 `EventSink` 抽象发射，序列化形态供 TASK-005 直通 Tauri 事件通道。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LlmEvent {
    /// 正文增量（INT-001 负载字段 text）。`reset`（重发后首个事件为 true）：清空已累积正文后重新累积。
    Token { session_id: i64, message_id: i64, text: String, reset: bool },
    /// 思考增量（字段型直通 + 内联 think 拆分，FR-003；INT-001 负载字段 text）。`reset` 同上。
    Reasoning { session_id: i64, message_id: i64, text: String, reset: bool },
    /// 终态：正常完成。think_ms 为网关侧 reasoning 墙钟时长（无思考则 None）。
    Done { session_id: i64, message_id: i64, think_ms: Option<u64> },
    /// 终态：失败。reason 为人类可读错误；interrupted 表示已有半条内容产生（ADR-001）。
    Error { session_id: i64, message_id: i64, reason: String, interrupted: bool },
    /// 幕后活动事件（Task-06 记忆探索透出）：探索器（services/explorer.rs）的阶段性
    /// 步骤通知，**即时直通**——不参与终态语义与思考计量，生成编排的终态闸门只扣
    /// token / reasoning / done / error。`detail` 为技术措辞摘要（数据，非 UI 文案，
    /// 前端 i18n 在消费侧做）。
    Activity { session_id: i64, message_id: i64, phase: ActivityPhase, detail: Option<String> },
}

/// 幕后活动事件的阶段（Task-06）：主对话生成前记忆探索的生命周期。wire 形态
/// camelCase（`researchStart` 等），未知值由前端忽略（向前兼容，同 INT-001）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ActivityPhase {
    /// 进入探索（存储读取成功、即将发起研究员 LLM 调用）。
    ResearchStart,
    /// 模型发起的单次工具调用（本地执行前；detail = 工具名 + 参数摘要）。
    ToolCall,
    /// 单次工具结果回填（detail = 结果截断）。
    ToolResult,
    /// 卷宗就绪（detail = 卷宗前若干字）。
    DossierReady,
    /// 快车道：研究员判定无需检索，零工具调用直接放行。
    ResearchSkipped,
}

/// 事件发射抽象：不依赖 tauri（验收 4）。生产实现接 Tauri 通道，测试用收集器。
pub trait EventSink: Send + Sync {
    fn emit(&self, event: LlmEvent);
}

// ---------------------------------------------------------------------------
// 取消（验收 6：立即中断连接与后续事件发射）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct CancelHandle(watch::Receiver<bool>);

/// 取消信号发送端：持有于生成编排方，可 Clone 分发给 UI。
#[derive(Debug, Clone)]
pub struct CancelSignal(watch::Sender<bool>);

impl CancelSignal {
    pub fn cancel(&self) {
        let _ = self.0.send(true);
    }
}

impl CancelHandle {
    pub fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }

    /// 挂起直到取消被触发。发送端先于本端销毁时直接返回（永不取消）。
    pub async fn wait(&self) {
        let mut rx = self.0.clone();
        loop {
            if *rx.borrow_and_update() {
                return;
            }
            if rx.changed().await.is_err() {
                return;
            }
        }
    }
}

/// 建立一对取消通道。
pub fn cancel_channel() -> (CancelSignal, CancelHandle) {
    let (tx, rx) = watch::channel(false);
    (CancelSignal(tx), CancelHandle(rx))
}

// ---------------------------------------------------------------------------
// 消息入参（含 OpenAI 兼容工具调用：Tool 角色 / tool_calls 回传 / 工具定义）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatRole {
    System,
    User,
    Assistant,
    /// 工具执行结果回传（OpenAI 兼容 "tool" 角色，需携带 tool_call_id 回链）。
    Tool,
}

impl ChatRole {
    pub fn as_str(self) -> &'static str {
        match self {
            ChatRole::System => "system",
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
            ChatRole::Tool => "tool",
        }
    }
}

/// assistant 消息携带的一次工具调用（OpenAI 兼容 tool_calls 元素的业务面投影）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    /// 调用标识：后续 tool 消息凭此回链（模型生成，原样透传）。
    pub id: String,
    pub name: String,
    /// 参数 JSON 字符串原样透传：模型侧输出形态即字符串，由调用方按需解析。
    pub arguments: String,
}

/// 工具定义（OpenAI 兼容 tools 数组元素；parameters 为 JSON Schema 形态，原样透传）。
#[derive(Debug, Clone, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
    /// tool 角色消息：回链 assistant 某次工具调用的 tool_call_id。
    /// Option 缺省不入请求体（无工具请求与旧 wire 形态逐字段一致）。
    pub tool_call_id: Option<String>,
    /// assistant 消息：模型发起的工具调用列表，原样回传以续接多轮工具回路。
    /// Option 缺省不入请求体（同上）。
    pub tool_calls: Option<Vec<ToolCall>>,
}

impl ChatMessage {
    pub fn new(role: ChatRole, content: impl Into<String>) -> Self {
        Self { role, content: content.into(), tool_call_id: None, tool_calls: None }
    }

    /// 附加 tool_call_id（tool 角色消息回链 assistant 的某次工具调用）。
    pub fn with_tool_call_id(mut self, id: impl Into<String>) -> Self {
        self.tool_call_id = Some(id.into());
        self
    }

    /// 附加 tool_calls（assistant 消息携带模型发起的工具调用，续接多轮工具回路）。
    pub fn with_tool_calls(mut self, calls: Vec<ToolCall>) -> Self {
        self.tool_calls = Some(calls);
        self
    }
}

/// 非流式工具调用回路的单轮产物：模型要么给出最终正文，要么发起工具调用，二者取一。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolLoopTurn {
    /// 模型直接给出正文（本轮未发起工具调用）。
    Content(String),
    /// 模型发起工具调用：调用方执行后以 tool 角色消息回传并再次调用，循环直到 Content。
    ToolCalls(Vec<ToolCall>),
}

/// 单条消息的 wire 形态：role / content 恒发；tool_call_id / tool_calls 仅在携带时发送
/// （Option 缺省不发 → 无工具请求与旧形态逐字段一致，OpenAI 兼容可选字段惯例）。
// pub(super)：client.rs 的请求体构造与 trace.rs 的 prompt_json 轨迹记录共用。
pub(super) fn chat_message_wire(m: &ChatMessage) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    obj.insert("role".into(), m.role.as_str().into());
    obj.insert("content".into(), m.content.clone().into());
    if let Some(id) = &m.tool_call_id {
        obj.insert("tool_call_id".into(), id.clone().into());
    }
    if let Some(calls) = &m.tool_calls {
        let calls: Vec<_> = calls
            .iter()
            .map(|c| {
                serde_json::json!({
                    "id": c.id,
                    "type": "function",
                    "function": { "name": c.name, "arguments": c.arguments },
                })
            })
            .collect();
        obj.insert("tool_calls".into(), serde_json::Value::Array(calls));
    }
    serde_json::Value::Object(obj)
}

/// 工具定义的 wire 形态（OpenAI 兼容：type 固定 function，parameters 为 JSON Schema 原样透传）。
// pub(super)：仅 client.rs 的 tools 请求构造使用（与 chat_message_wire 同域放置）。
pub(super) fn tool_spec_wire(s: &ToolSpec) -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": s.name,
            "description": s.description,
            "parameters": s.parameters,
        },
    })
}
