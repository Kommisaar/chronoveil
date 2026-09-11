//! CMP-002 集成测试（验收 2–8）：本地 mock HTTP 服务手写 SSE 字节流，
//! 覆盖正常流、字段型 reasoning、内联 think（半标签跨包）、断流重试、取消、错误映射（401/429/5xx/超时）、
//! 结构化 JSON helper 与分层/序列化形态。

use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::mpsc;

use super::mock::{delta_json, json_body, json_raw_body, MockRequest, MockServer, sse_data, sse_head, status_head};
use super::*;

const IDS: MessageIds = MessageIds { session_id: 7, message_id: 42 };

/// mpsc 收集器：验证「事件经抽象回调发射」（验收 4）。
struct MpscSink(mpsc::UnboundedSender<LlmEvent>);

impl EventSink for MpscSink {
    fn emit(&self, event: LlmEvent) {
        let _ = self.0.send(event);
    }
}

fn sink() -> (Arc<dyn EventSink>, mpsc::UnboundedReceiver<LlmEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (Arc::new(MpscSink(tx)), rx)
}

fn messages() -> Vec<ChatMessage> {
    vec![ChatMessage::new(ChatRole::User, "你好")]
}

/// 测试用重试策略：零退避、次数可调。
fn retry_policy(max_retries: u32) -> RetryPolicy {
    RetryPolicy { max_retries, initial_backoff_ms: 0, backoff_multiplier: 1, max_backoff_ms: 0 }
}

fn client(url: &str, retry: RetryPolicy) -> LlmClient {
    client_with_read_timeout(url, retry, 2_000)
}

fn client_with_read_timeout(url: &str, retry: RetryPolicy, read_timeout_ms: u64) -> LlmClient {
    LlmClient::new(LlmConfig {
        base_url: url.to_owned(),
        api_key: "test-key".into(),
        model: "test-model".into(),
        connect_timeout_ms: 2_000,
        read_timeout_ms,
        retry,
    })
    .unwrap()
}

/// 事件快照：token/reasoning 带 reset 标，done 带 think_ms，error 带 reason/interrupted。
#[derive(Default)]
struct Observed {
    tokens: Vec<(String, bool)>,
    reasoning: Vec<(String, bool)>,
    done: Vec<Option<u64>>,
    errors: Vec<(String, bool)>,
}

fn drain(rx: &mut mpsc::UnboundedReceiver<LlmEvent>) -> Observed {
    let mut observed = Observed::default();
    while let Ok(event) = rx.try_recv() {
        match event {
            LlmEvent::Token { text, reset, .. } => observed.tokens.push((text, reset)),
            LlmEvent::Reasoning { text, reset, .. } => observed.reasoning.push((text, reset)),
            LlmEvent::Done { think_ms, .. } => observed.done.push(think_ms),
            LlmEvent::Error { reason, interrupted, .. } => observed.errors.push((reason, interrupted)),
        }
    }
    observed
}

/// 验收 2 + 4：正常流；POST {base}/chat/completions + stream:true + Bearer；
/// content→正文、reasoning_content→思考，未知字段/无增量块优雅忽略；done 终态携 think_ms。
#[tokio::test]
async fn normal_stream_routes_content_reasoning_and_ignores_unknowns() {
    let captured: Arc<Mutex<Option<MockRequest>>> = Arc::new(Mutex::new(None));
    let cap = captured.clone();
    let server = MockServer::start(move |req, stream| {
        *cap.lock().unwrap() = Some(req.clone());
        let _ = sse_head(stream);
        let payloads: Vec<String> = vec![
            delta_json(None, Some("开始思考")),
            r#"{"choices":[{"delta":{"role":"assistant"}}]}"#.to_string(), // 无增量 → 忽略
            delta_json(Some("你好"), None),
            r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#.to_string(), // 终止块 → 忽略
            delta_json(Some("，世界"), None),
        ];
        for payload in &payloads {
            let _ = stream.write_all(sse_data(payload).as_bytes());
        }
        let _ = stream.write_all(sse_data("[DONE]").as_bytes());
        let _ = stream.flush();
    });

    let (sink_tx, mut rx) = sink();
    let (_signal, cancel) = cancel_channel();
    let outcome = client(&server.url(), retry_policy(0))
        .chat_stream(&messages(), IDS, sink_tx, &cancel)
        .await
        .expect("正常流不应失败");

    let req = captured.lock().unwrap().clone().expect("应捕获到请求");
    assert_eq!(req.path, "/chat/completions");
    assert_eq!(req.header("authorization"), Some("Bearer test-key"));
    let body = req.json();
    assert_eq!(body["model"], "test-model");
    assert_eq!(body["stream"], true);
    assert_eq!(body["messages"][0]["role"], "user");
    assert_eq!(body["messages"][0]["content"], "你好");

    let observed = drain(&mut rx);
    assert_eq!(observed.tokens, vec![("你好".to_string(), false), ("，世界".to_string(), false)]);
    assert_eq!(observed.reasoning, vec![("开始思考".to_string(), false)]);
    assert_eq!(observed.done.len(), 1, "应恰好一个 done 终态");
    assert!(observed.done[0].is_some(), "有 reasoning → think_ms 应有值");
    assert!(observed.errors.is_empty());

    match outcome {
        StreamOutcome::Completed { content, reasoning, think_ms } => {
            assert_eq!(content, "你好，世界");
            assert_eq!(reasoning.as_deref(), Some("开始思考"));
            assert!(think_ms.is_some());
        }
        other => panic!("应为 Completed：{other:?}"),
    }
}

