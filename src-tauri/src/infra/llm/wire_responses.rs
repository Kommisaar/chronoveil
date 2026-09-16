//! OpenAI Responses API wire（provider_api = openai_responses）。
//! 协议形态依据 OpenAI 官方 Responses API 公开规范：
//! - endpoint `{base}/responses`；Bearer 认证同 Chat Completions；
//! - 对话历史以 `input` items 表达（message / function_call / function_call_output），
//!   system 文本提升为顶层 `instructions` 参数（无 System 则不发该键）；
//! - 工具为扁平形态 `{type:"function", name, description, parameters}`（无嵌套
//!   function 包装，与 Chat Completions 的差异点）；
//! - SSE `data:` 负载按 `type` 分派，终态 `response.completed` 携全量 usage。

use reqwest::RequestBuilder;
use serde_json::Value;

use super::contract::{ChatMessage, ChatRole, LlmConfig, LlmError, ToolCall, ToolLoopTurn, ToolSpec};
use super::protocol::{join_system_text, ApiProtocol, StreamFrameParser};
use super::sse::{ChatDelta, SseItem, SseUsage};
use super::trace::CallObservation;

/// `store: false` 恒发（模块常量）：ChronoVeil 数据全本地的隐私原则——拒绝
/// OpenAI 服务端留存对话/输出（Responses 默认留存供 retrieval）。若未来某个
/// 兼容网关报「未知参数 store」再议移除。
const STORE: bool = false;

/// OpenAI Responses API 协议（`{base}/responses`，Bearer）。
pub(super) struct OpenAiResponses;

impl ApiProtocol for OpenAiResponses {
    fn endpoint(&self, base_url: &str) -> String {
        format!("{base_url}/responses")
    }

    fn apply_auth(&self, rb: RequestBuilder, api_key: &str) -> RequestBuilder {
        // 与 OpenAI Chat Completions 同法：空密钥不附加 Authorization 头。
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
    ) -> Result<Value, LlmError> {
        let mut input = Vec::new();
        for m in messages {
            match m.role {
                // System 提升（多条按序 \n\n 拼接），不进 input。
                ChatRole::System => {}
                ChatRole::User => input.push(serde_json::json!({
                    "role": "user",
                    "content": m.content,
                })),
                ChatRole::Assistant => {
                    // 正文在前、function_call 在后：保持模型原始产出顺序
                    //（正文非空才发 message item，回路回传的空正文不产生空 item）。
                    let calls = m.tool_calls.as_deref().unwrap_or(&[]);
                    if !m.content.is_empty() {
                        input.push(serde_json::json!({
                            "role": "assistant",
                            "content": m.content,
                        }));
                    }
                    for c in calls {
                        input.push(serde_json::json!({
                            "type": "function_call",
                            "call_id": c.id,
                            "name": c.name,
                            "arguments": c.arguments,
                        }));
                    }
                }
                // 工具结果回传：Responses 无 tool 角色，映射为 function_call_output
                // item，凭 call_id 回链。缺失无法回链（协议必填），提前报错而非发出
                // 畸形请求。
                ChatRole::Tool => {
                    let Some(id) = m.tool_call_id.as_deref() else {
                        return Err(LlmError::Protocol(
                            "tool 消息缺少 tool_call_id（无法回链 function_call_output）".into(),
                        ));
                    };
                    input.push(serde_json::json!({
                        "type": "function_call_output",
                        "call_id": id,
                        "output": m.content,
                    }));
                }
            }
        }
        let mut payload = serde_json::json!({
            "model": config.model,
            "input": input,
            "stream": stream,
            "store": STORE,
            // 采样温度（设置页全局，0–2）：Responses 参数域同 OpenAI 0–2，原样下发。
            "temperature": config.temperature,
            // 核采样 top_p：Responses 支持该参数。惩罚参数本协议无此概念，
            // 不下发（OpenAI 兼容独有，见 wire_openai）。
            "top_p": config.top_p,
        });
        if let Some(instructions) = join_system_text(messages) {
            payload["instructions"] = Value::String(instructions);
        }
        // tools 仅在提供时随附（Responses 扁平形态）；tool_choice 同 OpenAI 现状
        // 仅提供时发（当前调用方恒传 None）。
        if let Some(specs) = tools.filter(|specs| !specs.is_empty()) {
            payload["tools"] = Value::Array(
                specs
                    .iter()
                    .map(|s| {
                        serde_json::json!({
                            "type": "function",
                            "name": s.name,
                            "description": s.description,
                            "parameters": s.parameters,
                        })
                    })
                    .collect(),
            );
            if let Some(choice) = tool_choice {
                payload["tool_choice"] = Value::String(choice.to_owned());
            }
        }
        Ok(payload)
    }

