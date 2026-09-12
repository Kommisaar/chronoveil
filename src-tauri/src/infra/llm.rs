//! model.rs（CMP-002）：LLM 网关——OpenAI 兼容多 provider 客户端（base_url + api_key + model，INT-002）。
//!
//! 职责边界（CMP-002）：SSE 流解析、reasoning 两形态分离路由（字段型直通 + 内联 `<think>` 状态机）、
//! 类型化事件发射（FR-001：token/reasoning/done/error，携 session_id/message_id；Task-06 起另有
//! 幕后活动事件 activity，记忆探索步骤透出）、
//! 消息级断流重发、立即取消、结构化 JSON 调用 helper、非流式工具调用回路
//! （OpenAI 兼容 tools / tool_calls，切片 C 记忆探索 agent 的地基，暂无业务接线）。
//! 不负责：渲染决策、落库时机（只上报终态，ADR-001 由调用方落库）、prompt 业务装配。
//! 例外：调用轨迹（透明化功能）——每次 HTTP 请求经 [`LlmCallSink`]（组合根注入的
//! 旁路记录器）回调一条轨迹观测（prompt / 响应 / usage / 状态），持久化在 sink 实现侧。
//!
//! 分层约束：本模块不 `use tauri`——事件经 `EventSink` 抽象回调发射（TASK-005 接通道）。
//!
//! 事件语义补充（实现内定，验收 4/5）：
//! - 重发期间失败尝试不产生独立事件；重发尝试的第一个 token/reasoning 事件带
//!   `reset: true`，消费方应清空该 message_id 已累积内容后重新累积（「新内容替换旧半条」）；
//! - `done.think_ms` 是网关侧「首条 reasoning 增量 → 终态」的墙钟时长；FR-003 的
//!   用户可见时长校正由前端/生成服务在落库前覆盖；
//! - 取消（cancel）不产生任何事件（验收 6），以 `StreamOutcome::Cancelled` 返回，
//!   携带中断半条内容供调用方按 ADR-001 落库；
//! - 最终失败经 `EventSink` 上报一次 `error`（含 reason/interrupted），并以
//!   `StreamFailure` 返回错误与最后尝试的半条内容。

// 本模块 API 的消费方已全部接线：TASK-005（IPC 事件通道）、TASK-006（生成编排）
// 与导演服务（FR-011 阶段 5，complete_json / extract_json）。

pub mod sse;
pub mod think;

#[cfg(test)]
pub(crate) mod mock;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::sync::watch;

use crate::domain::models::{LlmCallKind, LlmCallStatus, NewLlmCall};

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

/// Provider 连接配置（INT-002）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmConfig {
    /// OpenAI 兼容服务根地址（如 `https://api.deepseek.com`），结尾 `/` 会被容忍。
    pub base_url: String,
    /// Bearer 密钥；为空时不附加 Authorization 头（本地免鉴权推理服务兼容）。
    pub api_key: String,
    pub model: String,
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

fn map_reqwest_error(e: reqwest::Error) -> LlmError {
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
// 调用轨迹（透明化功能）：CallTrace 上下文 + LlmCallSink 记录器
// ---------------------------------------------------------------------------

/// 一次 LLM 调用的轨迹上下文（调用方传入）：会话内定位 + 调用类别。
/// `None` trace 参数 = 不记录（测试 / 未来可能的内部调用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CallTrace {
    /// 所属会话；None = 无会话调用（历法起草 draft）。
    pub session_id: Option<i64>,
    pub kind: LlmCallKind,
}