/// 验收 3：内联 `<think>` 走状态机——半标签跨 SSE 事件到达（`<thi` + `ink>`），标签不进正文。
#[tokio::test]
async fn inline_think_tags_split_across_sse_events() {
    let server = MockServer::start(move |_req, stream| {
        let _ = sse_head(stream);
        for payload in [
            delta_json(Some("<thi"), None),
            delta_json(Some("nk>深度"), None),
            delta_json(Some("思考</thi"), None),
            delta_json(Some("nk>正文"), None),
        ] {
            let _ = stream.write_all(sse_data(&payload).as_bytes());
        }
        let _ = stream.write_all(sse_data("[DONE]").as_bytes());
        let _ = stream.flush();
    });

    let (sink_tx, mut rx) = sink();
    let (_signal, cancel) = cancel_channel();
    let outcome = client(&server.url(), retry_policy(0))
        .chat_stream(&messages(), IDS, sink_tx, &cancel)
        .await
        .unwrap();

    let observed = drain(&mut rx);
    let tokens: String = observed.tokens.into_iter().map(|(d, _)| d).collect();
    let reasoning: String = observed.reasoning.into_iter().map(|(d, _)| d).collect();
    assert_eq!(tokens, "正文", "标签与思考内容不得混入正文");
    assert_eq!(reasoning, "深度思考");
    match outcome {
        StreamOutcome::Completed { content, reasoning, think_ms } => {
            assert_eq!(content, "正文");
            assert_eq!(reasoning.as_deref(), Some("深度思考"));
            assert!(think_ms.is_some(), "内联 think 同样计时");
        }
        other => panic!("应为 Completed：{other:?}"),
    }
}

/// 验收 5：断流按整条重发；重发尝试首事件 reset=true（新内容替换旧半条）。
#[tokio::test]
async fn stream_break_resends_whole_message_and_replaces() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let n = attempts.clone();
    let server = MockServer::start(move |_req, stream| {
        if n.fetch_add(1, Ordering::SeqCst) == 0 {
            // 第一次：发出半条后直接关连接（无 [DONE]）→ 断流。
            let _ = sse_head(stream);
            let _ = stream.write_all(sse_data(&delta_json(Some("半条"), None)).as_bytes());
            let _ = stream.flush();
            return;
        }
        // 第二次：整条重发成功。
        let _ = sse_head(stream);
        for payload in [delta_json(Some("重发"), None), delta_json(Some("完整"), None)] {
            let _ = stream.write_all(sse_data(&payload).as_bytes());
        }
        let _ = stream.write_all(sse_data("[DONE]").as_bytes());
        let _ = stream.flush();
    });

    let (sink_tx, mut rx) = sink();
    let (_signal, cancel) = cancel_channel();
    let outcome = client(&server.url(), retry_policy(2))
        .chat_stream(&messages(), IDS, sink_tx, &cancel)
        .await
        .expect("第二次尝试应成功");

    assert_eq!(server.connection_count(), 2, "断流后应新建连接重发");
    let observed = drain(&mut rx);
    assert_eq!(
        observed.tokens,
        vec![
            ("半条".to_string(), false),
            ("重发".to_string(), true), // 重发首事件：reset=true
            ("完整".to_string(), false),
        ]
    );
    assert!(observed.errors.is_empty(), "重试成功不得上报 error 终态");
    assert_eq!(observed.done.len(), 1);
    match outcome {
        StreamOutcome::Completed { content, .. } => assert_eq!(content, "重发完整"),
        other => panic!("应为 Completed：{other:?}"),
    }
}

