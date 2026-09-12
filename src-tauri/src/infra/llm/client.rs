//! LlmClient 客户端本体：构造与请求组装（endpoint / chat payload / HTTP 头）、
//! 流式生成路径（chat_stream + 断流整条重发 + 立即取消 + 事件路由 reset 标）。
//! 非流式两路（complete_json / complete_with_tools）见 gateway.rs，记录逻辑见 trace.rs。
//! 纯搬移自原 llm.rs 单文件；模块级职责与事件语义见 llm.rs 壳文档。

use std::sync::Arc;
use std::time::{Duration, Instant};

use super::contract::{
    chat_message_wire, map_reqwest_error, tool_spec_wire, CancelHandle, ChatMessage, EventSink,
    LlmConfig, LlmError, LlmEvent, MessageIds, ToolSpec,
};
use super::sse;
use super::think;
use super::trace::{epoch_ms, CallObservation, CallTrace, LlmCallSink};

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
    // pub(super)：gateway.rs 的重试循环读取 retry 策略；trace.rs 的记录组装读取 model。
    pub(super) config: LlmConfig,
    /// 调用轨迹记录器（旁路，透明化功能）：None = 不记录（测试 / 未接线装配）。
    // pub(super)：仅 trace.rs 的 record_call 组装轨迹时读取。
    pub(super) call_sink: Option<Arc<dyn LlmCallSink>>,
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

    // pub(super)：gateway.rs 的非流式两路复用请求构造。
    pub(super) fn chat_request(&self, messages: &[ChatMessage], stream: bool) -> reqwest::RequestBuilder {
        self.chat_request_with_options(messages, stream, None, None)
    }

    /// 请求构造的完整形态：`tools`（与可选 `tool_choice`）仅在提供时进入请求体，
    /// 未提供时 wire 形态与 `chat_request` 完全一致（OpenAI 兼容可选字段缺省不发）。
    /// 空工具切片视同未提供（Task-05 探索器收尾轮「不再带 tools」的干净下线路径）。
    // pub(super)：gateway.rs 的工具回路请求构造复用。
    pub(super) fn chat_request_with_options(
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
    // pub(super)：gateway.rs 的工具回路重试共用同一退避策略。
    pub(super) async fn backoff(&self, failed_attempt: u32) {
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
