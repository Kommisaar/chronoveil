//! 生成注册表（自 generation.rs 本体外置，500 行规范；代码逐字搬移，可见性不变）：
//! 同会话互斥 + 取消信号 + 临时 message_id 分配（FR-007 / ADR-007）。
//! 生成闭环编排本体见 [`super`]。

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use crate::infra::llm::{cancel_channel, CancelHandle, CancelSignal};

// ---------------------------------------------------------------------------
// 生成注册表：同会话互斥 + 取消信号 + 临时 message_id 分配（FR-007 / ADR-007）
// ---------------------------------------------------------------------------

/// 同会话已有进行中的生成（重复发送 / 重复重新生成被拒，FR-008「生成期间按钮不可重复触发」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionBusy(pub i64);

impl std::fmt::Display for SessionBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "会话 #{} 已有进行中的生成", self.0)
    }
}

impl std::error::Error for SessionBusy {}

/// 一次生成的凭据：临时 message_id + 取消句柄。生成任务持有至终态。
pub struct GenerationTicket {
    pub session_id: i64,
    /// 临时负数 id（事件路由键；终态落库后由前端重拉真实行替代）。
    pub message_id: i64,
    cancel_handle: CancelHandle,
}

impl GenerationTicket {
    pub fn cancel_handle(&self) -> &CancelHandle {
        &self.cancel_handle
    }
}

/// 活跃生成注册表：`session_id → 取消信号`。跨会话并发、同会话互斥（ADR-007）。
#[derive(Default)]
pub struct GenerationRegistry {
    active: Mutex<HashMap<i64, CancelSignal>>,
    /// 临时 message_id：从 -1 递减，绝不与 messages 自增主键（正数）冲突。
    next_message_id: AtomicI64,
}

impl GenerationRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记一路生成；同会话已有活跃生成时返回 [`SessionBusy`]。
    pub fn begin(&self, session_id: i64) -> Result<GenerationTicket, SessionBusy> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| SessionBusy(session_id))?; // 锁中毒 = 进程级故障，按占用拒新路
        if active.contains_key(&session_id) {
            return Err(SessionBusy(session_id));
        }
        let (signal, handle) = cancel_channel();
        let message_id = self.next_message_id.fetch_sub(1, Ordering::SeqCst) - 1;
        active.insert(session_id, signal);
        Ok(GenerationTicket { session_id, message_id, cancel_handle: handle })
    }

    /// 取消该会话的进行中生成；返回是否真正取消（无活跃生成 = 幂等 no-op，false）。
    pub fn cancel(&self, session_id: i64) -> bool {
        let signal = self
            .active
            .lock()
            .ok()
            .and_then(|mut active| active.remove(&session_id));
        match signal {
            Some(signal) => {
                signal.cancel();
                true
            }
            None => false,
        }
    }

    /// 终态收尾：摘除登记（done / error / cancel 任一终态后调用）。
    pub fn finish(&self, session_id: i64) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(&session_id);
        }
    }

    /// 查询会话是否已有进行中的生成。预留：生产侧同会话互斥由 [`GenerationRegistry::begin`]
    /// 返回 [`SessionBusy`] 保证，本查询目前仅测试断言消费（命令层前置探测 / 诊断接线预留）。
    #[allow(dead_code)]
    pub fn is_active(&self, session_id: i64) -> bool {
        self.active
            .lock()
            .map(|active| active.contains_key(&session_id))
            .unwrap_or(false)
    }
}
