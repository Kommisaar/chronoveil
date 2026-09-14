//! OpenAI Responses 协议（provider_api = openai_responses，2026-09-14）：
//! 流式（POST /responses、Bearer、instructions / input / store:false 映射、
//! output_text 与 reasoning delta 分路、response.completed → Usage + Done、
//! response.failed → Protocol 不可重试）与非流式（output_text 拼接、
//! function_call → ToolCalls、function_call_output 回传请求体映射）。

use std::io::Write;
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use super::*;
use crate::domain::llm_call::{LlmCallKind, LlmCallStatus, NewLlmCall};
use crate::infra::llm::mock::{json_raw_body, sse_data, sse_head, MockRequest, MockServer};

/// 事件快照（本协议组局部）：token / reasoning / done / errors。
#[derive(Default)]
struct Observed {
    tokens: Vec<String>,
    reasoning: Vec<String>,
    done: usize,
    errors: Vec<String>,
}

fn drain(rx: &mut mpsc::UnboundedReceiver<LlmEvent>) -> Observed {
    let mut observed = Observed::default();
    while let Ok(event) = rx.try_recv() {
        match event {
            LlmEvent::Token { text, .. } => observed.tokens.push(text),
            LlmEvent::Reasoning { text, .. } => observed.reasoning.push(text),
            LlmEvent::Done { .. } => observed.done += 1,
            LlmEvent::Error { reason, .. } => observed.errors.push(reason),
            LlmEvent::Activity { .. } => {}
        }
    }
    observed
}

/// 轨迹收集器（usage 断言用；同 trace.rs 的 TraceCollector）。
struct TraceCollector(std::sync::Mutex<Vec<NewLlmCall>>);

impl LlmCallSink for TraceCollector {
    fn record(&self, call: NewLlmCall) {
        self.0.lock().unwrap().push(call);
    }
}

fn trace_collector() -> Arc<TraceCollector> {
    Arc::new(TraceCollector(std::sync::Mutex::new(Vec::new())))
}

fn records_of(collector: &TraceCollector) -> Vec<NewLlmCall> {
    collector.0.lock().unwrap().clone()
}

