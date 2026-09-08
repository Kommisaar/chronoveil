//! 生成终态状态机（ADR-001）：done / error / cancel 三终态都落库，半条带中断标记；崩溃（未到终态）丢失可接受。
//!
//! 中断标记形态（data_model 以 `interrupt_flag` 占位，此处定型）：TEXT 列，取
//! [`INTERRUPT_ERROR`] / [`INTERRUPT_CANCEL`] 之一；done 终态为 NULL。存储层对取值透传，
//! 语义解释集中在本模块（domain 是唯一出口，services / infra 只引用不另造）。

/// 终态落库中断标记：出错半条（自动重试替换前的中断条）。
pub const INTERRUPT_ERROR: &str = "error";
/// 终态落库中断标记：用户取消半条（FR-001：点停止后半条保留）。
pub const INTERRUPT_CANCEL: &str = "cancel";

/// 一次生成的终态（ADR-001 三态）。取消（cancel）经命令层确认，与 done / error 同属终态语义
/// （INT-001），到达任一终态即落库。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalState {
    /// 正常完成：整条落库，无中断标记。
    Done,
    /// 失败：半条（如有）带 `error` 中断标记落库；断流重试成功后整条替换。
    Error,
    /// 用户取消：半条（如有）带 `cancel` 中断标记落库。
    Cancelled,
}

impl TerminalState {
    /// 落库用中断标记（ADR-001）：done → None；error / cancel → 各自标记。
    pub const fn interrupt_flag(self) -> Option<&'static str> {
        match self {
            TerminalState::Done => None,
            TerminalState::Error => Some(INTERRUPT_ERROR),
            TerminalState::Cancelled => Some(INTERRUPT_CANCEL),
        }
    }

    /// 是否中断终态（半条语义：界面显示「已中断」标记的依据）。
    pub const fn is_interrupted(self) -> bool {
        !matches!(self, TerminalState::Done)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ADR-001 三终态 ↔ 中断标记的映射（存储层透传取值，映射只在这里）。
    #[test]
    fn terminal_state_maps_interrupt_flags() {
        assert_eq!(TerminalState::Done.interrupt_flag(), None);
        assert_eq!(TerminalState::Error.interrupt_flag(), Some(INTERRUPT_ERROR));
        assert_eq!(TerminalState::Cancelled.interrupt_flag(), Some(INTERRUPT_CANCEL));

        assert!(!TerminalState::Done.is_interrupted());
        assert!(TerminalState::Error.is_interrupted());
        assert!(TerminalState::Cancelled.is_interrupted());
    }
}
