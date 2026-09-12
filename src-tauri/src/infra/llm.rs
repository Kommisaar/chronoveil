//! model.rs（CMP-002）：LLM 网关——OpenAI 兼容多 provider 客户端（base_url + api_key + model，INT-002）。
//!
//! 职责边界（CMP-002）：SSE 流解析、reasoning 两形态分离路由（字段型直通 + 内联 `<think>` 状态机）、
//! 类型化事件发射（FR-001：token/reasoning/done/error，携 session_id/message_id；Task-06 起另有
//! 幕后活动事件 activity，记忆探索步骤透出）、
//! 消息级断流重发、立即取消、结构化 JSON 调用 helper、非流式工具调用回路
//! （OpenAI 兼容 tools / tool_calls，切片 C 记忆探索 agent 的地基，暂无业务接线）。
//! 不负责：渲染决策、落库时机（只上报终态，ADR-001 由调用方落库）、prompt 业务装配。
//! 例外：调用轨迹（透明化功能）——每次 HTTP 请求经 [`LlmCallSink`]（组合根注入的
//! 旁路记录器）回调一条轨迹观测（prompt / 响应 / usage / 状态），持久化在 sink 实现侧。
//!
//! 分层约束：本模块不 `use tauri`——事件经 `EventSink` 抽象回调发射（TASK-005 接通道）。
//!
//! 事件语义补充（实现内定，验收 4/5）：
//! - 重发期间失败尝试不产生独立事件；重发尝试的第一个 token/reasoning 事件带
//!   `reset: true`，消费方应清空该 message_id 已累积内容后重新累积（「新内容替换旧半条」）；
//! - `done.think_ms` 是网关侧「首条 reasoning 增量 → 终态」的墙钟时长；FR-003 的
//!   用户可见时长校正由前端/生成服务在落库前覆盖；
//! - 取消（cancel）不产生任何事件（验收 6），以 `StreamOutcome::Cancelled` 返回，
//!   携带中断半条内容供调用方按 ADR-001 落库；
//! - 最终失败经 `EventSink` 上报一次 `error`（含 reason/interrupted），并以
//!   `StreamFailure` 返回错误与最后尝试的半条内容。

// 本模块 API 的消费方已全部接线：TASK-005（IPC 事件通道）、TASK-006（生成编排）
// 与导演服务（FR-011 阶段 5，complete_json / extract_json）。

// 域拆分（500 行规范，纯搬移）：contract 对外契约类型（配置 / 错误 / 事件 / 取消 /
// 消息与工具入参及其 wire 形态）、client 客户端本体与流式路径、gateway 非流式两路
// （结构化 JSON + 工具回路 + 提取逻辑）、trace 调用轨迹记录。以下 pub use 再导出
// 保持对外路径 `crate::infra::llm::*` 不变（services / interfaces 调用侧零改动）。
mod client;
mod contract;
mod gateway;
mod trace;

pub mod sse;
pub mod think;

#[cfg(test)]
pub(crate) mod mock;

#[cfg(test)]
mod tests;

pub use client::{LlmClient, StreamFailure, StreamOutcome};
pub use contract::{
    cancel_channel, ActivityPhase, CancelHandle, CancelSignal, ChatMessage, ChatRole, EventSink,
    LlmConfig, LlmError, LlmEvent, MessageIds, RetryPolicy, ToolCall, ToolLoopTurn, ToolSpec,
};
pub use gateway::extract_json;
pub use trace::{CallTrace, LlmCallSink};