/// 验收 5：重试上限用尽 → 恰好一个 error 终态（interrupted=true），半条随返回值交给调用方落库。
#[tokio::test]
async fn retries_exhausted_emits_single_error_event() {
    let server = MockServer::start(move |_req, stream| {
        // 每次都断流。
        let _ = sse_head(stream);
        let _ = stream.write_all(sse_data(&delta_json(Some("半条"), None)).as_bytes());
        let _ = stream.flush();
    });

    let (sink_tx, mut rx) = sink();
    let (_signal, cancel) = cancel_channel();
    let failure = client(&server.url(), retry_policy(1))
        .chat_stream(&messages(), IDS, sink_tx, &cancel)
        .await
        .expect_err("重试用尽应失败");

    assert_eq!(server.connection_count(), 2, "1 次重试 = 共 2 次尝试");
    assert!(matches!(failure.error, LlmError::Network(_)), "断流映射为 Network：{:?}", failure.error);
    assert_eq!(failure.partial_content, "半条", "返回最后一次尝试的半条");
    assert_eq!(failure.partial_reasoning, None);

    let observed = drain(&mut rx);
    assert_eq!(
        observed.tokens.iter().map(|(d, _)| d.as_str()).collect::<Vec<_>>(),
        vec!["半条", "半条"],
        "两次尝试各发出半条 token"
    );
    assert!(observed.tokens[1].1, "重发尝试首事件应带 reset=true");
    assert!(observed.done.is_empty(), "失败不得有 done");
    assert_eq!(observed.errors.len(), 1, "恰好一个 error 终态");
    assert!(observed.errors[0].1, "已有半条 → interrupted=true");
}

/// 验收 6：cancel 立即中断连接与后续事件发射，不再产生事件。
#[tokio::test]
async fn cancel_stops_stream_and_emits_nothing_more() {
    let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
    // std mpsc 的 Receiver 非 Sync，包一层 Arc<Mutex<>> 才能进 handler 闭包。
    let go_rx = Arc::new(Mutex::new(go_rx));
    let go = go_rx.clone();
    let server = MockServer::start(move |_req, stream| {
        let _ = sse_head(stream);
        let _ = stream.write_all(sse_data(&delta_json(Some("第一"), None)).as_bytes());
        let _ = stream.flush();
        let _ = go.lock().unwrap().recv(); // 等测试确认取消已发起，再发后续字节
        let _ = stream.write_all(sse_data(&delta_json(Some("取消后不应到达"), None)).as_bytes());
        let _ = stream.write_all(sse_data("[DONE]").as_bytes());
        let _ = stream.flush();
    });

    let (sink_tx, mut rx) = sink();
    let (signal, cancel) = cancel_channel();
    let c = client(&server.url(), retry_policy(0));
    let task = tokio::spawn(async move { c.chat_stream(&messages(), IDS, sink_tx, &cancel).await });

    let first = rx.recv().await.expect("应先收到首个 token");
    match &first {
        LlmEvent::Token { text, reset, .. } => {
            assert_eq!(text, "第一");
            assert!(!*reset);
        }
        other => panic!("首个事件应为 token：{other:?}"),
    }

    signal.cancel();
    go_tx.send(()).unwrap();

    let outcome = task.await.unwrap().expect("取消不算失败");
    match outcome {
        StreamOutcome::Cancelled { partial_content, partial_reasoning } => {
            assert_eq!(partial_content, "第一", "半条随取消返回，供调用方按 ADR-001 落库");
            assert_eq!(partial_reasoning, None);
        }
        other => panic!("应为 Cancelled：{other:?}"),
    }

    // 取消点之后不得再有任何事件。
    std::thread::sleep(Duration::from_millis(150));
    assert!(rx.try_recv().is_err(), "取消后不得再有事件");
}

/// 验收 8：401 映射 Unauthorized 且不重试。
#[tokio::test]
async fn unauthorized_401_maps_and_is_not_retried() {
    let server = MockServer::start(move |_req, stream| {
        let _ = status_head(stream, 401, "Unauthorized");
    });
    let (sink_tx, mut rx) = sink();
    let (_signal, cancel) = cancel_channel();
    let failure = client(&server.url(), retry_policy(3))
        .chat_stream(&messages(), IDS, sink_tx, &cancel)
        .await
        .unwrap_err();
    assert_eq!(failure.error, LlmError::Unauthorized);
    assert_eq!(server.connection_count(), 1, "401 不重试");
    let observed = drain(&mut rx);
    assert_eq!(observed.errors.len(), 1);
    assert!(!observed.errors[0].1, "无半条 → interrupted=false");
    assert!(observed.done.is_empty());
}

