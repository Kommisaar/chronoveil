//! Anthropic Messages 协议（provider_api = anthropic，2026-09-14）：
//! 流式（POST /v1/messages、x-api-key / anthropic-version 头、system 提升 + max_tokens、
//! thinking/text delta 分路、message_stop → Usage + Done、流内 error 帧 → Protocol
//! 不可重试）与非流式（complete_json 取 text 块拼接、complete_with_tools 的
//! tool_use → ToolCalls 与 tool_result 回传请求体映射）。

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

/// 流式正常路径：POST /v1/messages + x-api-key / anthropic-version（无 Bearer）；
/// system 提升 + max_tokens + messages 映射；thinking_delta → Reasoning、
/// text_delta → Token、message_stop → Done（usage 经 message_start / message_delta
/// 累积后在轨迹中可见）。
#[tokio::test]
async fn stream_request_shape_headers_and_events() {
    let captured: Arc<Mutex<Option<MockRequest>>> = Arc::new(Mutex::new(None));
    let cap = captured.clone();
    let server = MockServer::start(move |req, stream| {
        *cap.lock().unwrap() = Some(req.clone());
        let _ = sse_head(stream);
        for payload in [
            serde_json::json!({"type":"message_start","message":{"role":"assistant","usage":{"input_tokens":11}}}).to_string(),
            serde_json::json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"思考"}}).to_string(),
            serde_json::json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}).to_string(),
            serde_json::json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"，世界"}}).to_string(),
            serde_json::json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}).to_string(),
            serde_json::json!({"type":"message_stop"}).to_string(),
            // message_stop 之后的迟到帧：客户端见 Done 即提前 return，残余帧整体
            // 丢弃——下方 tokens 断言锁定不含「迟到的杂音」。
            serde_json::json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"迟到的杂音"}}).to_string(),
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
    let outcome = client_with_api(&server.url(), retry_policy(0), ProviderApi::Anthropic)
        .with_call_sink(collector.clone())
        .chat_stream(&messages, IDS, sink_tx, &cancel, Some(&trace))
        .await
        .expect("正常流不应失败");

    let req = captured.lock().unwrap().clone().expect("应捕获到请求");
    assert_eq!(req.path, "/v1/messages");
    assert_eq!(req.header("x-api-key"), Some("test-key"));
    assert_eq!(req.header("anthropic-version"), Some("2023-06-01"));
    assert_eq!(req.header("authorization"), None, "Anthropic 不用 Bearer");
    let body = req.json();
    assert_eq!(body["model"], "test-model");
    assert_eq!(body["max_tokens"], 8192, "Anthropic 必填参数（模块常量安全值）");
    assert_eq!(body["stream"], true);
    assert_eq!(body["system"], "你是助手", "System 提升为顶层 system 参数");
    let msgs = body["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 1, "system 不进 messages");
    assert_eq!(msgs[0]["role"], "user");
    assert_eq!(msgs[0]["content"], "你好");

    let observed = drain(&mut rx);
    assert_eq!(observed.reasoning, vec!["思考".to_string()], "thinking_delta 进思考通道");
    assert_eq!(observed.tokens, vec!["你好".to_string(), "，世界".to_string()]);
    assert_eq!(observed.done, 1, "message_stop → Done");
    assert!(observed.errors.is_empty());
    match outcome {
        StreamOutcome::Completed { content, reasoning, .. } => {
            assert_eq!(content, "你好，世界");
            assert_eq!(reasoning.as_deref(), Some("思考"));
        }
        other => panic!("应为 Completed：{other:?}"),
    }

    let records = records_of(&collector);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].prompt_tokens, Some(11), "message_start 的 input_tokens");
    assert_eq!(records[0].completion_tokens, Some(7), "message_delta 的 output_tokens");
    assert_eq!(records[0].status, LlmCallStatus::Ok);
}

