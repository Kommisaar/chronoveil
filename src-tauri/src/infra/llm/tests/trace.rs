//! 调用轨迹（透明化功能）：CallTrace + LlmCallSink——每次 HTTP 请求一条记录，
//! 覆盖 ok（含 usage 终帧）/ error / 无 trace / 无 sink 的旁路语义与非流式两路。

use std::io::Write;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::*;
use crate::domain::models::{LlmCallKind, LlmCallStatus, NewLlmCall};
use crate::infra::llm::mock::{
    delta_json, json_body, json_raw_body, sse_data, sse_head, status_head, MockServer,
};

/// 轨迹收集器：记录全部 NewLlmCall 供断言。
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

/// 带 usage 终帧的正常流：轨迹字段完整——prompt 数组 JSON、正文 / 思考、
/// usage 捕获、status ok、耗时 ≥ 0；[DONE] 前的 usage 终帧被捕获而非丢弃。
#[tokio::test]
async fn trace_records_completed_stream_with_usage_frame() {
    let server = MockServer::start(|_req, stream| {
        let _ = sse_head(stream);
        for payload in [
            delta_json(None, Some("想想")),
            delta_json(Some("回答"), None),
            // usage 终帧（OpenAI 兼容：choices 空数组 + 顶层 usage）。
            serde_json::json!({
                "choices": [],
                "usage": { "prompt_tokens": 11, "completion_tokens": 7 }
            })
            .to_string(),
        ] {
            let _ = stream.write_all(sse_data(&payload).as_bytes());
        }
        let _ = stream.write_all(sse_data("[DONE]").as_bytes());
    });
    let collector = trace_collector();
    let (sink_tx, _rx) = sink();
    let (_signal, cancel) = cancel_channel();
    let trace = CallTrace { session_id: Some(7), kind: LlmCallKind::Dialogue };
    let outcome = client(&server.url(), retry_policy(0))
        .with_call_sink(collector.clone())
        .chat_stream(&messages(), IDS, sink_tx, &cancel, Some(&trace))
        .await
        .expect("正常流不应失败");
    assert!(matches!(outcome, StreamOutcome::Completed { .. }));

    let records = records_of(&collector);
    assert_eq!(records.len(), 1, "一次请求恰好一条轨迹");
    let call = &records[0];
    assert_eq!(call.session_id, Some(7));
    assert_eq!(call.kind, LlmCallKind::Dialogue);
    assert_eq!(call.model, "test-model");
    assert!(call.started_at > 0, "started_at 为 Unix 毫秒");
    assert!(call.duration_ms >= 0, "耗时非负（本次极短，不设下界防抖动）");
    let prompt: Vec<Value> = serde_json::from_str(&call.prompt_json).unwrap();
    assert_eq!(
        prompt,
        vec![serde_json::json!({"role": "user", "content": "你好"})],
        "prompt_json 为请求消息数组 JSON"
    );
    assert_eq!(call.response_text.as_deref(), Some("回答"));
    assert_eq!(call.reasoning_text.as_deref(), Some("想想"));
    assert_eq!(call.tool_calls_json, None);
    assert_eq!(call.prompt_tokens, Some(11), "usage 终帧被捕获");
    assert_eq!(call.completion_tokens, Some(7));
    assert_eq!(call.status, LlmCallStatus::Ok);
    assert_eq!(call.error_text, None);
}

/// 错误路径（mock 500 + 零重试）：status error + error_text 人类可读；usage 为空。
#[tokio::test]
async fn trace_records_error_path_with_reason() {
    let server = MockServer::start(|_req, stream| {
        let _ = status_head(stream, 500, "Internal Server Error");
    });
    let collector = trace_collector();
    let (sink_tx, mut rx) = sink();
    let (_signal, cancel) = cancel_channel();
    let trace = CallTrace { session_id: Some(3), kind: LlmCallKind::Explorer };
    let outcome = client(&server.url(), retry_policy(0))
        .with_call_sink(collector.clone())
        .chat_stream(&messages(), IDS, sink_tx, &cancel, Some(&trace))
        .await;
    assert!(outcome.is_err());

    let records = records_of(&collector);
    assert_eq!(records.len(), 1, "失败尝试同样落一条轨迹");
    let call = &records[0];
    assert_eq!(call.kind, LlmCallKind::Explorer);
    assert_eq!(call.response_text, None, "零内容失败无半条");
    assert_eq!(call.prompt_tokens, None, "错误路径无 usage");
    assert_eq!(call.status, LlmCallStatus::Error);
    let reason = call.error_text.as_deref().expect("错误原因必须留痕");
    assert!(reason.contains("500"), "错误原因人类可读：{reason}");
    assert!(rx.try_recv().is_ok(), "主流程 error 事件不受轨迹影响");
}

