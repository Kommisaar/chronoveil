//! Anthropic Messages API wire（provider_api = anthropic）。
//! 协议形态依据 Anthropic 官方 Messages API 公开规范：
//! - endpoint `{base}/v1/messages`；认证经 `x-api-key` 头 + `anthropic-version`
//!   头（不用 Bearer）；
//! - `max_tokens` 为必填参数（OpenAI 兼容网关无此参数，Anthropic 缺省即 4xx）；
//! - system 提升为顶层 `system` 参数（messages 内无 system 角色）；
//! - 工具回路以 content blocks 表达：assistant 侧 `tool_use`、结果回传侧
//!   `tool_result`（user 消息内）；
//! - SSE `data:` 负载按 `type` 分派（`event:` 行与本层无关，行级解析器已忽略）。

use reqwest::RequestBuilder;
use serde_json::Value;

use super::contract::{ChatMessage, ChatRole, LlmConfig, LlmError, ToolCall, ToolLoopTurn, ToolSpec};
use super::protocol::{join_system_text, ApiProtocol, StreamFrameParser};
use super::sse::{ChatDelta, SseItem, SseUsage};
use super::trace::CallObservation;

/// Anthropic Messages 必填参数 `max_tokens`：取主流 Claude 输出上限的安全值
/// 8192（本应用的消息体量远用不满；不作为配置项暴露，属协议适配细节）。
const MAX_TOKENS: i64 = 8192;
/// `anthropic-version` 头取值：2023-06-01 为官方长期稳定的版本号。
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Anthropic Messages API 协议（`{base}/v1/messages`，x-api-key）。
pub(super) struct AnthropicMessages;

impl ApiProtocol for AnthropicMessages {
    fn endpoint(&self, base_url: &str) -> String {
        format!("{base_url}/v1/messages")
    }

    fn apply_auth(&self, rb: RequestBuilder, api_key: &str) -> RequestBuilder {
        // Anthropic 不用 Bearer：密钥经 x-api-key 传递；空密钥不发该头（与
        // OpenAI 路径「空密钥不附加认证头」同法，本地网关兼容）。
        let rb = rb.header("anthropic-version", ANTHROPIC_VERSION);
        if api_key.is_empty() {
            rb
        } else {
            rb.header("x-api-key", api_key)
        }
    }

    fn payload(
        &self,
        config: &LlmConfig,
        messages: &[ChatMessage],
        stream: bool,
        tools: Option<&[ToolSpec]>,
        // tool_choice 不接（见下）：当前调用方恒传 None。
        _tool_choice: Option<&str>,
    ) -> Result<Value, LlmError> {
        let mut wire_messages = Vec::new();
        for m in messages {
            match m.role {
                // System 提升（多条按序 \n\n 拼接），不进 messages。
                ChatRole::System => {}
                ChatRole::User => wire_messages.push(serde_json::json!({
                    "role": "user",
                    "content": m.content,
                })),
                ChatRole::Assistant => wire_messages.push(assistant_message_wire(m)?),
                // 工具结果回传：Anthropic 无 tool 角色，映射为 user 消息内的
                // tool_result block，凭 tool_use_id 回链。
                ChatRole::Tool => wire_messages.push(tool_result_message_wire(m)?),
            }
        }
        let mut payload = serde_json::json!({
            "model": config.model,
            "max_tokens": MAX_TOKENS,
            "messages": wire_messages,
            "stream": stream,
        });
        if let Some(system) = join_system_text(messages) {
            payload["system"] = Value::String(system);
        }
        // tools 仅在提供时随附（Anthropic 扁平形态：input_schema 承载 JSON Schema）。
        // tool_choice 不接：当前调用方（complete_with_tools）恒传 None，Anthropic 的
        // tool_choice 形态（auto/any/tool 对象）与 OpenAI 不同，等真实调用方出现再议。
        if let Some(specs) = tools.filter(|specs| !specs.is_empty()) {
            payload["tools"] = Value::Array(
                specs
                    .iter()
                    .map(|s| {
                        serde_json::json!({
                            "name": s.name,
                            "description": s.description,
                            "input_schema": s.parameters,
                        })
                    })
                    .collect(),
            );
        }
        Ok(payload)
    }

    fn new_stream_parser(&self) -> Box<dyn StreamFrameParser> {
        Box::new(AnthropicStreamParser { input_tokens: None, output_tokens: None })
    }

