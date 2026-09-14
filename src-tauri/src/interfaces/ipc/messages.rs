//! 消息域（ADR-001 落库原语的读路径）：`ChatMessage` wire DTO 与消息列表。

use serde::Serialize;
use specta::Type;
use tauri::State;

use crate::domain::models;
use crate::domain::ports::StoragePort;
use crate::state::AppState;

use super::error::IpcError;

/// 消息角色（data_model：role CHECK IN ('user', 'assistant')）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Assistant,
}

impl From<models::MessageRole> for MessageRole {
    fn from(role: models::MessageRole) -> Self {
        match role {
            models::MessageRole::User => MessageRole::User,
            models::MessageRole::Assistant => MessageRole::Assistant,
        }
    }
}

/// 聊天消息（前端 ChatMessage；wire 定案 Task-31）：字段名沿用 `characterId`
/// （旧 wire 相容名，避免纯改名 churn），语义已是「说话人实例 id 真值」——
/// assistant → messages.instance_id（未指认的旧行为 null），user → null（用户条
/// 调用方按 role 渲染，无需实例 id；实例身份的权威回显在 SessionSummary.instances
/// 与状态 DTO 的 instanceId，消费方勿把本字段当模板卡 id 用）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: i64,
    pub session_id: i64,
    pub character_id: Option<i64>,
    pub role: MessageRole,
    /// 原始 markdown-lite 正文，显示时才解析（BR-005）。
    pub content: String,
    /// 思考内容，与正文分离（FR-003）。
    pub reasoning: Option<String>,
    /// 思考可见时长（毫秒）。
    pub think_ms: Option<i64>,
    pub created_at: i64,
    /// 终态落库中断标记（ADR-001）。
    pub interrupted: bool,
}

// 领域消息 → wire DTO；生成闭环（send / regenerate，见 generation 域）的返回值
// 同样经本助手产出，故对 ipc 子树可见。
pub(super) fn to_chat_message(message: models::Message, character_id: Option<i64>) -> ChatMessage {
    ChatMessage {
        id: message.id,
        session_id: message.session_id,
        character_id,
        role: MessageRole::from(message.role),
        content: message.content,
        reasoning: message.reasoning,
        think_ms: message.think_ms,
        created_at: message.created_at,
        interrupted: message.interrupt_flag.is_some(),
    }
}

fn list_messages_impl(app: &AppState, session_id: i64) -> Result<Vec<ChatMessage>, IpcError> {
    app.storage.get_session(session_id)?;
    Ok(app
        .storage
        .list_messages(session_id)?
        .into_iter()
        .map(|m| {
            // 说话人实例真值（多角色换挂）：assistant 取 messages.instance_id；
            // user 恒 null（保留旧 wire 语义）。字段名沿用 characterId、值=实例
            // 真值的 wire 定案见 ChatMessage 结构体文档注释。
            let speaker = match m.role {
                models::MessageRole::Assistant => m.instance_id,
                models::MessageRole::User => None,
            };
            to_chat_message(m, speaker)
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn list_messages(
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<Vec<ChatMessage>, IpcError> {
    list_messages_impl(&state, session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::{NewMessage, NewSession, RosterPick};
    use crate::domain::ports::StoragePort;
    use crate::interfaces::ipc::test_support::{sample_character, temp_state};

    #[test]
    fn chat_message_serializes_camel_case_and_interrupted() {
        let msg = to_chat_message(
            models::Message {
                id: 9,
                session_id: 1,
                role: models::MessageRole::Assistant,
                content: "**雨**落".into(),
                reasoning: Some("氛围".into()),
                think_ms: Some(1800),
                tokens: None,
                created_at: 42,
                interrupt_flag: Some("user_cancel".into()),
                scene_id: None,
                instance_id: Some(5),
                deleted_at: None,
            },
            Some(5),
        );
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["sessionId"], 1);
        assert_eq!(json["characterId"], 5);
        assert_eq!(json["role"], "assistant");
        assert_eq!(json["thinkMs"], 1800);
        assert_eq!(json["createdAt"], 42);
        assert_eq!(json["interrupted"], true, "interrupt_flag 有值即 interrupted");
    }

    #[test]
    fn user_message_has_null_character() {
        let msg = to_chat_message(
            models::Message {
                role: models::MessageRole::User,
                interrupt_flag: None,
                id: 1,
                session_id: 1,
                content: String::new(),
                reasoning: None,
                think_ms: None,
                tokens: None,
                created_at: 1,
                scene_id: None,
                instance_id: None,
                deleted_at: None,
            },
            None,
        );
        let json = serde_json::to_value(&msg).unwrap();
        assert!(json["characterId"].is_null(), "用户消息 characterId 必须为 null");
        assert_eq!(json["interrupted"], false);
    }

    #[test]
    fn message_commands_derive_character_and_reject_missing_session() {
        let (app, dir) = temp_state("messages");
        let user_card = sample_character(&app, "旅人");
        let llm_card = sample_character(&app, "林深");
        let session = app
            .storage
            .create_session(&NewSession {
                roster: vec![
                    RosterPick { character_id: llm_card.id, is_user: false },
                    RosterPick { character_id: user_card.id, is_user: true },
                ],
                title: String::new(),
                opening: None,
            
            default_render_style: "type".to_string(),
        })
            .unwrap();
        // roster 首位 = LLM 位 → 其实例 id = 1（说话人真值换挂）。
        let llm_instance = app
            .storage
            .list_instances(session.id)
            .unwrap()
            .into_iter()
            .find(|i| !i.is_user)
            .unwrap()
            .id;
        app.storage
            .insert_message(&NewMessage::new(session.id, models::MessageRole::User, "在吗？"))
            .unwrap();
        app.storage
            .insert_message(&NewMessage {
                session_id: session.id,
                role: models::MessageRole::Assistant,
                content: "在。".into(),
                reasoning: Some("低语".into()),
                think_ms: Some(1200),
                tokens: None,
                interrupt_flag: None,
                instance_id: Some(llm_instance),
            })
            .unwrap();

        let listed = list_messages_impl(&app, session.id).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed[0].character_id.is_none(), "用户消息 speaker 为 null");
        // 语义变化（多角色换挂）：speaker = messages.instance_id 实例真值（不再由
        // 命令层从 sessions.character_id 推导假值）。
        assert_eq!(listed[1].character_id, Some(llm_instance), "assistant speaker = 说话人实例");
        assert_eq!(listed[1].think_ms, Some(1200));

        assert!(matches!(
            list_messages_impl(&app, 12345),
            Err(IpcError::NotFound { .. })
        ));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