/// 旁路语义：trace = None（sink 已接）与 sink = None（trace 已传）都不产生记录。
#[tokio::test]
async fn trace_is_bypass_none_trace_or_none_sink_records_nothing() {
    let server = MockServer::start(|_req, stream| {
        let _ = sse_head(stream);
        let _ = stream.write_all(sse_data(&delta_json(Some("好"), None)).as_bytes());
        let _ = stream.write_all(sse_data("[DONE]").as_bytes());
    });
    // trace = None：不记录（测试 / 未来内部调用）。
    let collector = trace_collector();
    let (sink_tx, _rx) = sink();
    let (_signal, cancel) = cancel_channel();
    client(&server.url(), retry_policy(0))
        .with_call_sink(collector.clone())
        .chat_stream(&messages(), IDS, sink_tx, &cancel, None)
        .await
        .unwrap();
    assert!(records_of(&collector).is_empty(), "trace = None 不得记录");

    // sink = None：trace 传了也无人接（未接线装配）。
    let collector = trace_collector();
    let (sink_tx, _rx) = sink();
    let (_signal, cancel) = cancel_channel();
    let trace = CallTrace { session_id: Some(1), kind: LlmCallKind::Dialogue };
    client(&server.url(), retry_policy(0))
        .chat_stream(&messages(), IDS, sink_tx, &cancel, Some(&trace))
        .await
        .unwrap();
    assert!(records_of(&collector).is_empty(), "未挂 sink 不记录（collector 未接线）");
}

/// 非流式 complete_json：正文 / reasoning_content / usage 进轨迹；Json 提取失败
/// 仍如实记下原始输出（回放价值所在）。
#[tokio::test]
async fn complete_json_trace_records_reasoning_usage_and_raw_output() {
    // 成功路径：带 usage 与 reasoning_content 的完整响应体。
    let ok_body = serde_json::json!({
        "choices": [{
            "message": {
                "role": "assistant",
                "content": "{\"answer\": 1}",
                "reasoning_content": "推演中"
            }
        }],
        "usage": { "prompt_tokens": 20, "completion_tokens": 5 }
    })
    .to_string();
    let ok_server = MockServer::start(move |_req, stream| {
        let _ = json_raw_body(stream, &ok_body);
    });
    let collector = trace_collector();
    let trace = CallTrace { session_id: Some(9), kind: LlmCallKind::Director };
    let parsed: Value = client(&ok_server.url(), retry_policy(0))
        .with_call_sink(collector.clone())
        .complete_json(&messages(), Some(&trace))
        .await
        .unwrap();
    assert_eq!(parsed["answer"], 1);
    let records = records_of(&collector);
    assert_eq!(records.len(), 1);
    let call = &records[0];
    assert_eq!(call.kind, LlmCallKind::Director);
    assert_eq!(call.response_text.as_deref(), Some("{\"answer\": 1}"));
    assert_eq!(call.reasoning_text.as_deref(), Some("推演中"), "非流式 reasoning_content 进轨迹");
    assert_eq!(call.prompt_tokens, Some(20));
    assert_eq!(call.completion_tokens, Some(5));
    assert_eq!(call.status, LlmCallStatus::Ok);

    // Json 提取失败：轨迹仍记录原始输出 + error 原因（调试回放的关键形态）。
    let bad_server = MockServer::start(|_req, stream| {
        let _ = json_body(stream, "抱歉，这不是 JSON。");
    });
    let collector = trace_collector();
    let trace = CallTrace { session_id: Some(9), kind: LlmCallKind::Director };
    let outcome: Result<Value, _> = client(&bad_server.url(), retry_policy(0))
        .with_call_sink(collector.clone())
        .complete_json(&messages(), Some(&trace))
        .await;
    assert!(outcome.is_err());
    let call = &records_of(&collector)[0];
    assert_eq!(call.response_text.as_deref(), Some("抱歉，这不是 JSON。"), "原始输出如实留痕");
    assert_eq!(call.status, LlmCallStatus::Error);
    assert!(call.error_text.as_deref().unwrap_or_default().contains("JSON"));
}