/// LLM 调用轨迹记录器（旁路）：网关每完成一次 HTTP 请求回调一次
/// （含失败 / 取消尝试——「每次 HTTP 请求 = 一条记录」）。
///
/// trait 定义在 infra（网关在记录点所见信息最全），实现由组合根注入：
/// 生产实现（interfaces::events::TauriCallSink）落库 + 发 Trace 事件，
/// 轨迹是旁路——实现内部吞掉失败（warn 留痕），不影响主流程。
pub trait LlmCallSink: Send + Sync {
    fn record(&self, call: NewLlmCall);
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

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

/// 流式生成的终态结果（事件之外的调用方视角返回值）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamOutcome {
    /// 正常完成（此时 `Done` 事件已发射）。
    Completed {
        content: String,
        reasoning: Option<String>,
        think_ms: Option<u64>,
    },
    /// 被取消（不发任何事件；携带已产出半条，供调用方按 ADR-001 落库）。
    Cancelled { partial_content: String, partial_reasoning: Option<String> },
}

/// 最终失败（此时 `Error` 事件已发射一次）。携带最后尝试的半条内容供落库。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamFailure {
    pub error: LlmError,
    pub partial_content: String,
    pub partial_reasoning: Option<String>,
}

/// 单次尝试内累积的半条（最后尝试视角）。
#[derive(Debug, Default, Clone)]
struct AttemptPartial {
    content: String,
    reasoning: String,
}

impl AttemptPartial {
    fn into_parts(self) -> (String, Option<String>) {
        let reasoning = if self.reasoning.is_empty() { None } else { Some(self.reasoning) };
        (self.content, reasoning)
    }
}

/// OpenAI 兼容 LLM 客户端（CMP-002）。
pub struct LlmClient {
    http: reqwest::Client,
    config: LlmConfig,
    /// 调用轨迹记录器（旁路，透明化功能）：None = 不记录（测试 / 未接线装配）。
    call_sink: Option<Arc<dyn LlmCallSink>>,
}

impl std::fmt::Debug for LlmClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LlmClient")
            .field("config", &self.config)
            .field("call_sink", &self.call_sink.is_some())
            .finish()
    }
}