/// 密钥为空 → 不发 x-api-key 头（与 OpenAI 路径「空密钥不附加认证头」同法）。
#[tokio::test]
async fn empty_api_key_omits_x_api_key_header() {
    let captured: Arc<Mutex<Option<MockRequest>>> = Arc::new(Mutex::new(None));
    let cap = captured.clone();
    let server = MockServer::start(move |req, stream| {
        *cap.lock().unwrap() = Some(req.clone());
        let _ = sse_head(stream);
        let _ = stream.write_all(sse_data(r#"{"type":"message_stop"}"#).as_bytes());
        let _ = stream.flush();
    });
    let llm = LlmClient::new(LlmConfig {
        base_url: server.url(),
        api_key: String::new(),
        model: "test-model".into(),
        api: ProviderApi::Anthropic,
        connect_timeout_ms: 2_000,
        read_timeout_ms: 2_000,
        retry: retry_policy(0),
    })
    .unwrap();
    let (sink_tx, _rx) = sink();
    let (_signal, cancel) = cancel_channel();
    llm.chat_stream(&messages(), IDS, sink_tx, &cancel, None)
        .await
        .expect("无密钥流不应失败");
    let req = captured.lock().unwrap().clone().expect("应捕获到请求");
    assert_eq!(req.header("x-api-key"), None, "空密钥不发 x-api-key");
    assert_eq!(req.header("anthropic-version"), Some("2023-06-01"), "版本头恒发");
}

/// 流内 error 事件帧 → Protocol 错误（不可重试：单次连接即失败）。
#[tokio::test]
async fn stream_error_frame_is_protocol_error_and_not_retried() {
    let server = MockServer::start(|_req, stream| {
        let _ = sse_head(stream);
        let payload = serde_json::json!({
            "type": "error",
            "error": { "type": "overloaded_error", "message": "Overloaded" }
        });
        let _ = stream.write_all(sse_data(&payload.to_string()).as_bytes());
        let _ = stream.flush();
    });
    let (sink_tx, mut rx) = sink();
    let (_signal, cancel) = cancel_channel();
    let failure = client_with_api(&server.url(), retry_policy(2), ProviderApi::Anthropic)
        .chat_stream(&messages(), IDS, sink_tx, &cancel, None)
        .await
        .expect_err("error 帧应失败");
    assert!(matches!(failure.error, LlmError::Protocol(_)), "实际：{:?}", failure.error);
    assert_eq!(server.connection_count(), 1, "Protocol 错误不可重试");
    let observed = drain(&mut rx);
    assert_eq!(observed.errors.len(), 1, "失败经事件面上报一次");
    assert!(observed.done == 0);
}

/// 非流式结构化调用：content 多个 text 块依序拼接后走容错 JSON 提取。
#[tokio::test]
async fn complete_json_joins_text_blocks() {
    let body = serde_json::json!({
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "content": [
            { "type": "text", "text": "结算结果：" },
            { "type": "text", "text": "{\"wins\": [1, 2, 3]}" }
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
        wins: Vec<i32>,
    }
    let out: Out = client_with_api(&server.url(), retry_policy(0), ProviderApi::Anthropic)
        .complete_json(&messages(), None)
        .await
        .expect("text 块拼接后应可提取 JSON");
    assert_eq!(out, Out { wins: vec![1, 2, 3] });
}

/// 非流式工具回路：tool_use → ToolCalls（input 序列化回 arguments 字符串）；
/// tool_result 回传请求体映射为 user 消息内的 tool_result block。
#[tokio::test]
async fn tool_use_to_tool_calls_and_tool_result_request_mapping() {
    // 第一轮：tool_use 块 → ToolCalls。
    let body = serde_json::json!({
        "type": "message",
        "role": "assistant",
        "content": [
            { "type": "tool_use", "id": "toolu_1", "name": "search_memory",
              "input": { "query": "信物" } }
        ],
        "usage": { "input_tokens": 3, "output_tokens": 4 }
    })
    .to_string();
    let server = MockServer::start(move |_req, stream| {
        let _ = json_raw_body(stream, &body);
    });
    let (_signal, _cancel) = cancel_channel();
    let turn = client_with_api(&server.url(), retry_policy(0), ProviderApi::Anthropic)
        .complete_with_tools(&messages(), &[memory_tool()], None)
        .await
        .expect("tool_use 响应应解析成功");
    match turn {
        ToolLoopTurn::ToolCalls(calls) => {
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].id, "toolu_1");
            assert_eq!(calls[0].name, "search_memory");
            assert_eq!(
                calls[0].arguments, r#"{"query":"信物"}"#,
                "input 对象序列化回 arguments 字符串"
            );
        }
        other => panic!("应为 ToolCalls：{other:?}"),
    }

    // 回传映射：assistant 的 tool_calls → tool_use 块，tool 结果 → user 消息内的
    // tool_result block（tool_use_id 回链）。
    let captured: Arc<Mutex<Option<MockRequest>>> = Arc::new(Mutex::new(None));
    let cap = captured.clone();
    let reply = serde_json::json!({
        "type": "message",
        "role": "assistant",
        "content": [{ "type": "text", "text": "找到了" }],
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
            id: "toolu_1".into(),
            name: "search_memory".into(),
            arguments: r#"{"query":"信物"}"#.into(),
        }]),
        ChatMessage::new(ChatRole::Tool, "检索结果……").with_tool_call_id("toolu_1"),
    ];
    let turn = client_with_api(&server.url(), retry_policy(0), ProviderApi::Anthropic)
        .complete_with_tools(&conversation, &[memory_tool()], None)
        .await
        .expect("回传轮应成功");
    assert_eq!(turn, ToolLoopTurn::Content("找到了".into()));

    let req = captured.lock().unwrap().clone().expect("应捕获到请求");
    assert_eq!(req.path, "/v1/messages");
    let body = req.json();
    assert_eq!(
        body["tools"][0],
        serde_json::json!({
            "name": "search_memory",
            "description": "按关键词检索会话历史",
            "input_schema": memory_tool().parameters,
        }),
        "Anthropic 扁平工具形态：input_schema 承载 JSON Schema"
    );
    let msgs = body["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 3, "三条消息各占一条（无 system 提升）");
    assert_eq!(
        msgs[1],
        serde_json::json!({
            "role": "assistant",
            "content": [{ "type": "tool_use", "id": "toolu_1", "name": "search_memory",
                          "input": { "query": "信物" } }]
        }),
        "assistant tool_calls → tool_use content block"
    );
    assert_eq!(
        msgs[2],
        serde_json::json!({
            "role": "user",
            "content": [{ "type": "tool_result", "tool_use_id": "toolu_1",
                          "content": "检索结果……" }]
        }),
        "tool 结果 → user 消息内的 tool_result block"
    );
}

/// 回传的 assistant tool_calls arguments 非法 JSON → 请求构造期 Protocol 错误
///（提前报错，连接都不建立；合法路径上 arguments 必为合法 JSON）。
#[tokio::test]
async fn invalid_tool_arguments_fail_before_request() {
    let server = MockServer::start(|_req, _stream| {
        panic!("不应发出请求：arguments 非法 JSON 应在构造期报错");
    });
    let (_signal, _cancel) = cancel_channel();
    let conversation = vec![ChatMessage::new(ChatRole::Assistant, "").with_tool_calls(vec![ToolCall {
        id: "toolu_bad".into(),
        name: "search_memory".into(),
        arguments: "not-json".into(),
    }])];
    let err = client_with_api(&server.url(), retry_policy(0), ProviderApi::Anthropic)
        .complete_with_tools(&conversation, &[memory_tool()], None)
        .await
        .unwrap_err();
    assert!(matches!(err, LlmError::Protocol(_)), "实际：{err:?}");
    assert_eq!(server.connection_count(), 0, "构造期报错，请求未发出");
}

/// tool 消息缺 tool_call_id → 请求构造期 Protocol 错误（无法回链 Anthropic
/// tool_result；构造期拦截，请求未发出）。
#[tokio::test]
async fn tool_message_without_tool_call_id_fails_before_request() {
    let server = MockServer::start(|_req, _stream| {
        panic!("不应发出请求：tool 消息缺 tool_call_id 应在构造期报错");
    });
    let (_signal, _cancel) = cancel_channel();
    let conversation = vec![ChatMessage::new(ChatRole::Tool, "孤儿结果")];
    let err = client_with_api(&server.url(), retry_policy(0), ProviderApi::Anthropic)
        .complete_with_tools(&conversation, &[memory_tool()], None)
        .await
        .unwrap_err();
    assert!(
        matches!(err, LlmError::Protocol(ref m) if m.contains("无法回链")),
        "实际：{err:?}"
    );
    assert_eq!(server.connection_count(), 0, "构造期报错，请求未发出");
}
