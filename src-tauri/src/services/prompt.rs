//! Prompt 装配（TASK-006 / FR-001 / FR-003）：纯函数，可单测，不做 IO。
//!
//! v1 装配约定（UC-001 主流程第 2 步）：
//! - system = 人设卡 persona（在场完整人设，BR-001「在场完整、不在场一行带过」的 v1 单角色形态）；
//! - greeting 约定：开场白作为第一条 assistant 回合进上下文——模型知道自己已经说过什么，
//!   不会复述开场白（greeting 与聊天正文同为 markdown-lite，DOM-001）；
//! - 上下文 = 条数滑窗最近 N 条（ADR-002，[`crate::domain::context`]），只取原始正文
//!   （reasoning 不进上下文：它是给用户看的思考，不是对话内容）。

use crate::domain::context;
use crate::domain::models::{Character, Message, MessageRole};
use crate::infra::llm::{ChatMessage, ChatRole};

/// 装配一次聊天的完整 messages：system(persona) + assistant(greeting) + 滑窗上下文。
/// persona / greeting 为空白时各自跳过（角色卡允许空人设，退化成纯上下文对话）。
pub fn assemble(character: &Character, history: &[Message]) -> Vec<ChatMessage> {
    let mut out = Vec::new();
    if !character.persona.trim().is_empty() {
        out.push(ChatMessage::new(ChatRole::System, character.persona.clone()));
    }
    if !character.greeting.trim().is_empty() {
        out.push(ChatMessage::new(ChatRole::Assistant, character.greeting.clone()));
    }
    for message in context::recent_messages(history, context::DEFAULT_CONTEXT_WINDOW) {
        let role = match message.role {
            MessageRole::User => ChatRole::User,
            MessageRole::Assistant => ChatRole::Assistant,
        };
        out.push(ChatMessage::new(role, message.content.clone()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::{NewCharacter, NewMessage};

    fn character(persona: &str, greeting: &str) -> Character {
        let new = NewCharacter {
            name: "苏鸢".into(),
            persona: persona.into(),
            greeting: greeting.into(),
            ..Default::default()
        };
        Character {
            id: 1,
            name: new.name,
            avatar: None,
            persona: new.persona,
            greeting: new.greeting,
            render_style: new.render_style,
            model_config: None,
            voice_config: None,
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
        }
    }

    fn history(pairs: &[(&str, MessageRole)]) -> Vec<Message> {
        pairs
            .iter()
            .enumerate()
            .map(|(i, (content, role))| {
                let new = NewMessage::new(1, *role, *content);
                Message {
                    id: i as i64,
                    session_id: 1,
                    role: new.role,
                    content: new.content,
                    reasoning: None,
                    think_ms: None,
                    tokens: None,
                    created_at: i as i64,
                    interrupt_flag: None,
                    deleted_at: None,
                }
            })
            .collect()
    }

    /// FR-001 / UC-001：system(persona) + assistant(greeting) + user/assistant 上下文。
    #[test]
    fn assembles_persona_greeting_and_history() {
        let c = character("雨夜电话亭的守夜人。", "雨点敲着窗棂。");
        let messages = assemble(&c, &history(&[("在吗？", MessageRole::User), ("在。", MessageRole::Assistant)]));

        assert_eq!(messages.len(), 4, "system + greeting + 2 条上下文");
        assert_eq!(messages[0].role, ChatRole::System);
        assert_eq!(messages[0].content, "雨夜电话亭的守夜人。");
        assert_eq!(
            messages[1].role,
            ChatRole::Assistant,
            "greeting 约定：开场白作为第一条 assistant 回合"
        );
        assert_eq!(messages[1].content, "雨点敲着窗棂。");
        assert_eq!(messages[2].role, ChatRole::User);
        assert_eq!(messages[3].role, ChatRole::Assistant);
    }

    /// ADR-002：上下文走条数滑窗（默认 40），更早的静默丢弃；reasoning 不进 prompt。
    #[test]
    fn applies_sliding_window_and_skips_reasoning() {
        let c = character("人设", "");
        let mut all: Vec<Message> = history(&[]);
        for i in 0..(context::DEFAULT_CONTEXT_WINDOW + 10) {
            let mut m = NewMessage::new(1, MessageRole::User, format!("m{i}"));
            m.reasoning = Some("不该进上下文的思考".into());
            all.push(Message {
                id: i as i64,
                session_id: 1,
                role: m.role,
                content: m.content,
                reasoning: m.reasoning,
                think_ms: None,
                tokens: None,
                created_at: i as i64,
                interrupt_flag: None,
                deleted_at: None,
            });
        }

        let messages = assemble(&c, &all);
        // 无 greeting：system + 40 条滑窗
        assert_eq!(messages.len(), 1 + context::DEFAULT_CONTEXT_WINDOW);
        assert_eq!(messages[1].content, "m10", "最早 10 条被静默丢弃（ADR-002）");
        assert!(messages.iter().all(|m| !m.content.contains("不该进上下文的思考")));
    }

    /// 空人设 / 空开场白各自跳过，不产生空 system / 空 assistant 回合。
    #[test]
    fn skips_blank_persona_and_greeting() {
        let c = character("  ", "");
        let messages = assemble(&c, &history(&[("你好", MessageRole::User)]));
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, ChatRole::User);
    }
}