impl LlmClient {
    pub fn new(config: LlmConfig) -> Result<Self, LlmError> {
        if config.base_url.trim().is_empty() {
            return Err(LlmError::Config("base_url 不能为空".into()));
        }
        if config.model.trim().is_empty() {
            return Err(LlmError::Config("model 不能为空".into()));
        }
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_millis(config.connect_timeout_ms))
            .read_timeout(Duration::from_millis(config.read_timeout_ms))
            .build()
            .map_err(|e| LlmError::Config(format!("HTTP 客户端构建失败：{e}")))?;
        Ok(Self { http, config, call_sink: None })
    }

    /// 挂接调用轨迹记录器（组合根 / 命令层装配时调用一次；builder 风格链式）。
    pub fn with_call_sink(mut self, sink: Arc<dyn LlmCallSink>) -> Self {
        self.call_sink = Some(sink);
        self
    }

    pub fn config(&self) -> &LlmConfig {
        &self.config
    }

    fn endpoint(&self) -> String {
        format!("{}/chat/completions", self.config.base_url.trim_end_matches('/'))
    }

    fn chat_payload(&self, messages: &[ChatMessage], stream: bool) -> serde_json::Value {
        serde_json::json!({
            "model": self.config.model,
            "messages": messages
                .iter()
                .map(chat_message_wire)
                .collect::<Vec<_>>(),
            "stream": stream,
        })
    }

    fn chat_request(&self, messages: &[ChatMessage], stream: bool) -> reqwest::RequestBuilder {
        self.chat_request_with_options(messages, stream, None, None)
    }

    /// 请求构造的完整形态：`tools`（与可选 `tool_choice`）仅在提供时进入请求体，
    /// 未提供时 wire 形态与 `chat_request` 完全一致（OpenAI 兼容可选字段缺省不发）。
    /// 空工具切片视同未提供（Task-05 探索器收尾轮「不再带 tools」的干净下线路径）。
    fn chat_request_with_options(
        &self,
        messages: &[ChatMessage],
        stream: bool,
        tools: Option<&[ToolSpec]>,
        tool_choice: Option<&str>,
    ) -> reqwest::RequestBuilder {
        let mut payload = self.chat_payload(messages, stream);
        if let Some(specs) = tools.filter(|specs| !specs.is_empty()) {
            payload["tools"] =
                serde_json::Value::Array(specs.iter().map(tool_spec_wire).collect());
            if let Some(choice) = tool_choice {
                payload["tool_choice"] = serde_json::Value::String(choice.to_owned());
            }
        }
        let mut rb = self
            .http
            .post(self.endpoint())
            .header(reqwest::header::ACCEPT, if stream { "text/event-stream" } else { "application/json" })
            .json(&payload);
        if !self.config.api_key.is_empty() {
            rb = rb.bearer_auth(&self.config.api_key);
        }
        rb
    }

    /// 聊天流式生成（验收 2–6）。事件经 `sink` 发射；取消立即返回，不再产生事件。
    /// `trace`：调用轨迹上下文（透明化功能）——每次 HTTP 请求（含断流重发的每次
    /// 尝试）记录一条轨迹；None = 不记录。
    pub async fn chat_stream(
        &self,
        messages: &[ChatMessage],
        ids: MessageIds,
        sink: Arc<dyn EventSink>,
        cancel: &CancelHandle,
        trace: Option<&CallTrace>,
    ) -> Result<StreamOutcome, StreamFailure> {
        let mut attempt: u32 = 0;
        loop {
            match self
                .attempt_stream(messages, ids, &sink, cancel, attempt, trace)
                .await
            {
                Ok(outcome) => return Ok(outcome),
                Err((error, partial)) => {
                    if error.is_retryable() && attempt < self.config.retry.max_retries {
                        self.backoff(attempt).await;
                        attempt += 1;
                        continue;
                    }
                    let (partial_content, partial_reasoning) = partial.into_parts();
                    let interrupted =
                        !partial_content.is_empty() || partial_reasoning.is_some();
                    sink.emit(LlmEvent::Error {
                        session_id: ids.session_id,
                        message_id: ids.message_id,
                        reason: error.to_string(),
                        interrupted,
                    });
                    return Err(StreamFailure { error, partial_content, partial_reasoning });
                }
            }
        }
    }

    /// 单次尝试（外层）：计时 + 轨迹记录（透明化功能：每次 HTTP 请求一条），
    /// 请求本体在 [`Self::attempt_stream_once`]。
    async fn attempt_stream(
        &self,
        messages: &[ChatMessage],
        ids: MessageIds,
        sink: &Arc<dyn EventSink>,
        cancel: &CancelHandle,
        attempt: u32,
        trace: Option<&CallTrace>,
    ) -> Result<StreamOutcome, (LlmError, AttemptPartial)> {
        let started_at = epoch_ms();
        let started = Instant::now();
        let (outcome, usage) =
            self.attempt_stream_once(messages, ids, sink, cancel, attempt).await;
        // 轨迹旁路记录：ok / error / 取消三种终态都记（取消按 error，原因「已取消」；
        // 半条内容如实入 response_text / reasoning_text，供回放对账）。
        match &outcome {
            Ok(StreamOutcome::Completed { content, reasoning, .. }) => {
                let (prompt_tokens, completion_tokens) =
                    usage.map_or((None, None), |u| (Some(u.prompt_tokens), Some(u.completion_tokens)));
                self.record_call(
                    trace,
                    started_at,
                    started,
                    messages,
                    CallObservation {
                        response_text: non_empty(content.clone()),
                        reasoning_text: reasoning.clone(),
                        tool_calls_json: None,
                        prompt_tokens,
                        completion_tokens,
                        error_text: None,
                    },
                );
            }
            Ok(StreamOutcome::Cancelled { partial_content, partial_reasoning }) => {
                self.record_call(
                    trace,
                    started_at,
                    started,
                    messages,
                    CallObservation {
                        response_text: non_empty(partial_content.clone()),
                        reasoning_text: partial_reasoning.clone(),
                        tool_calls_json: None,
                        prompt_tokens: None,
                        completion_tokens: None,
                        error_text: Some("已取消".into()),
                    },
                );
            }
            Err((error, partial)) => {
                let (partial_content, partial_reasoning) = partial.clone().into_parts();
                self.record_call(
                    trace,
                    started_at,
                    started,
                    messages,
                    CallObservation {
                        response_text: non_empty(partial_content),
                        reasoning_text: partial_reasoning,
                        tool_calls_json: None,
                        prompt_tokens: None,
                        completion_tokens: None,
                        error_text: Some(error.to_string()),
                    },
                );
            }
        }
        outcome
    }

    /// 单次尝试（内层）：连接 → 状态映射 → 逐块解析 → 事件发射。断流以可重试错误
    /// 返回；同时返回流内捕获的 usage（OpenAI 兼容 usage 终帧，有则记无则 None）。
    async fn attempt_stream_once(
        &self,
        messages: &[ChatMessage],
        ids: MessageIds,
        sink: &Arc<dyn EventSink>,
        cancel: &CancelHandle,
        attempt: u32,
    ) -> (Result<StreamOutcome, (LlmError, AttemptPartial)>, Option<sse::SseUsage>) {
        let mut parser = sse::SseParser::new();
        let mut splitter = think::ThinkSplitter::new();
        let mut partial = AttemptPartial::default();
        let mut first_reasoning_at: Option<Instant> = None;
        let mut usage: Option<sse::SseUsage> = None;
        let mut router = EventRouter { sink, ids, attempt, first_event: true };

        // ---- 连接（可被取消打断）----
        let response = tokio::select! {
            resp = self.chat_request(messages, true).send() => match resp {
                Ok(r) => r,
                Err(e) => return (Err((map_reqwest_error(e), partial)), None),
            },
            _ = cancel.wait() => return (Ok(StreamOutcome::Cancelled {
                partial_content: partial.content,
                partial_reasoning: non_empty(partial.reasoning),
            }), None),
        };

        // ---- 状态码映射（验收 8）----
        let status = response.status();
        if !status.is_success() {
            let code = status.as_u16();
            let body = response.text().await.unwrap_or_default();
            let error = match code {
                401 => LlmError::Unauthorized,
                429 => LlmError::RateLimited,
                _ => LlmError::Status { status: code, body },
            };
            return (Err((error, partial)), None);
        }
        let mut response = response;

        // ---- 流读取（逐块，可被取消打断）----
        loop {
            let chunk = tokio::select! {
                c = response.chunk() => c,
                _ = cancel.wait() => return (Ok(StreamOutcome::Cancelled {
                    partial_content: partial.content,
                    partial_reasoning: non_empty(partial.reasoning),
                }), usage),
            };
            match chunk {
                Ok(Some(bytes)) => {
                    for item in parser.feed(&bytes) {
                        match item {
                            sse::SseItem::Done => {
                                let think_ms = first_reasoning_at
                                    .map(|t| t.elapsed().as_millis() as u64);
                                sink.emit(LlmEvent::Done {
                                    session_id: ids.session_id,
                                    message_id: ids.message_id,
                                    think_ms,
                                });
                                return (Ok(StreamOutcome::Completed {
                                    content: partial.content,
                                    reasoning: non_empty(partial.reasoning),
                                    think_ms,
                                }), usage);
                            }
                            // usage 终帧（透明化功能）：网关主动回报才记，不做请求侧
                            // stream_options 追加（部分中转不认识该参数，保守兼容）。
                            sse::SseItem::Usage(captured) => {
                                usage = Some(captured);
                            }
                            sse::SseItem::Delta(delta) => {
                                // 字段型 reasoning：直通思考通道（FR-003 / INT-002）。
                                if let Some(r) = delta.reasoning {
                                    first_reasoning_at.get_or_insert_with(Instant::now);
                                    partial.reasoning.push_str(&r);
                                    router.reasoning(&r);
                                }
                                // 正文：内联 <think> 经状态机拆分路由。
                                if let Some(c) = delta.content {
                                    let out = splitter.feed(&c);
                                    if !out.think.is_empty() {
                                        first_reasoning_at.get_or_insert_with(Instant::now);
                                        partial.reasoning.push_str(&out.think);
                                        router.reasoning(&out.think);
                                    }
                                    if !out.body.is_empty() {
                                        partial.content.push_str(&out.body);
                                        router.token(&out.body);
                                    }
                                }
                            }
                        }
                    }
                }
                // 流在 [DONE] 前正常 EOF：断流，按整条重发（验收 5）。
                Ok(None) => {
                    return (
                        Err((LlmError::Network("SSE 流在 [DONE] 前中断".into()), partial)),
                        usage,
                    );
                }
                Err(e) => return (Err((map_reqwest_error(e), partial)), usage),
            }
        }
    }

    /// 指数退避：第 `failed_attempt` 次失败后的等待。0ms 直接跳过（测试路径）。
    async fn backoff(&self, failed_attempt: u32) {
        let policy = &self.config.retry;
        let mut ms = policy.initial_backoff_ms;
        for _ in 0..failed_attempt {
            ms = ms.saturating_mul(policy.backoff_multiplier as u64).min(policy.max_backoff_ms);
        }
        if ms == 0 {
            return;
        }
        // tokio 未开 time feature：用阻塞线程睡眠的 spawn_blocking 兜底（退避只出现在失败路径）。
        let _ = tokio::task::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms))).await;
    }

    /// 结构化 JSON 调用（验收 7）：非流式一次性调用 + 容错提取（容忍 ```json 围栏与前后杂文），
    /// 失败返回 `LlmError::Json`。INT-002 的「结算重试直到成功」循环由调用方（导演服务）持有。
    /// `trace`：调用轨迹上下文（透明化功能）——本方法单次请求即一条轨迹（重试重发
    /// 由调用方循环发起，每次调用各自成条）；None = 不记录。
    pub async fn complete_json<T: DeserializeOwned>(
        &self,
        messages: &[ChatMessage],
        trace: Option<&CallTrace>,
    ) -> Result<T, LlmError> {
        let started_at = epoch_ms();
        let started = Instant::now();
        let (result, obs) = self.complete_json_once(messages).await;
        self.record_call(trace, started_at, started, messages, obs);
        result
    }

    /// 非流式结构化调用的单次请求本体：请求 → 状态映射 → 解析 → 提取；
    /// 同时产出轨迹观测（正文 / reasoning / usage / 错误，Json 失败也如实记下原始输出）。
    async fn complete_json_once<T: DeserializeOwned>(
        &self,
        messages: &[ChatMessage],
    ) -> (Result<T, LlmError>, CallObservation) {
        let mut obs = CallObservation::default();
        let response = match self.chat_request(messages, false).send().await {
            Ok(response) => response,
            Err(e) => {
                let error = map_reqwest_error(e);
                obs.error_text = Some(error.to_string());
                return (Err(error), obs);
            }
        };
        let status = response.status();
        if !status.is_success() {
            let code = status.as_u16();
            let body = response.text().await.unwrap_or_default();
            let error = match code {
                401 => LlmError::Unauthorized,
                429 => LlmError::RateLimited,
                _ => LlmError::Status { status: code, body },
            };
            obs.error_text = Some(error.to_string());
            return (Err(error), obs);
        }
        let payload: serde_json::Value = match response.json().await {
            Ok(payload) => payload,
            Err(e) => {
                let error = LlmError::Protocol(format!("非流式响应不是合法 JSON：{e}"));
                obs.error_text = Some(error.to_string());
                return (Err(error), obs);
            }
        };
        obs.prompt_tokens = usage_tokens(&payload).0;
        obs.completion_tokens = usage_tokens(&payload).1;
        obs.reasoning_text = message_field_str(&payload, "reasoning_content")
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let Some(content) = message_field_str(&payload, "content") else {
            let error = LlmError::Protocol("响应缺少 choices[0].message.content".into());
            obs.error_text = Some(error.to_string());
            return (Err(error), obs);
        };
        obs.response_text = Some(content.to_owned());
        let value = match extract_json(content) {
            Ok(value) => value,
            Err(error) => {
                obs.error_text = Some(error.to_string());
                return (Err(error), obs);
            }
        };
        match serde_json::from_value(value) {
            Ok(parsed) => (Ok(parsed), obs),
            Err(e) => {
                let error = LlmError::Json(format!("模型输出与目标结构不符：{e}"));
                obs.error_text = Some(error.to_string());
                (Err(error), obs)
            }
        }
    }

    /// 非流式工具调用回路单轮：携带工具定义请求，返回本轮「正文或工具调用」；
    /// 调用方执行工具后以 tool 角色消息回传并再次调用，循环直到 Content
    /// （循环责任在调用方，本方法只做一轮）。重试语义与 chat_stream 一致：
    /// 可重试错误（超时 / 网络 / 429 / 5xx）按整条消息重发，max_retries 与指数退避同池。
    /// `trace`：调用轨迹上下文——工具循环的**每一轮请求各记录一条**（每轮的
    /// prompt / 响应 / 该轮模型发起的 tool_calls 都不同，合并会丢回放信息）。
    pub async fn complete_with_tools(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        trace: Option<&CallTrace>,
    ) -> Result<ToolLoopTurn, LlmError> {
        let mut attempt: u32 = 0;
        loop {
            match self.attempt_complete_with_tools(messages, tools, trace).await {
                Ok(turn) => return Ok(turn),
                Err(error) => {
                    if error.is_retryable() && attempt < self.config.retry.max_retries {
                        self.backoff(attempt).await;
                        attempt += 1;
                        continue;
                    }
                    return Err(error);
                }
            }
        }
    }

    /// 工具回路单次尝试：请求 → 状态映射（与 complete_json 同一套）→ tool_calls / content
    /// 分支解析；轨迹记录在本层完成（每次尝试 = 一条，含重试的失败尝试）。
    async fn attempt_complete_with_tools(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        trace: Option<&CallTrace>,
    ) -> Result<ToolLoopTurn, LlmError> {
        let started_at = epoch_ms();
        let started = Instant::now();
        let (result, mut obs) = self.attempt_complete_with_tools_once(messages, tools).await;
        // 该轮模型发起的工具调用：[{name, arguments}]（不含 id——回放关注语义而非回链）。
        if let Ok(ToolLoopTurn::ToolCalls(calls)) = &result {
            let wire: Vec<serde_json::Value> = calls
                .iter()
                .map(|c| serde_json::json!({ "name": c.name, "arguments": c.arguments }))
                .collect();
            obs.tool_calls_json = Some(serde_json::Value::Array(wire).to_string());
        }
        self.record_call(trace, started_at, started, messages, obs);
        result
    }

    /// 工具回路单次请求本体：同时产出轨迹观测。
    async fn attempt_complete_with_tools_once(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> (Result<ToolLoopTurn, LlmError>, CallObservation) {
        let mut obs = CallObservation::default();
        let response = match self
            .chat_request_with_options(messages, false, Some(tools), None)
            .send()
            .await
        {
            Ok(response) => response,
            Err(e) => {
                let error = map_reqwest_error(e);
                obs.error_text = Some(error.to_string());
                return (Err(error), obs);
            }
        };
        let status = response.status();
        if !status.is_success() {
            let code = status.as_u16();
            let body = response.text().await.unwrap_or_default();
            let error = match code {
                401 => LlmError::Unauthorized,
                429 => LlmError::RateLimited,
                _ => LlmError::Status { status: code, body },
            };
            obs.error_text = Some(error.to_string());
            return (Err(error), obs);
        }
        let payload: serde_json::Value = match response.json().await {
            Ok(payload) => payload,
            Err(e) => {
                let error = LlmError::Protocol(format!("非流式响应不是合法 JSON：{e}"));
                obs.error_text = Some(error.to_string());
                return (Err(error), obs);
            }
        };
        obs.prompt_tokens = usage_tokens(&payload).0;
        obs.completion_tokens = usage_tokens(&payload).1;
        obs.response_text = message_field_str(&payload, "content").map(str::to_owned);
        match parse_tool_turn(&payload) {
            Ok(turn) => (Ok(turn), obs),
            Err(error) => {
                obs.error_text = Some(error.to_string());
                (Err(error), obs)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 轨迹记录（透明化功能）：观测结构 + 组装 + 发往 sink（旁路，None 全跳过）
// ---------------------------------------------------------------------------

/// 一次 HTTP 请求的轨迹观测：网关在各出口路径填充，`record_call` 统一组装落 sink。
#[derive(Debug, Default)]
struct CallObservation {
    response_text: Option<String>,
    reasoning_text: Option<String>,
    tool_calls_json: Option<String>,
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    error_text: Option<String>,
}

impl LlmClient {
    /// 组装一条 NewLlmCall 并发往记录器；trace / sink 任一为 None 即 no-op
    /// （轨迹是旁路：不阻塞、不影响主流程，失败由 sink 实现侧吞掉）。
    fn record_call(
        &self,
        trace: Option<&CallTrace>,
        started_at: i64,
        started: Instant,
        messages: &[ChatMessage],
        obs: CallObservation,
    ) {
        let Some(trace) = trace else { return };
        let Some(sink) = &self.call_sink else { return };
        let prompt_json = serde_json::Value::Array(
            messages.iter().map(chat_message_wire).collect(),
        )
        .to_string();
        sink.record(NewLlmCall {
            session_id: trace.session_id,
            kind: trace.kind,
            model: self.config.model.clone(),
            started_at,
            duration_ms: started.elapsed().as_millis().min(i64::MAX as u128) as i64,
            prompt_json,
            response_text: obs.response_text,
            reasoning_text: obs.reasoning_text,
            tool_calls_json: obs.tool_calls_json,
            prompt_tokens: obs.prompt_tokens,
            completion_tokens: obs.completion_tokens,
            status: if obs.error_text.is_none() {
                LlmCallStatus::Ok
            } else {
                LlmCallStatus::Error
            },
            error_text: obs.error_text,
        });
    }
}

/// 当前时刻的 Unix 毫秒（轨迹 started_at；与 storage::now 同义，infra/llm 不反向
/// 依赖 storage 模块，就地实现）。
fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// 非流式响应体内的 usage 提取（OpenAI 兼容 usage 对象；字段缺失 / 非数字按无）。
fn usage_tokens(payload: &serde_json::Value) -> (Option<i64>, Option<i64>) {
    let usage = payload.get("usage");
    let get = |key: &str| usage.and_then(|u| u.get(key)).and_then(serde_json::Value::as_i64);
    (get("prompt_tokens"), get("completion_tokens"))
}

/// choices[0].message.<field> 的字符串取值（缺失 / null / 非字符串 → None）。
fn message_field_str<'a>(payload: &'a serde_json::Value, field: &str) -> Option<&'a str> {
    payload
        .get("choices")?
        .as_array()?
        .first()?
        .get("message")?
        .get(field)?
        .as_str()
}

/// 事件发射路由：跟踪「重发尝试首事件」以打 `reset` 标。
struct EventRouter<'a> {
    sink: &'a Arc<dyn EventSink>,
    ids: MessageIds,
    attempt: u32,
    first_event: bool,
}

impl EventRouter<'_> {
    fn take_reset(&mut self) -> bool {
        let reset = self.attempt > 0 && self.first_event;
        self.first_event = false;
        reset
    }

    fn token(&mut self, delta: &str) {
        let reset = self.take_reset();
        self.sink.emit(LlmEvent::Token {
            session_id: self.ids.session_id,
            message_id: self.ids.message_id,
            text: delta.to_owned(),
            reset,
        });
    }

    fn reasoning(&mut self, delta: &str) {
        let reset = self.take_reset();
        self.sink.emit(LlmEvent::Reasoning {
            session_id: self.ids.session_id,
            message_id: self.ids.message_id,
            text: delta.to_owned(),
            reset,
        });
    }
}

