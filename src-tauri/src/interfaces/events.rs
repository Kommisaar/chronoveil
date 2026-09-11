//! INT-001 类型化事件通道（TASK-005 / FR-001 / CMP-002 接线半）。
//!
//! wire 形态与 INT-001 v1 对齐：`type` 判别字段 + snake_case 负载——
//! token / reasoning `{session_id, message_id, text}`（另携 `reset` 增字段：
//! INT-001「只增不改」兼容位，TASK-002 重发语义，消费方清空后重新累积）、
//! done `{session_id, message_id, think_ms}`、
//! error `{session_id, message_id, reason, interrupted}`。
//!
//! Task-06 增幕后活动事件 activity `{session_id, message_id, phase, detail}`：
//! 记忆探索器（services/explorer.rs）的阶段性步骤，**即时透出**（不参与终态闸门
//! 与思考计量，前端活动条消费）。`phase` camelCase 枚举值、`detail` 为技术措辞
//! 摘要——是数据不是 UI 文案，前端 i18n 在消费侧做。
//!
//! 事件名（tauri-specta kebab-case）：`stream-event`；前端经
//! `src/api/events.ts` 的 `subscribeStream` 订阅并按 session_id 过滤（多路并发路由，FR-007）。
//! 未知事件类型由前端忽略（向前兼容，INT-001）。

use serde::Serialize;
use specta::Type;
use tauri_specta::Event;

use crate::infra::llm::{ActivityPhase, EventSink, LlmEvent};

/// 流式事件（INT-001 v1 四态）。Rust 侧由 [`TauriEventSink`] 发射，
/// TS 侧类型经 tauri-specta 同源生成于 `src/api/generated/bindings.ts`。
#[derive(Debug, Clone, Serialize, Type, tauri_specta::Event)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    /// 正文增量（markdown-lite 原文片段）。`reset = true`：重发尝试首事件，清空该
    /// message_id 已累积内容后重新累积（「新内容替换旧半条」）。
    Token {
        session_id: i64,
        message_id: i64,
        text: String,
        reset: bool,
    },
    /// 思考增量（字段型直通 + 内联 `<think>` 拆分后，FR-003）。`reset` 语义同 Token。
    Reasoning {
        session_id: i64,
        message_id: i64,
        text: String,
        reset: bool,
    },
    /// 终态：正常完成，整条已落库（落库由生成编排负责，ADR-001）。
    Done {
        session_id: i64,
        message_id: i64,
        /// 思考可见时长（毫秒）；无思考为 null。
        think_ms: Option<u64>,
    },
    /// 终态：失败，半条已落库（中断标记，ADR-001）。
    Error {
        session_id: i64,
        message_id: i64,
        /// 人类可读错误。
        reason: String,
        /// 已有半条内容产生。
        interrupted: bool,
    },
    /// 幕后活动（Task-06 记忆探索透出）：非流式生命周期事件，即时透出——
    /// 不经生成编排的终态闸门（闸门只扣 token / reasoning / done / error）。
    Activity {
        session_id: i64,
        message_id: i64,
        /// 探索阶段（camelCase 枚举值，未知值前端忽略）。
        phase: ActivityPhase,
        /// 技术措辞摘要（工具名+参数摘要 / 结果截断 / 卷宗前若干字）；数据非 UI 文案。
        detail: Option<String>,
    },
}

impl From<LlmEvent> for StreamEvent {
    /// 网关事件 → INT-001 wire 事件（负载直通，Rust 单流顺序 emit，INT-001）。
    fn from(event: LlmEvent) -> Self {
        match event {
            LlmEvent::Token { session_id, message_id, text, reset } => {
                StreamEvent::Token { session_id, message_id, text, reset }
            }
            LlmEvent::Reasoning { session_id, message_id, text, reset } => {
                StreamEvent::Reasoning { session_id, message_id, text, reset }
            }
            LlmEvent::Done { session_id, message_id, think_ms } => {
                StreamEvent::Done { session_id, message_id, think_ms }
            }
            LlmEvent::Error { session_id, message_id, reason, interrupted } => {
                StreamEvent::Error { session_id, message_id, reason, interrupted }
            }
            LlmEvent::Activity { session_id, message_id, phase, detail } => {
                StreamEvent::Activity { session_id, message_id, phase, detail }
            }
        }
    }
}

/// 网关 [`EventSink`] 的 Tauri 实现：转 wire 事件后向所有窗口广播。
/// 单窗口单用户应用（CMP-005），前端按 session_id 二次过滤。
pub struct TauriEventSink {
    handle: tauri::AppHandle,
}

