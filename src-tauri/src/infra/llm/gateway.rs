//! 非流式调用路径：结构化 JSON 调用（complete_json，容错提取见 [`extract_json`]）与
//! 非流式工具调用回路（complete_with_tools，每一轮请求各记一条轨迹）。
//! 请求构造 / 重试退避复用 client.rs 的 pub(super) 方法，轨迹组装复用 trace.rs。
//! 纯搬移自原 llm.rs 单文件；模块级职责与事件语义见 llm.rs 壳文档。

use std::time::Instant;

use serde::de::DeserializeOwned;

use super::client::LlmClient;
use super::contract::{map_reqwest_error, ChatMessage, LlmError, ToolCall, ToolLoopTurn, ToolSpec};
use super::trace::{epoch_ms, CallObservation, CallTrace};

impl LlmClient {
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