fn non_empty(s: String) -> Option<String> {
    if s.is_empty() { None } else { Some(s) }
}

/// 单条消息的 wire 形态：role / content 恒发；tool_call_id / tool_calls 仅在携带时发送
/// （Option 缺省不发 → 无工具请求与旧形态逐字段一致，OpenAI 兼容可选字段惯例）。
fn chat_message_wire(m: &ChatMessage) -> serde_json::Value {
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
fn tool_spec_wire(s: &ToolSpec) -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": s.name,
            "description": s.description,
            "parameters": s.parameters,
        },
    })
}

/// 解析非流式响应的 choices[0].message：tool_calls 存在且非空 → ToolCalls
/// （arguments 为 JSON 字符串原样透传，不在此解析）；否则（缺失 / null / 空数组）回落
/// content → Content。两者皆缺或形态不符 → Protocol 错误（不可重试）。
fn parse_tool_turn(payload: &serde_json::Value) -> Result<ToolLoopTurn, LlmError> {
    let message = payload
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("message"))
        .ok_or_else(|| LlmError::Protocol("响应缺少 choices[0].message".into()))?;
    if let Some(calls) = message.get("tool_calls").and_then(|t| t.as_array()) {
        if !calls.is_empty() {
            let parsed = calls
                .iter()
                .map(|c| {
                    let id = c
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| LlmError::Protocol("tool_calls 元素缺少 id".into()))?;
                    let function = c
                        .get("function")
                        .ok_or_else(|| LlmError::Protocol("tool_calls 元素缺少 function".into()))?;
                    let name = function
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| LlmError::Protocol("tool_calls.function 缺少 name".into()))?;
                    let arguments = function
                        .get("arguments")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            LlmError::Protocol("tool_calls.function 缺少 arguments".into())
                        })?;
                    Ok(ToolCall {
                        id: id.to_owned(),
                        name: name.to_owned(),
                        arguments: arguments.to_owned(),
                    })
                })
                .collect::<Result<Vec<_>, LlmError>>()?;
            return Ok(ToolLoopTurn::ToolCalls(parsed));
        }
    }
    let content = message
        .get("content")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| LlmError::Protocol("响应缺少 choices[0].message.content".into()))?;
    Ok(ToolLoopTurn::Content(content.to_owned()))
}

/// 从模型自由文本中提取 JSON：直接解析 → 剥 ``` 围栏 → 截取首尾花/方括号之间的子串。
pub fn extract_json(text: &str) -> Result<serde_json::Value, LlmError> {
    let mut candidate = text.trim();
    if let Some(rest) = candidate.strip_prefix("```") {
        let rest = rest.trim_start_matches(['j', 's', 'o', 'n', 'J', 'S', 'O', 'N']);
        let rest = rest.trim();
        let rest = rest.strip_suffix("```").unwrap_or(rest);
        candidate = rest.trim();
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(candidate) {
        return Ok(v);
    }
    // 前后带杂文：截取第一个 {/[ 到最后一个 }/] 的子串再试（ASCII 边界，切片安全）。
    if let (Some(start), Some(end)) = (candidate.find(['{', '[']), candidate.rfind(['}', ']'])) {
        if start < end {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&candidate[start..=end]) {
                return Ok(v);
            }
        }
    }
    let preview: String = candidate.chars().take(120).collect();
    Err(LlmError::Json(format!("无法从模型输出中提取 JSON：{preview}")))
}

#[cfg(test)]
mod tests;