    fn new_stream_parser(&self) -> Box<dyn StreamFrameParser> {
        Box::new(ResponsesStreamParser)
    }

    fn parse_content_reply(
        &self,
        payload: &Value,
        obs: &mut CallObservation,
    ) -> Result<String, LlmError> {
        let (prompt, completion) = usage_tokens(payload);
        obs.prompt_tokens = prompt;
        obs.completion_tokens = completion;
        let text = join_output_text(output_items(payload)?);
        let content = text
            .ok_or_else(|| LlmError::Protocol("响应缺少 output_text 输出".into()))?;
        obs.response_text = Some(content.clone());
        Ok(content)
    }

    fn parse_tool_turn(
        &self,
        payload: &Value,
        obs: &mut CallObservation,
    ) -> Result<ToolLoopTurn, LlmError> {
        let items = output_items(payload)?;
        let (prompt, completion) = usage_tokens(payload);
        obs.prompt_tokens = prompt;
        obs.completion_tokens = completion;
        let mut calls = Vec::new();
        let mut texts: Vec<String> = Vec::new();
        for item in items {
            match item.get("type").and_then(Value::as_str) {
                Some("message") => {
                    if let Some(t) = item
                        .get("content")
                        .and_then(Value::as_array)
                        .and_then(|parts| join_output_text_parts(parts))
                    {
                        texts.push(t);
                    }
                }
                // function_call → ToolCall（arguments 为 JSON 字符串原样透传，同 OpenAI）。
                Some("function_call") => calls.push(ToolCall {
                    id: item
                        .get("call_id")
                        .and_then(Value::as_str)
                        .ok_or_else(|| LlmError::Protocol("function_call 缺少 call_id".into()))?
                        .to_owned(),
                    name: item
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or_else(|| LlmError::Protocol("function_call 缺少 name".into()))?
                        .to_owned(),
                    arguments: item
                        .get("arguments")
                        .and_then(Value::as_str)
                        .ok_or_else(|| LlmError::Protocol("function_call 缺少 arguments".into()))?
                        .to_owned(),
                }),
                // 其余 item 类型（reasoning、web_search_call 等）忽略。
                _ => {}
            }
        }
        obs.response_text = (!texts.is_empty()).then(|| texts.join(""));
        if calls.is_empty() {
            let content = texts.join("");
            if content.is_empty() {
                return Err(LlmError::Protocol(
                    "响应缺少 output_text 输出或 function_call".into(),
                ));
            }
            return Ok(ToolLoopTurn::Content(content));
        }
        // 正文与 function_call 并存时以 function_call 为准（与 OpenAI 路径语义一致）。
        Ok(ToolLoopTurn::ToolCalls(calls))
    }

    fn interrupted_error(&self) -> LlmError {
        LlmError::Network("SSE 流在 response.completed 前中断".into())
    }
}

/// 响应体 output 数组（缺失 / 非数组 → Protocol 错误）。
fn output_items(payload: &Value) -> Result<&[Value], LlmError> {
    payload
        .get("output")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| LlmError::Protocol("响应缺少 output 数组".into()))
}

/// message item 内 content 部件的 output_text 拼接（无 → None）。
fn join_output_text_parts(parts: &[Value]) -> Option<String> {
    let texts: Vec<&str> = parts
        .iter()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .collect();
    (!texts.is_empty()).then(|| texts.join(""))
}

