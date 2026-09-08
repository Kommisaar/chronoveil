//! model.rs（CMP-002）：LLM 网关——OpenAI 兼容多 provider 客户端（base_url + api_key + model，INT-002）。
//!
//! 职责边界（CMP-002）：SSE 流解析、reasoning 两形态分离路由（字段型直通 + 内联 `<think>` 状态机）、
//! 类型化事件发射（FR-001：token/reasoning/done/error，携 session_id/message_id）、
//! 消息级断流重发、立即取消、结构化 JSON 调用 helper。
//! 不负责：渲染决策、落库时机（只上报终态，ADR-001 由调用方落库）、prompt 业务装配。
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

// 骨架期：本模块 API 的消费方在 TASK-005（IPC 事件通道）与 TASK-006（生成编排）接线后出现。
#![allow(dead_code)]

pub mod sse;
pub mod think;

#[cfg(test)]
mod mock;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::sync::watch;

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
// 消息入参
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatRole {
    System,
    User,
    Assistant,
}

impl ChatRole {
    pub fn as_str(self) -> &'static str {
        match self {
            ChatRole::System => "system",
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

impl ChatMessage {
    pub fn new(role: ChatRole, content: impl Into<String>) -> Self {
        Self { role, content: content.into() }
    }
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
#[derive(Debug, Default)]
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
#[derive(Debug, Clone)]
pub struct LlmClient {
    http: reqwest::Client,
    config: LlmConfig,
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
        Ok(Self { http, config })
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
                .map(|m| serde_json::json!({ "role": m.role.as_str(), "content": m.content }))
                .collect::<Vec<_>>(),
            "stream": stream,
        })
    }

    fn chat_request(&self, messages: &[ChatMessage], stream: bool) -> reqwest::RequestBuilder {
        let mut rb = self
            .http
            .post(self.endpoint())
            .header(reqwest::header::ACCEPT, if stream { "text/event-stream" } else { "application/json" })
            .json(&self.chat_payload(messages, stream));
        if !self.config.api_key.is_empty() {
            rb = rb.bearer_auth(&self.config.api_key);
        }
        rb
    }

    /// 聊天流式生成（验收 2–6）。事件经 `sink` 发射；取消立即返回，不再产生事件。
    pub async fn chat_stream(
        &self,
        messages: &[ChatMessage],
        ids: MessageIds,
        sink: Arc<dyn EventSink>,
        cancel: &CancelHandle,
    ) -> Result<StreamOutcome, StreamFailure> {
        let mut attempt: u32 = 0;
        loop {
            match self.attempt_stream(messages, ids, &sink, cancel, attempt).await {
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

    /// 单次尝试：连接 → 状态映射 → 逐块解析 → 事件发射。断流以可重试错误返回。
    async fn attempt_stream(
        &self,
        messages: &[ChatMessage],
        ids: MessageIds,
        sink: &Arc<dyn EventSink>,
        cancel: &CancelHandle,
        attempt: u32,
    ) -> Result<StreamOutcome, (LlmError, AttemptPartial)> {
        let mut parser = sse::SseParser::new();
        let mut splitter = think::ThinkSplitter::new();
        let mut partial = AttemptPartial::default();
        let mut first_reasoning_at: Option<Instant> = None;
        let mut router = EventRouter { sink, ids, attempt, first_event: true };

        // ---- 连接（可被取消打断）----
        let response = tokio::select! {
            resp = self.chat_request(messages, true).send() => match resp {
                Ok(r) => r,
                Err(e) => return Err((map_reqwest_error(e), partial)),
            },
            _ = cancel.wait() => return Ok(StreamOutcome::Cancelled {
                partial_content: partial.content,
                partial_reasoning: non_empty(partial.reasoning),
            }),
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
            return Err((error, partial));
        }
        let mut response = response;

        // ---- 流读取（逐块，可被取消打断）----
        loop {
            let chunk = tokio::select! {
                c = response.chunk() => c,
                _ = cancel.wait() => return Ok(StreamOutcome::Cancelled {
                    partial_content: partial.content,
                    partial_reasoning: non_empty(partial.reasoning),
                }),
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
                                return Ok(StreamOutcome::Completed {
                                    content: partial.content,
                                    reasoning: non_empty(partial.reasoning),
                                    think_ms,
                                });
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
                    return Err((
                        LlmError::Network("SSE 流在 [DONE] 前中断".into()),
                        partial,
                    ));
                }
                Err(e) => return Err((map_reqwest_error(e), partial)),
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
    pub async fn complete_json<T: DeserializeOwned>(
        &self,
        messages: &[ChatMessage],
    ) -> Result<T, LlmError> {
        let response = self
            .chat_request(messages, false)
            .send()
            .await
            .map_err(map_reqwest_error)?;
        let status = response.status();
        if !status.is_success() {
            let code = status.as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(match code {
                401 => LlmError::Unauthorized,
                429 => LlmError::RateLimited,
                _ => LlmError::Status { status: code, body },
            });
        }
        let payload: serde_json::Value = response
            .json()
            .await
            .map_err(|e| LlmError::Protocol(format!("非流式响应不是合法 JSON：{e}")))?;
        let content = payload
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| LlmError::Protocol("响应缺少 choices[0].message.content".into()))?;
        let value = extract_json(content)?;
        serde_json::from_value(value)
            .map_err(|e| LlmError::Json(format!("模型输出与目标结构不符：{e}")))
    }
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