/// 工具回路：该轮模型发起的 tool_calls 以 [{name, arguments}] 入轨迹；
/// 多轮循环每轮各一条（每轮 prompt 已含回填，逐条可回放）。
#[tokio::test]
async fn complete_with_tools_trace_records_tool_calls_per_round() {
    let tool_calls_body = serde_json::json!({
        "choices": [{
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": { "name": "search_memory", "arguments": "{\"query\":\"信物\"}" }
                }]
            }
        }],
        "usage": { "prompt_tokens": 30, "completion_tokens": 9 }
    })
    .to_string();
    let content_body = serde_json::json!({
        "choices": [{ "message": { "role": "assistant", "content": "卷宗正文" } }]
    })
    .to_string();
    let bodies = Arc::new(Mutex::new(vec![tool_calls_body, content_body]));
    let queue = bodies.clone();
    let server = MockServer::start(move |_req, stream| {
        let next = queue.lock().unwrap().remove(0);
        let _ = json_raw_body(stream, &next);
    });

    let collector = trace_collector();
    let trace = CallTrace { session_id: Some(5), kind: LlmCallKind::Explorer };
    let llm = client(&server.url(), retry_policy(0)).with_call_sink(collector.clone());

    // 第一轮：模型发起工具调用。
    let turn = llm.complete_with_tools(&messages(), &[memory_tool()], Some(&trace)).await.unwrap();
    assert!(matches!(turn, ToolLoopTurn::ToolCalls(_)));
    // 第二轮（带 tool 回填的完整消息数组）：模型给正文。
    let follow_up = vec![
        ChatMessage::new(ChatRole::User, "你好"),
        ChatMessage::new(ChatRole::Assistant, "").with_tool_calls(vec![ToolCall {
            id: "call_1".into(),
            name: "search_memory".into(),
            arguments: "{\"query\":\"信物\"}".into(),
        }]),
        ChatMessage::new(ChatRole::Tool, "命中一条").with_tool_call_id("call_1"),
    ];
    let turn = llm.complete_with_tools(&follow_up, &[memory_tool()], Some(&trace)).await.unwrap();
    assert_eq!(turn, ToolLoopTurn::Content("卷宗正文".into()));

    let records = records_of(&collector);
    assert_eq!(records.len(), 2, "工具循环每轮各一条轨迹");
    let first = &records[0];
    assert_eq!(
        serde_json::from_str::<Value>(&first.tool_calls_json.clone().unwrap()).unwrap(),
        serde_json::json!([{ "name": "search_memory", "arguments": "{\"query\":\"信物\"}" }]),
        "该轮 tool_calls 以 [{{name, arguments}}] 记录"
    );
    assert_eq!(first.prompt_tokens, Some(30));
    assert_eq!(first.status, LlmCallStatus::Ok);
    // 第二轮的 prompt 数组含 tool 角色回填与 assistant tool_calls 回传（完整请求形态）。
    let second_prompt: Vec<Value> = serde_json::from_str(&records[1].prompt_json).unwrap();
    assert_eq!(second_prompt.len(), 3);
    assert_eq!(second_prompt[2]["role"], "tool");
    assert_eq!(second_prompt[2]["tool_call_id"], "call_1");
    assert_eq!(second_prompt[1]["tool_calls"][0]["id"], "call_1");
    assert_eq!(records[1].tool_calls_json, None, "正文轮无 tool_calls 记录");
}