/// 验收 8：429 映射 RateLimited 且可重试（重试用尽后失败）。
#[tokio::test]
async fn rate_limited_429_is_retried() {
    let server = MockServer::start(move |_req, stream| {
        let _ = status_head(stream, 429, "Too Many Requests");
    });
    let (sink_tx, mut rx) = sink();
    let (_signal, cancel) = cancel_channel();
    let failure = client(&server.url(), retry_policy(1))
        .chat_stream(&messages(), IDS, sink_tx, &cancel)
        .await
        .unwrap_err();
    assert_eq!(failure.error, LlmError::RateLimited);
    assert_eq!(server.connection_count(), 2, "429 可重试一次");
    let observed = drain(&mut rx);
    assert_eq!(observed.errors.len(), 1);
}

/// 验收 8：5xx 映射 Status{500} 且可重试。
#[tokio::test]
async fn server_error_500_maps_to_status_and_retries() {
    let server = MockServer::start(move |_req, stream| {
        let _ = status_head(stream, 500, "Internal Server Error");
    });
    let (sink_tx, _rx) = sink();
    let (_signal, cancel) = cancel_channel();
    let failure = client(&server.url(), retry_policy(1))
        .chat_stream(&messages(), IDS, sink_tx, &cancel)
        .await
        .unwrap_err();
    assert!(matches!(failure.error, LlmError::Status { status: 500, .. }));
    assert_eq!(server.connection_count(), 2, "5xx 可重试一次");
}

/// 验收 8：读超时映射 Timeout。
#[tokio::test]
async fn read_timeout_maps_to_timeout_error() {
    let server = MockServer::start(move |_req, _stream| {
        // 收到请求后装死不写字节，逼出读空闲超时。
        std::thread::sleep(Duration::from_millis(2_000));
    });
    let (sink_tx, _rx) = sink();
    let (_signal, cancel) = cancel_channel();
    let failure = client_with_read_timeout(&server.url(), retry_policy(0), 300)
        .chat_stream(&messages(), IDS, sink_tx, &cancel)
        .await
        .unwrap_err();
    assert_eq!(failure.error, LlmError::Timeout);
}

/// 连接失败映射可重试错误。（本机防火墙下连接拒绝可能表现为 connect 超时，两者均为预期映射。）
#[tokio::test]
async fn connect_failure_maps_to_retryable_error() {
    let (sink_tx, _rx) = sink();
    let (_signal, cancel) = cancel_channel();
    let failure = client("http://127.0.0.1:1", retry_policy(0))
        .chat_stream(&messages(), IDS, sink_tx, &cancel)
        .await
        .unwrap_err();
    assert!(
        matches!(failure.error, LlmError::Network(_) | LlmError::Timeout),
        "实际错误：{:?}",
        failure.error
    );
}

/// 验收 7：结构化 JSON helper——容忍 ```json 围栏与前后杂文。
#[tokio::test]
async fn complete_json_tolerates_fences_and_loose_text() {
    #[derive(Debug, PartialEq, serde::Deserialize)]
    struct Out {
        ok: bool,
        n: i32,
    }

    let fenced = MockServer::start(move |_req, stream| {
        let _ = json_body(stream, "```json\n{\"ok\": true, \"n\": 3}\n```");
    });
    let (_signal, _cancel) = cancel_channel();
    let out: Out = client(&fenced.url(), retry_policy(0))
        .complete_json(&messages())
        .await
        .expect("围栏 JSON 应可解析");
    assert_eq!(out, Out { ok: true, n: 3 });

    let loose = MockServer::start(move |_req, stream| {
        let _ = json_body(stream, "结算结果如下：{\"wins\": [1, 2, 3]} 以上。");
    });
    let value: Value = client(&loose.url(), retry_policy(0))
        .complete_json(&messages())
        .await
        .expect("杂文包裹的 JSON 应可提取");
    assert_eq!(value["wins"][2], 3);
}

/// 验收 7：JSON helper 失败返回可判断错误；且结构化调用必须是非流式请求。
#[tokio::test]
async fn complete_json_failure_is_detectable_and_non_stream() {
    let captured: Arc<Mutex<Option<MockRequest>>> = Arc::new(Mutex::new(None));
    let cap = captured.clone();
    let garbage = MockServer::start(move |req, stream| {
        *cap.lock().unwrap() = Some(req.clone());
        let _ = json_body(stream, "抱歉，我无法按 JSON 输出。");
    });
    let (_signal, _cancel) = cancel_channel();
    let err = client(&garbage.url(), retry_policy(0))
        .complete_json::<Value>(&messages())
        .await
        .unwrap_err();
    assert!(matches!(err, LlmError::Json(_)), "失败应可判断：{err:?}");

    let req = captured.lock().unwrap().clone().expect("应捕获到请求");
    assert_eq!(req.path, "/chat/completions");
    assert_eq!(req.json()["stream"], false, "结构化调用为非流式一次性请求");
}