/// 流式正常路径：POST /responses + Bearer（无 x-api-key）；system → instructions、
/// store:false 恒发；output_text.delta → Token、reasoning delta → Reasoning、
/// response.completed → Usage + Done。
#[tokio::test]
async fn stream_request_shape_headers_and_events() {
    let captured: Arc<Mutex<Option<MockRequest>>> = Arc::new(Mutex::new(None));
    let cap = captured.clone();
    let server = MockServer::start(move |req, stream| {
        *cap.lock().unwrap() = Some(req.clone());
        let _ = sse_head(stream);
        for payload in [
            serde_json::json!({"type":"response.created","response":{"id":"resp_1"}}).to_string(),
            serde_json::json!({"type":"response.output_text.delta","delta":"你好"}).to_string(),
            serde_json::json!({"type":"response.reasoning_summary_text.delta","delta":"想想"}).to_string(),
            serde_json::json!({"type":"response.reasoning_text.delta","delta":"再想"}).to_string(),
            serde_json::json!({"type":"response.output_text.delta","delta":"，世界"}).to_string(),
            serde_json::json!({"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":11,"output_tokens":7}}}).to_string(),
        ] {
            let _ = stream.write_all(sse_data(&payload).as_bytes());
        }
        let _ = stream.flush();
    });

    let collector = trace_collector();
    let (sink_tx, mut rx) = sink();
    let (_signal, cancel) = cancel_channel();
    let trace = CallTrace { session_id: Some(7), kind: LlmCallKind::Dialogue };
    let messages = vec![
        ChatMessage::new(ChatRole::System, "你是助手"),
        ChatMessage::new(ChatRole::User, "你好"),
    ];
    let outcome = client_with_api(&server.url(), retry_policy(0), ProviderApi::OpenAiResponses)
        .with_call_sink(collector.clone())
        .chat_stream(&messages, IDS, sink_tx, &cancel, Some(&trace))
        .await
        .expect("正常流不应失败");

    let req = captured.lock().unwrap().clone().expect("应捕获到请求");
    assert_eq!(req.path, "/responses");
    assert_eq!(req.header("authorization"), Some("Bearer test-key"), "Bearer 同 OpenAI 现状");
    assert_eq!(req.header("x-api-key"), None, "Responses 不用 x-api-key");
    let body = req.json();
    assert_eq!(body["model"], "test-model");
    assert_eq!(body["stream"], true);
    assert_eq!(body["store"], false, "ChronoVeil 隐私原则：拒绝服务端留存");
    // 采样温度随 payload 下发（测试夹具走 LlmConfig::default() = 0.7）。
    assert_eq!(body["temperature"], 0.7);
    assert_eq!(body["instructions"], "你是助手", "System 提升为顶层 instructions");
    let input = body["input"].as_array().unwrap();
    assert_eq!(input.len(), 1, "system 不进 input");
    assert_eq!(input[0]["role"], "user");
    assert_eq!(input[0]["content"], "你好");

    let observed = drain(&mut rx);
    assert_eq!(observed.tokens, vec!["你好".to_string(), "，世界".to_string()]);
    assert_eq!(
        observed.reasoning,
        vec!["想想".to_string(), "再想".to_string()],
        "summary 与 raw 两种 reasoning delta 都进思考通道"
    );
    assert_eq!(observed.done, 1, "response.completed → Done");
    assert!(observed.errors.is_empty());
    match outcome {
        StreamOutcome::Completed { content, reasoning, .. } => {
            assert_eq!(content, "你好，世界");
            assert_eq!(reasoning.as_deref(), Some("想想再想"));
        }
        other => panic!("应为 Completed：{other:?}"),
    }

    let records = records_of(&collector);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].prompt_tokens, Some(11), "response.usage.input_tokens");
    assert_eq!(records[0].completion_tokens, Some(7), "response.usage.output_tokens");
    assert_eq!(records[0].status, LlmCallStatus::Ok);
}