/// output items 全量 output_text 拼接（跨 message item 直连；无 → None）。
fn join_output_text(items: &[Value]) -> Option<String> {
    let mut all = String::new();
    for item in items {
        if item.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        if let Some(parts) = item.get("content").and_then(Value::as_array) {
            if let Some(t) = join_output_text_parts(parts) {
                all.push_str(&t);
            }
        }
    }
    (!all.is_empty()).then_some(all)
}

/// usage 提取（Responses 键名 input_tokens / output_tokens；缺失 / 非数字按无，
/// 与 OpenAI 路径「不猜不补」同法）。
fn usage_tokens(payload: &Value) -> (Option<i64>, Option<i64>) {
    let usage = payload.get("usage");
    let get = |key: &str| usage.and_then(|u| u.get(key)).and_then(Value::as_i64);
    (get("input_tokens"), get("output_tokens"))
}

/// Responses 流帧解析器（无跨帧状态：终态帧自带全量 usage）。
struct ResponsesStreamParser;

impl StreamFrameParser for ResponsesStreamParser {
    fn parse(&mut self, data: &str) -> Result<Vec<SseItem>, LlmError> {
        // 非 JSON 负载忽略（与 OpenAI 路径的行级容错同法，不让杂音炸流）。
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            return Ok(Vec::new());
        };
        match value.get("type").and_then(Value::as_str) {
            Some("response.output_text.delta") => {
                Ok(delta_item(value.get("delta"), None))
            }
            // reasoning 两条事件：summary（摘要）与 raw（原生推理文本），同进思考通道。
            Some("response.reasoning_summary_text.delta")
            | Some("response.reasoning_text.delta") => {
                Ok(delta_item(None, value.get("delta")))
            }
            // 终态：completed 正常完成；incomplete 为截断完成语义（如上下文窗口
            // 耗尽 max_output_tokens）——已有部分产出仍按正常完成收流（Done），
            // 截断详情属展示层语义，不在网关分型。
            Some("response.completed") | Some("response.incomplete") => {
                let usage = value.pointer("/response/usage");
                let get = |key: &str| usage.and_then(|u| u.get(key)).and_then(Value::as_i64);
                let (prompt, completion) = (get("input_tokens"), get("output_tokens"));
                let mut items = Vec::new();
                if let (Some(prompt), Some(completion)) = (prompt, completion) {
                    items.push(SseItem::Usage(SseUsage { prompt_tokens: prompt, completion_tokens: completion }));
                }
                items.push(SseItem::Done);
                Ok(items)
            }
            // 失败终态：Protocol 错误终止流，不可重试——服务端已给出明确失败语义
            //（response.failed / error 事件），按断流重发只会原样复现。
            // 错误详情逐级回退：response.failed 的 response.error 对象 → 流内
            // error 事件的嵌套 error 键 → 官方顶层 error 事件的 message / code
            // 顶层字段（该形态无包裹对象，缺一fallback 即只剩前缀）。
            Some("response.failed") | Some("error") => {
                let detail = value
                    .pointer("/response/error")
                    .or_else(|| value.get("error"))
                    .map(Value::to_string)
                    .or_else(|| {
                        let message = value.get("message").and_then(Value::as_str);
                        let code = value.get("code").and_then(Value::as_str);
                        match (message, code) {
                            (Some(m), Some(c)) => Some(format!("{c}: {m}")),
                            (Some(m), None) => Some(m.to_owned()),
                            (None, Some(c)) => Some(c.to_owned()),
                            (None, None) => None,
                        }
                    })
                    .unwrap_or_default();
                Err(LlmError::Protocol(format!("Responses 流式错误帧：{detail}")))
            }
            // response.created / response.in_progress / response.output_item.added /
            // content_part.added 等进度事件与未知事件一律忽略。
            _ => Ok(Vec::new()),
        }
    }
}

/// 单条 delta 事件的两路增量构造（content / reasoning 至少一路非空才产出条目）。
fn delta_item(content: Option<&Value>, reasoning: Option<&Value>) -> Vec<SseItem> {
    let str_of = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let content = str_of(content);
    let reasoning = str_of(reasoning);
    if content.is_none() && reasoning.is_none() {
        return Vec::new();
    }
    vec![SseItem::Delta(ChatDelta { content, reasoning })]
}