/// 验收 4：事件序列化形态（INT-001 契约：token/reasoning 负载为 text，OQ-004 对齐后直通 Tauri 事件通道）。
#[test]
fn event_payload_shape_matches_int001_contract() {
    let value = serde_json::to_value(LlmEvent::Token {
        session_id: 1,
        message_id: 2,
        text: "x".into(),
        reset: true,
    })
    .unwrap();
    assert_eq!(value["type"], "token");
    assert_eq!(value["session_id"], 1);
    assert_eq!(value["message_id"], 2);
    assert_eq!(value["text"], "x");
    assert_eq!(value["reset"], true);

    let value = serde_json::to_value(LlmEvent::Done {
        session_id: 1,
        message_id: 2,
        think_ms: Some(99),
    })
    .unwrap();
    assert_eq!(value["type"], "done");
    assert_eq!(value["think_ms"], 99);

    let value = serde_json::to_value(LlmEvent::Error {
        session_id: 1,
        message_id: 2,
        reason: "boom".into(),
        interrupted: true,
    })
    .unwrap();
    assert_eq!(value["type"], "error");
    assert_eq!(value["reason"], "boom");
    assert_eq!(value["interrupted"], true);
}

/// 配置校验：缺 base_url / model 在构造期即报 Config。
#[test]
fn config_validation_rejects_empty_fields() {
    let err = LlmClient::new(LlmConfig { base_url: String::new(), ..Default::default() }).unwrap_err();
    assert!(matches!(err, LlmError::Config(_)));
    let err = LlmClient::new(LlmConfig {
        base_url: "http://x".into(),
        model: String::new(),
        ..Default::default()
    })
    .unwrap_err();
    assert!(matches!(err, LlmError::Config(_)));
}

// ---------------------------------------------------------------------------
// 工具调用底座（OpenAI 兼容 tools / tool_calls）：Tool 角色 wire、tools 条件携带、
// 既有无工具请求形态零变化、tool_calls 解析、content 回落、协议边界与重试。
// ---------------------------------------------------------------------------

/// 测试用工具定义（JSON Schema 形态 parameters）。
fn memory_tool() -> ToolSpec {
    ToolSpec {
        name: "search_memory".into(),
        description: "按关键词检索会话历史".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": { "query": { "type": "string" } },
            "required": ["query"],
        }),
    }
}

/// Tool 角色序列化为 "tool"（既有三值不变）；tool 消息携带 tool_call_id、
/// assistant 消息携带 tool_calls（id / type / function.name / function.arguments 三段式）；
/// 普通消息恰好 role + content 两键，不因新增字段多出空键。
#[tokio::test]
async fn tool_role_and_message_fields_wire_shape() {
    assert_eq!(ChatRole::System.as_str(), "system");
    assert_eq!(ChatRole::User.as_str(), "user");
    assert_eq!(ChatRole::Assistant.as_str(), "assistant");
    assert_eq!(ChatRole::Tool.as_str(), "tool");

    let captured: Arc<Mutex<Option<MockRequest>>> = Arc::new(Mutex::new(None));
    let cap = captured.clone();
    let server = MockServer::start(move |req, stream| {
        *cap.lock().unwrap() = Some(req.clone());
        let _ = json_body(stream, "\"ok\"");
    });
    let messages = vec![
        ChatMessage::new(ChatRole::User, "找一下"),
        ChatMessage::new(ChatRole::Assistant, "")
            .with_tool_calls(vec![ToolCall {
                id: "call_1".into(),
                name: "search_memory".into(),
                arguments: r#"{"query":"信物"}"#.into(),
            }]),
        ChatMessage::new(ChatRole::Tool, "检索结果……").with_tool_call_id("call_1"),
    ];
    let (_signal, _cancel) = cancel_channel();
    let _: Value = client(&server.url(), retry_policy(0))
        .complete_json(&messages)
        .await
        .expect("仅捕获请求体，响应为合法 JSON 应成功");

    let body = captured.lock().unwrap().clone().expect("应捕获到请求").json();
    let msgs = body["messages"].as_array().unwrap().clone();
    assert_eq!(msgs.len(), 3);

    // 普通消息：恰好 role + content 两键（与旧 wire 形态逐字段一致）。
    assert_eq!(msgs[0]["role"], "user");
    assert_eq!(msgs[0]["content"], "找一下");
    assert_eq!(msgs[0].as_object().unwrap().len(), 2, "普通消息不得多出空键");

    // assistant 工具调用消息：tool_calls 三段式，arguments 为 JSON 字符串原样。
    assert_eq!(msgs[1]["role"], "assistant");
    assert_eq!(msgs[1]["tool_calls"][0]["id"], "call_1");
    assert_eq!(msgs[1]["tool_calls"][0]["type"], "function");
    assert_eq!(msgs[1]["tool_calls"][0]["function"]["name"], "search_memory");
    assert_eq!(
        msgs[1]["tool_calls"][0]["function"]["arguments"],
        r#"{"query":"信物"}"#
    );
    assert!(msgs[1].get("tool_call_id").is_none(), "assistant 消息不带 tool_call_id 键");

    // tool 角色消息：序列化为 "tool" 并携带 tool_call_id，不带 tool_calls 键。
    assert_eq!(msgs[2]["role"], "tool");
    assert_eq!(msgs[2]["tool_call_id"], "call_1");
    assert_eq!(msgs[2]["content"], "检索结果……");
    assert!(msgs[2].get("tool_calls").is_none());
}

