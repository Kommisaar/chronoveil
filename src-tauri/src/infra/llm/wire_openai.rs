//! OpenAI Chat Completions 兼容 wire（provider_api = openai，现状默认协议）。
//! 2026-09-14 自 client.rs（endpoint / payload / Bearer 认证）与 gateway.rs
//! （usage / message 字段提取 / tool_calls 解析）**纯搬移归拢**：逻辑与错误文案
//! 保持逐字不变（现状路径行为零变化），只是从「散落在调用路径」改为「协议实现」。

use reqwest::RequestBuilder;

use super::contract::{
    chat_message_wire, tool_spec_wire, ChatMessage, LlmConfig, LlmError, ToolCall, ToolLoopTurn,
    ToolSpec,
};
use super::protocol::{ApiProtocol, StreamFrameParser};
use super::sse::{self, SseItem};
use super::trace::CallObservation;

/// OpenAI Chat Completions 兼容协议（`{base}/chat/completions`，Bearer）。
pub(super) struct OpenAiCompat;

impl ApiProtocol for OpenAiCompat {
    fn endpoint(&self, base_url: &str) -> String {
        format!("{base_url}/chat/completions")
    }

    fn apply_auth(&self, rb: RequestBuilder, api_key: &str) -> RequestBuilder {
        // 密钥为空时不附加 Authorization 头（本地免鉴权推理服务兼容）。
        if api_key.is_empty() {
            rb
        } else {
            rb.bearer_auth(api_key)
        }
    }

    fn payload(
        &self,
        config: &LlmConfig,
        messages: &[ChatMessage],
        stream: bool,
        tools: Option<&[ToolSpec]>,
        tool_choice: Option<&str>,
    ) -> Result<serde_json::Value, LlmError> {
        let mut payload = serde_json::json!({
            "model": config.model,
            "messages": messages
                .iter()
                .map(chat_message_wire)
                .collect::<Vec<_>>(),
            "stream": stream,
        });
        // tools 仅在提供时进入请求体（空工具切片视同未提供），未提供时 wire 形态
        // 与无工具请求完全一致（OpenAI 兼容可选字段缺省不发）。
        if let Some(specs) = tools.filter(|specs| !specs.is_empty()) {
            payload["tools"] =
                serde_json::Value::Array(specs.iter().map(tool_spec_wire).collect());
            if let Some(choice) = tool_choice {
                payload["tool_choice"] = serde_json::Value::String(choice.to_owned());
            }
        }
        Ok(payload)
    }

    fn new_stream_parser(&self) -> Box<dyn StreamFrameParser> {
        Box::new(OpenAiStreamParser)
    }

    fn parse_content_reply(
        &self,
        payload: &serde_json::Value,
        obs: &mut CallObservation,
    ) -> Result<String, LlmError> {
        // 原 complete_json_once 的字段提取（逐字搬移）：usage / reasoning 先入观测
        //（解析失败时观测同样保留），content 必答。
        let (prompt, completion) = usage_tokens(payload);
        obs.prompt_tokens = prompt;
        obs.completion_tokens = completion;
        obs.reasoning_text = message_field_str(payload, "reasoning_content")
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let Some(content) = message_field_str(payload, "content") else {
            return Err(LlmError::Protocol("响应缺少 choices[0].message.content".into()));
        };
        obs.response_text = Some(content.to_owned());
        Ok(content.to_owned())
    }

    fn parse_tool_turn(
        &self,
        payload: &serde_json::Value,
        obs: &mut CallObservation,
    ) -> Result<ToolLoopTurn, LlmError> {
        // 原 attempt_complete_with_tools_once 的观测填充 + parse_tool_turn（逐字搬移）。
        let (prompt, completion) = usage_tokens(payload);
        obs.prompt_tokens = prompt;
        obs.completion_tokens = completion;
        obs.response_text = message_field_str(payload, "content").map(str::to_owned);
        parse_tool_turn(payload)
    }

    fn interrupted_error(&self) -> LlmError {
        LlmError::Network("SSE 流在 [DONE] 前中断".into())
    }
}

/// OpenAI 兼容流帧解析：`[DONE]` 哨兵 → Done，其余按 choices[0].delta 帧解析
/// （sse.rs 的既有实现，行为不变）。
struct OpenAiStreamParser;

impl StreamFrameParser for OpenAiStreamParser {
    fn parse(&mut self, data: &str) -> Result<Vec<SseItem>, LlmError> {
        if data == "[DONE]" {
            return Ok(vec![SseItem::Done]);
        }
        Ok(sse::parse_frame(data))
    }
}

/// 非流式响应体内的 usage 提取（OpenAI 兼容 usage 对象；字段缺失 / 非数字按无）。
/// 自 gateway.rs 纯搬移。
fn usage_tokens(payload: &serde_json::Value) -> (Option<i64>, Option<i64>) {
    let usage = payload.get("usage");
    let get = |key: &str| usage.and_then(|u| u.get(key)).and_then(serde_json::Value::as_i64);
    (get("prompt_tokens"), get("completion_tokens"))
}

/// choices[0].message.<field> 的字符串取值（缺失 / null / 非字符串 → None）。
/// 自 gateway.rs 纯搬移。
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
/// 自 gateway.rs 纯搬移（错误文案逐字保留）。
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
