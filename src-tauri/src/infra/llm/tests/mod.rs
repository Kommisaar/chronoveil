//! CMP-002 集成测试（验收 2–8）：本地 mock HTTP 服务手写 SSE 字节流，
//! 覆盖正常流、字段型 reasoning、内联 think（半标签跨包）、断流重试、取消、错误映射（401/429/5xx/超时）、
//! 结构化 JSON helper 与分层/序列化形态。
//!
//! 500 行规范拆分：stream（流式与错误映射）/ gateway（结构化 JSON 与工具回路）/
//! contract（事件序列化与配置校验）/ trace（调用轨迹）/ anthropic + responses
//! （2026-09-14 三协议分派的 Anthropic Messages 与 OpenAI Responses 两组）；
//! 本文件只留共享装配（IDS、事件收集器、客户端与重试策略构造），子模块经
//! `use super::*` 取用。

use std::sync::Arc;

use tokio::sync::mpsc;

use super::*;

mod anthropic;
mod contract;
mod gateway;
mod responses;
mod stream;
mod trace;

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
        api: ProviderApi::OpenAi,
        connect_timeout_ms: 2_000,
        read_timeout_ms,
        retry,
    })
    .unwrap()
}

/// 指定 API 兼容协议的客户端（2026-09-14 三协议分派测试用；其余字段与 client 同款）。
fn client_with_api(url: &str, retry: RetryPolicy, api: ProviderApi) -> LlmClient {
    LlmClient::new(LlmConfig {
        base_url: url.to_owned(),
        api_key: "test-key".into(),
        model: "test-model".into(),
        api,
        connect_timeout_ms: 2_000,
        read_timeout_ms: 2_000,
        retry,
    })
    .unwrap()
}

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
