//! 非流式路径：结构化 JSON helper（验收 7）与工具调用底座（OpenAI 兼容 tools / tool_calls）。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::*;
use crate::infra::llm::mock::{json_body, json_raw_body, status_head, MockRequest, MockServer};

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
        .complete_json(&messages(), None)
        .await
        .expect("围栏 JSON 应可解析");
    assert_eq!(out, Out { ok: true, n: 3 });

    let loose = MockServer::start(move |_req, stream| {
        let _ = json_body(stream, "结算结果如下：{\"wins\": [1, 2, 3]} 以上。");
    });
    let value: Value = client(&loose.url(), retry_policy(0))
        .complete_json(&messages(), None)
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
        .complete_json::<Value>(&messages(), None)
        .await
        .unwrap_err();
    assert!(matches!(err, LlmError::Json(_)), "失败应可判断：{err:?}");

    let req = captured.lock().unwrap().clone().expect("应捕获到请求");
    assert_eq!(req.path, "/chat/completions");
    assert_eq!(req.json()["stream"], false, "结构化调用为非流式一次性请求");
}

// ---------------------------------------------------------------------------
// 工具调用底座（OpenAI 兼容 tools / tool_calls）：Tool 角色 wire、tools 条件携带、
// 既有无工具请求形态零变化、tool_calls 解析、content 回落、协议边界与重试。
//（memory_tool 定义在 mod.rs 共享装配：gateway 与 trace 两组测试都用。）
// ---------------------------------------------------------------------------

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
        .complete_json(&messages, None)
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
        .complete_json(&messages(), None)
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
        .complete_with_tools(&messages(), &[memory_tool()], None)
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
        .complete_with_tools(&messages(), &[memory_tool()], None)
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
        .complete_with_tools(&messages(), &[memory_tool()], None)
        .await
        .expect("纯正文响应应成功");
    assert_eq!(turn, ToolLoopTurn::Content("直接回答".into()));

    // 2) tool_calls 为空数组：同样回落正文。
    let empty = r#"{"choices":[{"message":{"role":"assistant","content":"空数组也走正文","tool_calls":[]}}]}"#;
    let server = MockServer::start(move |_req, stream| {
        let _ = json_raw_body(stream, empty);
    });
    let turn = client(&server.url(), retry_policy(0))
        .complete_with_tools(&messages(), &[memory_tool()], None)
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
        .complete_with_tools(&messages(), &[memory_tool()], None)
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
        .complete_with_tools(&messages(), &[memory_tool()], None)
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
        .complete_with_tools(&messages(), &[memory_tool()], None)
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
        .complete_with_tools(&messages(), &[memory_tool()], None)
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
        .complete_with_tools(&messages(), &[], None)
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
        .complete_with_tools(&messages(), &[memory_tool()], None)
        .await
        .expect("带工具请求应成功");
    assert!(matches!(turn, ToolLoopTurn::Content(_)));
    let body = captured.lock().unwrap().clone().expect("应捕获到请求").json();
    assert!(body["tools"].as_array().is_some(), "提供工具时 tools 随附");
    assert!(body.get("tool_choice").is_none(), "构造层未暴露 tool_choice，恒不携带");
}
