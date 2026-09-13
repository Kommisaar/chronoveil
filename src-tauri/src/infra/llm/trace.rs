//! 调用轨迹（透明化功能）：CallTrace 上下文、LlmCallSink 记录器 trait 与网关侧记录逻辑
//! （CallObservation 观测结构 + record_call 组装发 sink + epoch_ms 时间戳）。
//! 纯搬移自原 llm.rs 单文件；模块级职责见 llm.rs 壳文档。

use std::time::Instant;

use crate::domain::llm_call::{LlmCallKind, LlmCallStatus, NewLlmCall};

use super::client::LlmClient;
use super::contract::{chat_message_wire, ChatMessage};

// ---------------------------------------------------------------------------
// 调用轨迹（透明化功能）：CallTrace 上下文 + LlmCallSink 记录器
// ---------------------------------------------------------------------------

/// 一次 LLM 调用的轨迹上下文（调用方传入）：会话内定位 + 调用类别。
/// `None` trace 参数 = 不记录（测试 / 未来可能的内部调用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CallTrace {
    /// 所属会话；None = 无会话调用（历史起草调用遗留形态，现行写入方恒有会话）。
    pub session_id: Option<i64>,
    pub kind: LlmCallKind,
}

/// LLM 调用轨迹记录器（旁路）：网关每完成一次 HTTP 请求回调一次
/// （含失败 / 取消尝试——「每次 HTTP 请求 = 一条记录」）。
///
/// trait 定义在 infra（网关在记录点所见信息最全），实现由组合根注入：
/// 生产实现（interfaces::events::TauriCallSink）落库 + 发 Trace 事件，
/// 轨迹是旁路——实现内部吞掉失败（warn 留痕），不影响主流程。
pub trait LlmCallSink: Send + Sync {
    fn record(&self, call: NewLlmCall);
}

// ---------------------------------------------------------------------------
// 轨迹记录（透明化功能）：观测结构 + 组装 + 发往 sink（旁路，None 全跳过）
// ---------------------------------------------------------------------------

/// 一次 HTTP 请求的轨迹观测：网关在各出口路径填充，`record_call` 统一组装落 sink。
// pub(super)：观测结构由 client.rs（流式尝试）与 gateway.rs（非流式两路）在各出口路径填充。
#[derive(Debug, Default)]
pub(super) struct CallObservation {
    pub(super) response_text: Option<String>,
    pub(super) reasoning_text: Option<String>,
    pub(super) tool_calls_json: Option<String>,
    pub(super) prompt_tokens: Option<i64>,
    pub(super) completion_tokens: Option<i64>,
    /// 完整错误文本（不在此处钳长，保留给运行期日志 / 调试）；落库截断统一在
    /// [`record_call`] 按 [`MAX_ERROR_TEXT_CHARS`] 执行——各赋值点（gateway / client
    /// 共 10+ 处）禁止分散截断，持久化边界单一事实源。
    pub(super) error_text: Option<String>,
}

/// error_text 落库钳长上限（**字符数**，非字节）：2000 字符足以容纳常见 API 错误的
/// 头部（状态码 / 错误类型 / message 首段都在前部），其后多为此刻对排查无增益的
/// HTML 错误页或巨型响应体回显。不钳制时 llm_calls 表重度使用实测膨胀 10-15MB/天
/// （错误详情占大头），钳制后单条错误至多约 6KB（按中文 UTF-8 3 字节/字符估算），
/// 年增量从 GB 级降到 MB 级。
const MAX_ERROR_TEXT_CHARS: usize = 2000;

/// 落库前对 error_text 统一钳长（持久化边界）：按**字符边界**截断——Rust 按字节
/// 切片会在多字节字符中间 panic——保留对排查最有用的头部，并附注明原长（字符数）
/// 的省略标记。恰好等于上限不截断。
fn clamp_error_text(text: String) -> String {
    let original_chars = text.chars().count();
    if original_chars <= MAX_ERROR_TEXT_CHARS {
        return text;
    }
    let head: String = text.chars().take(MAX_ERROR_TEXT_CHARS).collect();
    format!("{head}…（截断，原长 {original_chars} 字符）")
}

impl LlmClient {
    /// 组装一条 NewLlmCall 并发往记录器；trace / sink 任一为 None 即 no-op
    /// （轨迹是旁路：不阻塞、不影响主流程，失败由 sink 实现侧吞掉）。
    // pub(super)：client.rs（流式尝试）与 gateway.rs（非流式两路）在每次 HTTP 请求后调用。
    pub(super) fn record_call(
        &self,
        trace: Option<&CallTrace>,
        started_at: i64,
        started: Instant,
        messages: &[ChatMessage],
        obs: CallObservation,
    ) {
        let Some(trace) = trace else { return };
        let Some(sink) = &self.call_sink else { return };
        let prompt_json = serde_json::Value::Array(
            messages.iter().map(chat_message_wire).collect(),
        )
        .to_string();
        sink.record(NewLlmCall {
            session_id: trace.session_id,
            kind: trace.kind,
            model: self.config.model.clone(),
            started_at,
            duration_ms: started.elapsed().as_millis().min(i64::MAX as u128) as i64,
            prompt_json,
            response_text: obs.response_text,
            reasoning_text: obs.reasoning_text,
            tool_calls_json: obs.tool_calls_json,
            prompt_tokens: obs.prompt_tokens,
            completion_tokens: obs.completion_tokens,
            status: if obs.error_text.is_none() {
                LlmCallStatus::Ok
            } else {
                LlmCallStatus::Error
            },
            // 落库钳长单点：所有路径（流式 / 非流式 / 工具回路）的 error_text 均经此入 sink。
            error_text: obs.error_text.map(clamp_error_text),
        });
    }
}

/// 当前时刻的 Unix 毫秒（轨迹 started_at；与 storage::now 同义，infra/llm 不反向
/// 依赖 storage 模块，就地实现）。
// pub(super)：client.rs 与 gateway.rs 的轨迹起始时间戳共用。
pub(super) fn epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