impl TauriEventSink {
    /// `setup` 中用 AppHandle 构造并注入 `AppState`（组合根装配，state.rs）；生成编排（TASK-006）
    /// 经 `AppState::sink` 取用并传给网关。
    pub fn new(handle: tauri::AppHandle) -> Self {
        Self { handle }
    }
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: LlmEvent) {
        if let Err(e) = StreamEvent::from(event).emit(&self.handle) {
            // 发射失败不 panic：流式事件丢失不应击穿生成闭环（终态以落库为准）。
            eprintln!("[events] stream-event 发射失败：{e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- INT-001 负载契约（验收 2 的测试兜底：type 判别 + snake_case 字段）----

    #[test]
    fn token_event_matches_int001_payload() {
        let json = serde_json::to_value(StreamEvent::Token {
            session_id: 1,
            message_id: 7,
            text: "雨".into(),
            reset: false,
        })
        .unwrap();
        assert_eq!(json["type"], "token");
        assert_eq!(json["session_id"], 1);
        assert_eq!(json["message_id"], 7);
        assert_eq!(json["text"], "雨");
        assert_eq!(json["reset"], false, "TASK-002 增字段：重发首事件为 true");
    }

    #[test]
    fn reasoning_event_matches_int001_payload() {
        let json = serde_json::to_value(StreamEvent::Reasoning {
            session_id: 2,
            message_id: 8,
            text: "营造悬念".into(),
            reset: true,
        })
        .unwrap();
        assert_eq!(json["type"], "reasoning");
        assert_eq!(json["session_id"], 2);
        assert_eq!(json["reset"], true);
    }

    #[test]
    fn done_event_matches_int001_payload() {
        let json = serde_json::to_value(StreamEvent::Done {
            session_id: 1,
            message_id: 7,
            think_ms: Some(1800),
        })
        .unwrap();
        assert_eq!(json["type"], "done");
        assert_eq!(json["session_id"], 1);
        assert_eq!(json["message_id"], 7);
        assert_eq!(json["think_ms"], 1800);

        let none = serde_json::to_value(StreamEvent::Done {
            session_id: 1,
            message_id: 7,
            think_ms: None,
        })
        .unwrap();
        assert!(none["think_ms"].is_null(), "无思考 → think_ms null");
    }

    #[test]
    fn error_event_matches_int001_payload() {
        let json = serde_json::to_value(StreamEvent::Error {
            session_id: 3,
            message_id: 9,
            reason: "LLM 请求超时".into(),
            interrupted: true,
        })
        .unwrap();
        assert_eq!(json["type"], "error");
        assert_eq!(json["session_id"], 3);
        assert_eq!(json["reason"], "LLM 请求超时");
        assert_eq!(json["interrupted"], true);
    }

    // ---- Task-06 活动事件负载契约（type 判别 + phase camelCase + detail 可空）----

    #[test]
    fn activity_event_matches_payload_contract() {
        let json = serde_json::to_value(StreamEvent::Activity {
            session_id: 4,
            message_id: -1,
            phase: crate::infra::llm::ActivityPhase::ToolCall,
            detail: Some("search_history({\"keyword\":\"灯塔\"})".into()),
        })
        .unwrap();
        assert_eq!(json["type"], "activity");
        assert_eq!(json["session_id"], 4);
        assert_eq!(json["message_id"], -1);
        assert_eq!(json["phase"], "toolCall", "phase 枚举值 camelCase");
        assert_eq!(json["detail"], "search_history({\"keyword\":\"灯塔\"})");

        let none = serde_json::to_value(StreamEvent::Activity {
            session_id: 4,
            message_id: -1,
            phase: crate::infra::llm::ActivityPhase::ResearchSkipped,
            detail: None,
        })
        .unwrap();
        assert_eq!(none["phase"], "researchSkipped");
        assert!(none["detail"].is_null(), "无摘要 → detail null");
    }

    /// 全部 phase 枚举值的 wire 形态钉死（前端按值分发，改名即破坏兼容）。
    #[test]
    fn activity_phase_wire_values_are_stable() {
        use crate::infra::llm::ActivityPhase;
        let wire = |phase: ActivityPhase| serde_json::to_value(phase).unwrap();
        assert_eq!(wire(ActivityPhase::ResearchStart), "researchStart");
        assert_eq!(wire(ActivityPhase::ToolCall), "toolCall");
        assert_eq!(wire(ActivityPhase::ToolResult), "toolResult");
        assert_eq!(wire(ActivityPhase::DossierReady), "dossierReady");
        assert_eq!(wire(ActivityPhase::ResearchSkipped), "researchSkipped");
    }

    // ---- 网关事件 → wire 事件转换 ----

    #[test]
    fn llm_events_convert_losslessly() {
        use std::sync::Arc;

        // 收集器：借网关公开类型构造事件（不经网络）。
        struct Recorder(std::sync::Mutex<Vec<LlmEvent>>);
        impl EventSink for Recorder {
            fn emit(&self, event: LlmEvent) {
                self.0.lock().unwrap().push(event);
            }
        }
        let recorder = Arc::new(Recorder(std::sync::Mutex::new(Vec::new())));
        recorder.emit(LlmEvent::Token {
            session_id: 1,
            message_id: 7,
            text: "夜".into(),
            reset: false,
        });
        recorder.emit(LlmEvent::Reasoning {
            session_id: 1,
            message_id: 7,
            text: "氛围".into(),
            reset: true,
        });
        recorder.emit(LlmEvent::Done { session_id: 1, message_id: 7, think_ms: Some(2400) });
        recorder.emit(LlmEvent::Error {
            session_id: 1,
            message_id: 7,
            reason: "网络中断".into(),
            interrupted: true,
        });

        let events = recorder.0.lock().unwrap().clone();
        let wire: Vec<StreamEvent> = events.into_iter().map(StreamEvent::from).collect();
        assert_eq!(wire.len(), 4);
        assert!(matches!(wire[0], StreamEvent::Token { ref text, reset, .. } if text == "夜" && !reset));
        assert!(matches!(wire[1], StreamEvent::Reasoning { reset, .. } if reset));
        assert!(matches!(wire[2], StreamEvent::Done { think_ms: Some(2400), .. }));
        assert!(matches!(wire[3], StreamEvent::Error { ref reason, interrupted, .. }
            if reason == "网络中断" && interrupted));
    }

    /// 事件名约定：tauri-specta Event 派生取类型名 kebab-case（`stream-event`），
    /// 与 generated/bindings.ts 的 `events.streamEvent` 同源。
    #[test]
    fn event_name_is_stable() {
        assert_eq!(StreamEvent::NAME, "stream-event");
    }
}