    fn parse_content_reply(
        &self,
        payload: &Value,
        obs: &mut CallObservation,
    ) -> Result<String, LlmError> {
        let (prompt, completion) = usage_tokens(payload);
        obs.prompt_tokens = prompt;
        obs.completion_tokens = completion;
        // message 类型响应无 reasoning 字段（未开启 thinking），思考通道恒 None。
        let text = join_text_blocks(content_blocks(payload)?);
        let content = text
            .ok_or_else(|| LlmError::Protocol("响应缺少 text 内容块".into()))?;
        obs.response_text = Some(content.clone());
        Ok(content)
    }

    fn parse_tool_turn(
        &self,
        payload: &Value,
        obs: &mut CallObservation,
    ) -> Result<ToolLoopTurn, LlmError> {
        let blocks = content_blocks(payload)?;
        let (prompt, completion) = usage_tokens(payload);
        obs.prompt_tokens = prompt;
        obs.completion_tokens = completion;
        let mut calls = Vec::new();
        let mut texts: Vec<&str> = Vec::new();
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(Value::as_str) {
                        texts.push(t);
                    }
                }
                // tool_use → ToolCall：input 为模型生成的 JSON 对象，序列化回字符串
                // 形态（ToolCall.arguments 的业务面契约）。
                Some("tool_use") => calls.push(ToolCall {
                    id: block
                        .get("id")
                        .and_then(Value::as_str)
                        .ok_or_else(|| LlmError::Protocol("tool_use 缺少 id".into()))?
                        .to_owned(),
                    name: block
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or_else(|| LlmError::Protocol("tool_use 缺少 name".into()))?
                        .to_owned(),
                    arguments: serde_json::to_string(
                        block
                            .get("input")
                            .ok_or_else(|| LlmError::Protocol("tool_use 缺少 input".into()))?,
                    )
                    .map_err(|e| LlmError::Protocol(format!("tool_use input 序列化失败：{e}")))?,
                }),
                // 其余块类型（redacted_thinking 等）忽略。
                _ => {}
            }
        }
        obs.response_text = (!texts.is_empty()).then(|| texts.join(""));
        if calls.is_empty() {
            let content = texts.join("");
            if content.is_empty() {
                return Err(LlmError::Protocol(
                    "响应缺少 text 内容块或 tool_use 块".into(),
                ));
            }
            return Ok(ToolLoopTurn::Content(content));
        }
        // content 与 tool_use 并存时以 tool_use 为准（与 OpenAI 路径语义一致）。
        Ok(ToolLoopTurn::ToolCalls(calls))
    }

    fn interrupted_error(&self) -> LlmError {
        LlmError::Network("SSE 流在 message_stop 前中断".into())
    }
}

/// assistant 消息 wire：无工具调用 → 字符串 content；有 tool_calls → content blocks
/// （非空正文前置 text 块——Anthropic 要求 assistant 正文以 text 块表达，随后的
/// tool_use 块凭 id/name/input 复现模型发起的调用）。
/// `input` 由 arguments 字符串 parse：合法路径上必为合法 JSON 对象——模型按工具的
/// input_schema 生成参数，且回路回传的 arguments 由本层序列化产出；parse 失败或
/// 非对象属协议违约，提前报 Protocol 错（重发同输入必然复现，不可重试）。
fn assistant_message_wire(m: &ChatMessage) -> Result<Value, LlmError> {
    let Some(calls) = &m.tool_calls else {
        return Ok(serde_json::json!({ "role": "assistant", "content": m.content }));
    };
    if calls.is_empty() {
        return Ok(serde_json::json!({ "role": "assistant", "content": m.content }));
    }
    let mut blocks = Vec::new();
    if !m.content.is_empty() {
        blocks.push(serde_json::json!({ "type": "text", "text": m.content }));
    }
    for c in calls {
        let input: Value = serde_json::from_str(&c.arguments)
            .map_err(|e| LlmError::Protocol(format!("assistant 工具调用 arguments 非法 JSON：{e}")))?;
        if !input.is_object() {
            return Err(LlmError::Protocol(
                "assistant 工具调用 arguments 须为 JSON 对象（Anthropic tool_use.input 形态）".into(),
            ));
        }
        blocks.push(serde_json::json!({
            "type": "tool_use",
            "id": c.id,
            "name": c.name,
            "input": input,
        }));
    }
    Ok(serde_json::json!({ "role": "assistant", "content": blocks }))
}