/// 既有无工具请求 wire 形态零变化：顶层恰好 model / messages / stream 三键，
/// 无 tools / tool_choice；消息恰好 role / content 两键。
#[tokio::test]
async fn plain_request_wire_shape_unchanged() {
    let captured: Arc<Mutex<Option<MockRequest>>> = Arc::new(Mutex::new(None));
    let cap = captured.clone();
    let server = MockServer::start(move |req, stream| {
        *cap.lock().unwrap() = Some(req.clone());
        let _ = json_body(stream, "\"ok\"");
    });
    let (_signal, _cancel) = cancel_channel();
    let _: Value = client(&server.url(), retry_policy(0))
        .complete_json(&messages())
        .await
        .expect("纯 JSON 响应应成功");

    let body = captured.lock().unwrap().clone().expect("应捕获到请求").json();
    let top = body.as_object().unwrap();
    assert_eq!(top.len(), 3, "顶层键集合不得变化：{top:?}");
    assert_eq!(body["model"], "test-model");
    assert_eq!(body["stream"], false);
    assert_eq!(body["messages"][0].as_object().unwrap().len(), 2, "消息键集合不得变化");
    assert_eq!(body["messages"][0]["role"], "user");
    assert_eq!(body["messages"][0]["content"], "你好");
}

/// tools 仅在提供时携带：complete_with_tools 请求体带 tools（type=function 三段式），
/// 未提供 tool_choice 不携带；请求为非流式。
#[tokio::test]
async fn tools_in_request_only_when_provided() {
    let captured: Arc<Mutex<Option<MockRequest>>> = Arc::new(Mutex::new(None));
    let cap = captured.clone();
    let server = MockServer::start(move |req, stream| {
        *cap.lock().unwrap() = Some(req.clone());
        let _ = json_body(stream, "直接回答");
    });
    let (_signal, _cancel) = cancel_channel();
    let turn = client(&server.url(), retry_policy(0))
        .complete_with_tools(&messages(), &[memory_tool()])
        .await
        .expect("纯正文响应应成功");
    assert!(matches!(turn, ToolLoopTurn::Content(_)));

    let body = captured.lock().unwrap().clone().expect("应捕获到请求").json();
    let tools = body["tools"].as_array().expect("应携带 tools 数组").clone();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["type"], "function");
    assert_eq!(tools[0]["function"]["name"], "search_memory");
    assert_eq!(tools[0]["function"]["description"], "按关键词检索会话历史");
    assert_eq!(tools[0]["function"]["parameters"]["type"], "object");
    assert_eq!(tools[0]["function"]["parameters"]["required"][0], "query");
    assert!(body.get("tool_choice").is_none(), "未提供 tool_choice 不得携带");
    assert_eq!(body["stream"], false, "工具回路为非流式请求");
}