/// 无 System 消息 → 不发 instructions 键（可选字段缺省不发）。
#[tokio::test]
async fn no_system_message_omits_instructions_key() {
    let captured: Arc<Mutex<Option<MockRequest>>> = Arc::new(Mutex::new(None));
    let cap = captured.clone();
    let server = MockServer::start(move |req, stream| {
        *cap.lock().unwrap() = Some(req.clone());
        let _ = sse_head(stream);
        let _ = stream.write_all(
            sse_data(r#"{"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}"#).as_bytes(),
        );
        let _ = stream.flush();
    });
    let (sink_tx, _rx) = sink();
    let (_signal, cancel) = cancel_channel();
    client_with_api(&server.url(), retry_policy(0), ProviderApi::OpenAiResponses)
        .chat_stream(&messages(), IDS, sink_tx, &cancel, None)
        .await
        .expect("无 system 流不应失败");
    let body = captured.lock().unwrap().clone().expect("应捕获到请求").json();
    assert!(body.get("instructions").is_none(), "无 System 不发 instructions：{body:?}");
}

/// 失败终态（response.failed）→ Protocol 错误（不可重试：单次连接即失败）。
#[tokio::test]
async fn response_failed_is_protocol_error_and_not_retried() {
    let server = MockServer::start(|_req, stream| {
        let _ = sse_head(stream);
        let payload = serde_json::json!({
            "type": "response.failed",
            "response": { "id": "resp_1", "error": { "code": "server_error", "message": "boom" } }
        });
        let _ = stream.write_all(sse_data(&payload.to_string()).as_bytes());
        let _ = stream.flush();
    });
    let (sink_tx, mut rx) = sink();
    let (_signal, cancel) = cancel_channel();
    let failure = client_with_api(&server.url(), retry_policy(2), ProviderApi::OpenAiResponses)
        .chat_stream(&messages(), IDS, sink_tx, &cancel, None)
        .await
        .expect_err("response.failed 应失败");
    assert!(matches!(failure.error, LlmError::Protocol(_)), "实际：{:?}", failure.error);
    assert_eq!(server.connection_count(), 1, "Protocol 错误不可重试");
    let observed = drain(&mut rx);
    assert_eq!(observed.errors.len(), 1);
    assert_eq!(observed.done, 0);
}

/// 流内顶层 error 事件（官方形态：message / code 等为顶层字段，无包裹对象）→
/// Protocol 错误且诊断信息含 message 内容；请求已发出（流中失败），不可重试。
#[tokio::test]
async fn stream_top_level_error_event_keeps_diagnostics() {
    let server = MockServer::start(|_req, stream| {
        let _ = sse_head(stream);
        // 先发一帧正常增量再失败：错误发生在流中而非连接期。
        let _ = stream.write_all(
            sse_data(r#"{"type":"response.output_text.delta","delta":"部分"}"#).as_bytes(),
        );
        let payload = serde_json::json!({
            "type": "error",
            "code": "server_error",
            "message": "The server had an error",
            "param": null,
            "sequence_number": 2
        });
        let _ = stream.write_all(sse_data(&payload.to_string()).as_bytes());
        let _ = stream.flush();
    });
    let (sink_tx, mut rx) = sink();
    let (_signal, cancel) = cancel_channel();
    let failure = client_with_api(&server.url(), retry_policy(2), ProviderApi::OpenAiResponses)
        .chat_stream(&messages(), IDS, sink_tx, &cancel, None)
        .await
        .expect_err("顶层 error 事件应失败");
    match &failure.error {
        LlmError::Protocol(reason) => {
            assert!(
                reason.contains("The server had an error"),
                "诊断信息须含顶层 message：{reason}"
            );
            assert!(reason.contains("server_error"), "诊断信息含顶层 code：{reason}");
        }
        other => panic!("应为 Protocol：{other:?}"),
    }
    assert_eq!(server.connection_count(), 1, "请求已发出，流中失败不可重试");
    let observed = drain(&mut rx);
    assert_eq!(observed.done, 0, "失败流不产 done");
    assert_eq!(observed.errors.len(), 1);
}

/// 非流式结构化调用：output 中 message item 的 output_text 部件拼接。
#[tokio::test]
async fn complete_json_joins_output_text() {
    let body = serde_json::json!({
        "id": "resp_1",
        "object": "response",
        "output": [
            { "type": "reasoning", "summary": [] },
            { "type": "message", "role": "assistant",
              "content": [
                  { "type": "output_text", "text": "结算：" },
                  { "type": "output_text", "text": "{\"ok\": true, \"n\": 3}" }
              ] }
        ],
        "usage": { "input_tokens": 5, "output_tokens": 9 }
    })
    .to_string();
    let server = MockServer::start(move |_req, stream| {
        let _ = json_raw_body(stream, &body);
    });
    let (_signal, _cancel) = cancel_channel();
    #[derive(Debug, PartialEq, serde::Deserialize)]
    struct Out {
        ok: bool,
        n: i32,
    }
    let out: Out = client_with_api(&server.url(), retry_policy(0), ProviderApi::OpenAiResponses)
        .complete_json(&messages(), None)
        .await
        .expect("output_text 拼接后应可提取 JSON");
    assert_eq!(out, Out { ok: true, n: 3 });
}

/// 非流式工具回路：function_call → ToolCalls；回传映射 function_call /
/// function_call_output items（call_id 回链），tools 为扁平形态。
#[tokio::test]
async fn function_call_to_tool_calls_and_output_request_mapping() {
    // 第一轮：function_call item → ToolCalls。
    let body = serde_json::json!({
        "id": "resp_1",
        "object": "response",
        "output": [
            { "type": "function_call", "call_id": "fc_1", "name": "search_memory",
              "arguments": "{\"query\": \"信物\"}" }
        ],
        "usage": { "input_tokens": 3, "output_tokens": 4 }
    })
    .to_string();
    let server = MockServer::start(move |_req, stream| {
        let _ = json_raw_body(stream, &body);
    });
    let (_signal, _cancel) = cancel_channel();
    let turn = client_with_api(&server.url(), retry_policy(0), ProviderApi::OpenAiResponses)
        .complete_with_tools(&messages(), &[memory_tool()], None)
        .await
        .expect("function_call 响应应解析成功");
    match turn {
        ToolLoopTurn::ToolCalls(calls) => {
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].id, "fc_1");
            assert_eq!(calls[0].name, "search_memory");
            assert_eq!(calls[0].arguments, r#"{"query": "信物"}"#, "arguments 原样透传");
        }
        other => panic!("应为 ToolCalls：{other:?}"),
    }

    // 回传映射：assistant tool_calls → function_call item，tool 结果 →
    // function_call_output item（call_id 回链）。
    let captured: Arc<Mutex<Option<MockRequest>>> = Arc::new(Mutex::new(None));
    let cap = captured.clone();
    let reply = serde_json::json!({
        "id": "resp_2",
        "object": "response",
        "output": [
            { "type": "message", "role": "assistant",
              "content": [{ "type": "output_text", "text": "找到了" }] }
        ],
        "usage": { "input_tokens": 6, "output_tokens": 2 }
    })
    .to_string();
    let server = MockServer::start(move |req, stream| {
        *cap.lock().unwrap() = Some(req.clone());
        let _ = json_raw_body(stream, &reply);
    });
    let conversation = vec![
        ChatMessage::new(ChatRole::User, "找一下"),
        ChatMessage::new(ChatRole::Assistant, "").with_tool_calls(vec![ToolCall {
            id: "fc_1".into(),
            name: "search_memory".into(),
            arguments: r#"{"query":"信物"}"#.into(),
        }]),
        ChatMessage::new(ChatRole::Tool, "检索结果……").with_tool_call_id("fc_1"),
    ];
    let turn = client_with_api(&server.url(), retry_policy(0), ProviderApi::OpenAiResponses)
        .complete_with_tools(&conversation, &[memory_tool()], None)
        .await
        .expect("回传轮应成功");
    assert_eq!(turn, ToolLoopTurn::Content("找到了".into()));

    let req = captured.lock().unwrap().clone().expect("应捕获到请求");
    assert_eq!(req.path, "/responses");
    let body = req.json();
    assert_eq!(
        body["tools"][0],
        serde_json::json!({
            "type": "function",
            "name": "search_memory",
            "description": "按关键词检索会话历史",
            "parameters": memory_tool().parameters,
        }),
        "Responses 扁平工具形态（无嵌套 function 包装）"
    );
    let input = body["input"].as_array().unwrap();
    assert_eq!(input.len(), 3, "三条消息各占一个 item");
    assert_eq!(
        input[1],
        serde_json::json!({
            "type": "function_call", "call_id": "fc_1",
            "name": "search_memory", "arguments": "{\"query\":\"信物\"}"
        }),
        "assistant tool_calls → function_call item"
    );
    assert_eq!(
        input[2],
        serde_json::json!({
            "type": "function_call_output", "call_id": "fc_1",
            "output": "检索结果……"
        }),
        "tool 结果 → function_call_output item"
    );
}

/// tool 消息缺 tool_call_id → 请求构造期 Protocol 错误（无法回链
/// function_call_output；构造期拦截，请求未发出）。
#[tokio::test]
async fn tool_message_without_tool_call_id_fails_before_request() {
    let server = MockServer::start(|_req, _stream| {
        panic!("不应发出请求：tool 消息缺 tool_call_id 应在构造期报错");
    });
    let (_signal, _cancel) = cancel_channel();
    let conversation = vec![ChatMessage::new(ChatRole::Tool, "孤儿结果")];
    let err = client_with_api(&server.url(), retry_policy(0), ProviderApi::OpenAiResponses)
        .complete_with_tools(&conversation, &[memory_tool()], None)
        .await
        .unwrap_err();
    assert!(
        matches!(err, LlmError::Protocol(ref m) if m.contains("无法回链")),
        "实际：{err:?}"
    );
    assert_eq!(server.connection_count(), 0, "构造期报错，请求未发出");
}