/// tool 结果消息 wire：映射为 user 消息内的 tool_result block。
/// tool_call_id 缺失无法回链（Anthropic 侧必填），提前报错而非发出畸形请求。
fn tool_result_message_wire(m: &ChatMessage) -> Result<Value, LlmError> {
    let Some(id) = m.tool_call_id.as_deref() else {
        return Err(LlmError::Protocol(
            "tool 消息缺少 tool_call_id（无法回链 Anthropic tool_result）".into(),
        ));
    };
    Ok(serde_json::json!({
        "role": "user",
        "content": [{ "type": "tool_result", "tool_use_id": id, "content": m.content }],
    }))
}

/// 响应体 content 数组（缺失 / 非数组 → Protocol 错误）。
fn content_blocks(payload: &Value) -> Result<&[Value], LlmError> {
    payload
        .get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| LlmError::Protocol("响应缺少 content 内容块数组".into()))
}

/// text 块正文拼接（多块依序直连；无 text 块 → None）。
fn join_text_blocks(blocks: &[Value]) -> Option<String> {
    let texts: Vec<&str> = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect();
    (!texts.is_empty()).then(|| texts.join(""))
}

/// usage 提取（Anthropic 键名 input_tokens / output_tokens；缺失 / 非数字按无，
/// 与 OpenAI 路径「不猜不补」同法）。
fn usage_tokens(payload: &Value) -> (Option<i64>, Option<i64>) {
    let usage = payload.get("usage");
    let get = |key: &str| usage.and_then(|u| u.get(key)).and_then(Value::as_i64);
    (get("input_tokens"), get("output_tokens"))
}

/// Anthropic 流帧解析器：`message_start` 记 usage.input_tokens、`message_delta` 记
/// usage.output_tokens（解析器内累积），`message_stop` 产出 Usage + Done 两个条目
/// （usage 两端齐备才记，不猜不补；Usage 先于 Done，客户端见 Done 即收流）。
struct AnthropicStreamParser {
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
}

impl StreamFrameParser for AnthropicStreamParser {
    fn parse(&mut self, data: &str) -> Result<Vec<SseItem>, LlmError> {
        // 非 JSON 负载忽略（与 OpenAI 路径的行级容错同法，不让杂音炸流）。
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            return Ok(Vec::new());
        };
        match value.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                self.input_tokens = value
                    .pointer("/message/usage/input_tokens")
                    .and_then(Value::as_i64);
                Ok(Vec::new())
            }
            Some("message_delta") => {
                self.output_tokens = value
                    .pointer("/usage/output_tokens")
                    .and_then(Value::as_i64);
                Ok(Vec::new())
            }
            Some("message_stop") => {
                let mut items = Vec::new();
                if let (Some(prompt), Some(completion)) = (self.input_tokens, self.output_tokens) {
                    items.push(SseItem::Usage(SseUsage { prompt_tokens: prompt, completion_tokens: completion }));
                }
                items.push(SseItem::Done);
                Ok(items)
            }
            Some("content_block_delta") => Ok(anthropic_delta(&value)
                .map(SseItem::Delta)
                .into_iter()
                .collect()),
            // 流内 error 事件（如 overloaded）：Protocol 错误终止流。不可重试——
            // Anthropic 已在帧内给出明确失败语义，按断流重发只会原样复现。
            Some("error") => Err(LlmError::Protocol(format!(
                "Anthropic 流式错误帧：{}",
                value.get("error").map(Value::to_string).unwrap_or_default()
            ))),
            // ping / content_block_start / content_block_stop / message_start 之外的
            // 未知事件一律忽略（验收 2 的优雅降级语义）。
            _ => Ok(Vec::new()),
        }
    }
}

/// content_block_delta 的两路增量：按 delta.type 分派——text_delta.text → 正文，
/// thinking_delta.thinking → 思考（网关若回 thinking 增量仍进思考通道；本层不主动
/// 开启 thinking，budget_tokens 属产品参数，不在协议适配目标内）。input_json_delta
/// （工具参数流式）等其余增量忽略。
fn anthropic_delta(value: &Value) -> Option<ChatDelta> {
    let delta = value.get("delta")?;
    match delta.get("type").and_then(Value::as_str) {
        Some("text_delta") => {
            let content = delta
                .get("text")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)?;
            Some(ChatDelta { content: Some(content), reasoning: None })
        }
        Some("thinking_delta") => {
            let reasoning = delta
                .get("thinking")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)?;
            Some(ChatDelta { content: None, reasoning: Some(reasoning) })
        }
        _ => None,
    }
}