/// tool_calls 响应解析：多条调用逐一解析 id / name / arguments，
/// arguments 按 JSON 字符串原样透传（不在此解析）。
#[tokio::test]
async fn tool_calls_response_parses_with_string_arguments() {
    let body = concat!(
        r#"{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":["#,
        r#"{"id":"call_a","type":"function","function":{"name":"search_memory","arguments":"{\"query\": \"信物\", \"limit\": 3}"}},"#,
        r#"{"id":"call_b","type":"function","function":{"name":"search_memory","arguments":"{}"}}"#,
        r#"]}}]}"#
    );
    let server = MockServer::start(move |_req, stream| {
        let _ = json_raw_body(stream, body);
    });
    let (_signal, _cancel) = cancel_channel();
    let turn = client(&server.url(), retry_policy(0))
        .complete_with_tools(&messages(), &[memory_tool()])
        .await
        .expect("工具调用响应应解析成功");
    match turn {
        ToolLoopTurn::ToolCalls(calls) => {
            assert_eq!(calls.len(), 2);
            assert_eq!(calls[0].id, "call_a");
            assert_eq!(calls[0].name, "search_memory");
            assert_eq!(
                calls[0].arguments, r#"{"query": "信物", "limit": 3}"#,
                "arguments 按原始 JSON 字符串透传"
            );
            assert_eq!(calls[1].id, "call_b");
            assert_eq!(calls[1].arguments, "{}");
        }
        other => panic!("应为 ToolCalls：{other:?}"),
    }
}

/// 纯 content 响应走 Content 分支；tool_calls 缺失与空数组两种边界同归正文。
#[tokio::test]
async fn content_response_and_empty_tool_calls_fallback() {
    // 1) tool_calls 缺失：直接正文。
    let plain = r#"{"choices":[{"message":{"role":"assistant","content":"直接回答"}}]}"#;
    let server = MockServer::start(move |_req, stream| {
        let _ = json_raw_body(stream, plain);
    });
    let (_signal, _cancel) = cancel_channel();
    let turn = client(&server.url(), retry_policy(0))
        .complete_with_tools(&messages(), &[memory_tool()])
        .await
        .expect("纯正文响应应成功");
    assert_eq!(turn, ToolLoopTurn::Content("直接回答".into()));

    // 2) tool_calls 为空数组：同样回落正文。
    let empty = r#"{"choices":[{"message":{"role":"assistant","content":"空数组也走正文","tool_calls":[]}}]}"#;
    let server = MockServer::start(move |_req, stream| {
        let _ = json_raw_body(stream, empty);
    });
    let turn = client(&server.url(), retry_policy(0))
        .complete_with_tools(&messages(), &[memory_tool()])
        .await
        .expect("空 tool_calls 应回落正文");
    assert_eq!(turn, ToolLoopTurn::Content("空数组也走正文".into()));
}

/// content 与 tool_calls 皆缺 → Protocol 错误可判别（不可重试，单次连接）。
#[tokio::test]
async fn missing_content_and_tool_calls_is_protocol_error() {
    let server = MockServer::start(move |_req, stream| {
        let _ = json_raw_body(stream, r#"{"choices":[{"message":{"role":"assistant"}}]}"#);
    });
    let (_signal, _cancel) = cancel_channel();
    let err = client(&server.url(), retry_policy(3))
        .complete_with_tools(&messages(), &[memory_tool()])
        .await
        .unwrap_err();
    assert!(matches!(err, LlmError::Protocol(_)), "失败应可判断：{err:?}");
    assert_eq!(server.connection_count(), 1, "Protocol 错误不可重试");
}

/// 可重试失败（5xx）按整条消息重发：第一次 500、第二次成功 → 共 2 次连接（仿既有断流重试测试）。
#[tokio::test]
async fn complete_with_tools_retries_retryable_failure() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let n = attempts.clone();
    let server = MockServer::start(move |_req, stream| {
        if n.fetch_add(1, Ordering::SeqCst) == 0 {
            let _ = status_head(stream, 500, "Internal Server Error");
            return;
        }
        let _ = json_body(stream, "重试后正文");
    });
    let (_signal, _cancel) = cancel_channel();
    let turn = client(&server.url(), retry_policy(1))
        .complete_with_tools(&messages(), &[memory_tool()])
        .await
        .expect("第二次尝试应成功");
    assert_eq!(turn, ToolLoopTurn::Content("重试后正文".into()));
    assert_eq!(server.connection_count(), 2, "5xx 应整条重发一次");
}

// ---------------------------------------------------------------------------
// 上轮 review 的 LOW 跟进（Task-05 顺手加固）：重试耗尽终态、content/tool_calls
// 并存优先级、tool_choice 嵌套随附条件（含空工具切片下线）。
// ---------------------------------------------------------------------------

