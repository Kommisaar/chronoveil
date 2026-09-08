//! 上下文装配纯函数（ADR-002）：v1 条数滑窗（最近 N 条，N≈40）；5b 换近景/远景结构（ADR-004）。
//!
//! 滑窗外早期对话对模型完全不可见（静默丢弃，ADR-002 代价条款）；不做 UI 提示（个人应用）。

use crate::domain::models::Message;

/// 默认滑窗条数（ADR-002：默认 N 开工时定，建议 40 → 定为 40；5b 落地时随 ADR-002 一起替换）。
pub const DEFAULT_CONTEXT_WINDOW: usize = 40;

/// 条数滑窗：取最近 `window` 条（保持对话顺序）。`window` 为 0 视为不携带任何历史。
/// 超出窗口的更早消息静默丢弃（ADR-002），调用方不感知。
pub fn recent_messages(messages: &[Message], window: usize) -> &[Message] {
    if window == 0 {
        return &[];
    }
    let start = messages.len().saturating_sub(window);
    &messages[start..]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::{MessageRole, NewMessage};

    fn msg(i: usize) -> Message {
        let new = NewMessage::new(1, MessageRole::User, format!("m{i}"));
        Message {
            id: i as i64,
            session_id: new.session_id,
            role: new.role,
            content: new.content,
            reasoning: None,
            think_ms: None,
            tokens: None,
            created_at: i as i64,
            interrupt_flag: None,
            deleted_at: None,
        }
    }

    /// ADR-002：只保留最近 N 条且顺序不变；不足 N 条全保留；N=0 无历史。
    #[test]
    fn sliding_window_keeps_latest_n_in_order() {
        let all: Vec<Message> = (0..100).map(msg).collect();

        let window = recent_messages(&all, DEFAULT_CONTEXT_WINDOW);
        assert_eq!(window.len(), DEFAULT_CONTEXT_WINDOW);
        assert_eq!(window[0].content, "m60", "丢最早的 60 条（静默丢弃）");
        assert_eq!(window.last().unwrap().content, "m99", "保持对话顺序");

        let short: Vec<Message> = (0..3).map(msg).collect();
        assert_eq!(recent_messages(&short, DEFAULT_CONTEXT_WINDOW).len(), 3);

        assert!(recent_messages(&all, 0).is_empty(), "窗口 0 = 不带历史");
        let two = recent_messages(&all, 2);
        assert_eq!(two.len(), 2);
        assert_eq!(two[0].content, "m98");
    }
}