/// LOW 1：complete_with_tools 重试耗尽 → Err（持续 5xx + retry_policy(1) = 恰好 2 次连接，
/// 错误可判别为 Status{500}）——工具回路没有事件面，最终失败只能以 Err 交给调用方。
#[tokio::test]
async fn complete_with_tools_retries_exhausted_returns_err() {
    let server = MockServer::start(move |_req, stream| {
        let _ = status_head(stream, 500, "Internal Server Error");
    });
    let (_signal, _cancel) = cancel_channel();
    let error = client(&server.url(), retry_policy(1))
        .complete_with_tools(&messages(), &[memory_tool()])
        .await
        .expect_err("持续 5xx 重试耗尽应失败");
    assert!(
        matches!(error, LlmError::Status { status: 500, .. }),
        "错误可判别：{error:?}"
    );
    assert_eq!(server.connection_count(), 2, "1 次重试 = 共 2 次尝试");
}

/// LOW 2：content 与 tool_calls 并存 → 优先 ToolCalls（content 不混入返回值）——
/// OpenAI 兼容语义：带 tool_calls 的 assistant 消息 content 通常为空或仅有陪跑文本，
/// 回路以 tool_calls 为准，content 丢弃。
#[tokio::test]
async fn content_alongside_tool_calls_prefers_tool_calls() {
    let body = concat!(
        r#"{"choices":[{"message":{"role":"assistant","content":"陪跑正文","#,
        r#""tool_calls":[{"id":"call_x","type":"function","#,
        r#""function":{"name":"search_memory","arguments":"{\"query\":\"信物\"}"}}]}}]}"#
    );
    let server = MockServer::start(move |_req, stream| {
        let _ = json_raw_body(stream, body);
    });
    let (_signal, _cancel) = cancel_channel();
    let turn = client(&server.url(), retry_policy(0))
        .complete_with_tools(&messages(), &[memory_tool()])
        .await
        .expect("并存形态应解析成功");
    match turn {
        ToolLoopTurn::ToolCalls(calls) => {
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].id, "call_x");
            assert_eq!(calls[0].name, "search_memory");
        }
        other => panic!("并存时优先 ToolCalls：{other:?}"),
    }
}

/// LOW 3：tool_choice 的嵌套随附条件（构造层现状）——`tool_choice` 只在 `tools`
/// 存在时才可能随附（chat_request_with_options 的嵌套 if），complete_with_tools
/// 不暴露 tool_choice → 请求体恒无该键；空工具切片视同未提供（无 tools 键，
/// 顶层键集合与无工具请求一致）。
#[tokio::test]
async fn tool_choice_never_rides_without_tools_and_empty_slice_omits_tools() {
    // 空工具切片：tools / tool_choice 都不发，顶层恰好 model / messages / stream 三键。
    let captured: Arc<Mutex<Option<MockRequest>>> = Arc::new(Mutex::new(None));
    let cap = captured.clone();
    let empty = MockServer::start(move |req, stream| {
        *cap.lock().unwrap() = Some(req.clone());
        let _ = json_body(stream, "收尾正文");
    });
    let (_signal, _cancel) = cancel_channel();
    let turn = client(&empty.url(), retry_policy(0))
        .complete_with_tools(&messages(), &[])
        .await
        .expect("空工具切片应等同无工具请求");
    assert_eq!(turn, ToolLoopTurn::Content("收尾正文".into()));
    let body = captured.lock().unwrap().clone().expect("应捕获到请求").json();
    let top = body.as_object().unwrap();
    assert_eq!(top.len(), 3, "顶层键集合与无工具请求一致：{top:?}");
    assert!(body.get("tools").is_none(), "空切片不得发空 tools 数组");
    assert!(body.get("tool_choice").is_none(), "无 tools 时 tool_choice 恒不随附");

    // 对照：提供工具时 tools 随附，但未显式提供 tool_choice 仍不携带（嵌套条件的
    // 外层成立、内层不成立 → 键缺省不发）。
    let captured: Arc<Mutex<Option<MockRequest>>> = Arc::new(Mutex::new(None));
    let cap = captured.clone();
    let with_tools = MockServer::start(move |req, stream| {
        *cap.lock().unwrap() = Some(req.clone());
        let _ = json_body(stream, "正文");
    });
    let turn = client(&with_tools.url(), retry_policy(0))
        .complete_with_tools(&messages(), &[memory_tool()])
        .await
        .expect("带工具请求应成功");
    assert!(matches!(turn, ToolLoopTurn::Content(_)));
    let body = captured.lock().unwrap().clone().expect("应捕获到请求").json();
    assert!(body["tools"].as_array().is_some(), "提供工具时 tools 随附");
    assert!(body.get("tool_choice").is_none(), "构造层未暴露 tool_choice，恒不携带");
}
