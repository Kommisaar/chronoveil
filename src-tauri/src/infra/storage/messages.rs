//! messages 表查询（ADR-001：终态落库原语）。软删过滤统一封装在本层（ADR-009）。
//! 重新生成 / 断流重试的「整条替换」= 软删旧条 + 插入新条（FR-008），事务边界在 `super`。

use rusqlite::{params, Connection, Row};

use crate::domain::error::StorageError;
use crate::domain::models::{Message, MessageRole, NewMessage};
use crate::domain::ports::AttachRange;

pub(crate) const ENTITY: &str = "message";

const COLS: &str = "id, session_id, role, content, reasoning, think_ms, tokens, \
                    created_at, interrupt_flag, scene_id, instance_id, deleted_at";

/// 库值 → 消息角色；未知值按列转换失败上报（数据损坏）。
fn role_from_db(value: &str) -> rusqlite::Result<MessageRole> {
    MessageRole::from_db(value).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            Box::new(e),
        )
    })
}

fn row_to_message(row: &Row<'_>) -> rusqlite::Result<Message> {
    Ok(Message {
        id: row.get(0)?,
        session_id: row.get(1)?,
        role: role_from_db(&row.get::<_, String>(2)?)?,
        content: row.get(3)?,
        reasoning: row.get(4)?,
        think_ms: row.get(5)?,
        tokens: row.get(6)?,
        created_at: row.get(7)?,
        interrupt_flag: row.get(8)?,
        // 结算 AttachRange 回填的场景归属；插入路径恒 NULL（NewMessage 不带此字段）。
        scene_id: row.get(9)?,
        // 说话人实例（多角色群像，迁移 0009）：随 NewMessage 携带写入。
        instance_id: row.get(10)?,
        deleted_at: row.get(11)?,
    })
}

pub(crate) fn insert(conn: &Connection, new: &NewMessage, ts: i64) -> Result<Message, StorageError> {
    conn.execute(
        "INSERT INTO messages (session_id, role, content, reasoning, think_ms, tokens, \
             created_at, interrupt_flag, instance_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            new.session_id,
            new.role.as_str(),
            new.content,
            new.reasoning,
            new.think_ms,
            new.tokens,
            ts,
            new.interrupt_flag,
            new.instance_id,
        ],
    )?;
    Ok(Message {
        id: conn.last_insert_rowid(),
        session_id: new.session_id,
        role: new.role,
        content: new.content.clone(),
        reasoning: new.reasoning.clone(),
        think_ms: new.think_ms,
        tokens: new.tokens,
        created_at: ts,
        interrupt_flag: new.interrupt_flag.clone(),
        scene_id: None,
        instance_id: new.instance_id,
        deleted_at: None,
    })
}

/// 会话内在世消息，按 id 升序（对话顺序）。
pub(crate) fn list_by_session(
    conn: &Connection,
    session_id: i64,
) -> Result<Vec<Message>, StorageError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM messages \
         WHERE session_id = ?1 AND deleted_at IS NULL ORDER BY id ASC"
    ))?;
    let rows = stmt.query_map(params![session_id], row_to_message)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 最后一条在世 assistant 消息（软删行跳过）。
pub(crate) fn latest_assistant(
    conn: &Connection,
    session_id: i64,
) -> Result<Option<Message>, StorageError> {
    let sql = format!(
        "SELECT {COLS} FROM messages \
         WHERE session_id = ?1 AND role = 'assistant' AND deleted_at IS NULL \
         ORDER BY id DESC LIMIT 1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(params![session_id], row_to_message)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 软删最后一条在世 assistant 消息；返回被置墓碑的 id（没有则 None，不视为错误）。
pub(crate) fn soft_delete_latest_assistant(
    conn: &Connection,
    session_id: i64,
    ts: i64,
) -> Result<Option<i64>, StorageError> {
    let target: Option<i64> = conn
        .query_row(
            "SELECT id FROM messages \
             WHERE session_id = ?1 AND role = 'assistant' AND deleted_at IS NULL \
             ORDER BY id DESC LIMIT 1",
            params![session_id],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    if let Some(id) = target {
        conn.execute(
            "UPDATE messages SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, ts],
        )?;
    }
    Ok(target)
}

/// 收束段消息归属（FR-011）：半开区间 `(after, upto]` 内的在世消息挂到 `scene_id`。
/// 幂等：重复 UPDATE 同一归属值不变；软删行（被替换的旧条）不参与。
pub(crate) fn attach_to_scene(
    conn: &Connection,
    session_id: i64,
    range: &AttachRange,
) -> Result<usize, StorageError> {
    let n = conn.execute(
        "UPDATE messages SET scene_id = ?4 \
         WHERE session_id = ?1 AND deleted_at IS NULL AND id > ?2 AND id <= ?3",
        params![session_id, range.after_message_id, range.upto_message_id, range.scene_id],
    )?;
    Ok(n)
}

pub(crate) fn soft_delete(conn: &Connection, id: i64, ts: i64) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE messages SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, ts],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

pub(crate) fn restore(conn: &Connection, id: i64) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE messages SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
        params![id],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::{NewCharacter, NewSession, RosterPick};
    use crate::domain::ports::StoragePort;
    use crate::infra::storage::test_support::temp_storage;
    use std::thread::sleep;
    use std::time::Duration;

    fn setup(storage: &crate::infra::storage::Storage) -> i64 {
        let user_card = storage
            .create_character(&NewCharacter { name: "旅人".into(), ..Default::default() })
            .unwrap()
            .id;
        let llm_card = storage
            .create_character(&NewCharacter { name: "卡".into(), ..Default::default() })
            .unwrap()
            .id;
        storage
            .create_session(&NewSession {
                roster: vec![
                    RosterPick { character_id: user_card, is_user: true },
                    RosterPick { character_id: llm_card, is_user: false },
                ],
                title: String::new(),
                opening: None,
            })
            .unwrap()
            .id
    }

    /// 终态落库往返（ADR-001）：reasoning 与正文分离、think_ms / tokens / interrupt_flag
    /// / instance_id 保留。
    #[test]
    fn terminal_state_roundtrip() {
        let (storage, dir) = temp_storage("msg_roundtrip");
        let sid = setup(&storage);

        // 说话人实例 = 阵容中的 LLM 位（恰一用户位，LLM 位可指认归属）。
        let llm_instance = storage
            .list_instances(sid)
            .unwrap()
            .into_iter()
            .find(|i| !i.is_user)
            .unwrap()
            .id;
        let user = storage
            .insert_message(&NewMessage::new(sid, MessageRole::User, "**你好**"))
            .unwrap();
        let assistant = storage
            .insert_message(&NewMessage {
                session_id: sid,
                role: MessageRole::Assistant,
                content: "*她抬头* ……".into(),
                reasoning: Some("用户在打招呼，应当回应".into()),
                think_ms: Some(4200),
                tokens: Some(128),
                interrupt_flag: None,
                instance_id: Some(llm_instance),
            })
            .unwrap();
        // error / cancel 半条带中断标记（形态透传，ADR-001）
        storage
            .insert_message(&NewMessage {
                session_id: sid,
                role: MessageRole::Assistant,
                content: "写到一半".into(),
                reasoning: Some("思考了一半".into()),
                think_ms: Some(800),
                tokens: None,
                interrupt_flag: Some("cancel".into()),
                instance_id: Some(llm_instance),
            })
            .unwrap();

        let list = storage.list_messages(sid).unwrap();
        assert_eq!(list.len(), 3, "在世消息按对话顺序");
        assert_eq!(list[0].id, user.id);
        assert_eq!(list[0].role, MessageRole::User);
        assert_eq!(list[0].instance_id, None, "未指认归属透传 NULL");
        assert_eq!(list[1].id, assistant.id);
        assert_eq!(
            list[1].reasoning.as_deref(),
            Some("用户在打招呼，应当回应"),
            "reasoning 独立落库"
        );
        assert_eq!(list[1].content, "*她抬头* ……");
        assert_eq!(list[1].think_ms, Some(4200));
        assert_eq!(list[1].tokens, Some(128));
        assert_eq!(list[1].instance_id, Some(llm_instance), "说话人实例随行落库读回");
        assert_eq!(list[2].interrupt_flag.as_deref(), Some("cancel"), "中断标记保留");
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn soft_delete_hides_message_and_latest_assistant_skips_it() {
        let (storage, dir) = temp_storage("msg_softdel");
        let sid = setup(&storage);
        let a1 = storage
            .insert_message(&NewMessage::new(sid, MessageRole::Assistant, "第一条"))
            .unwrap();
        let a2 = storage
            .insert_message(&NewMessage::new(sid, MessageRole::Assistant, "第二条"))
            .unwrap();

        storage.soft_delete_message(a2.id).unwrap();
        let list = storage.list_messages(sid).unwrap();
        assert_eq!(list.len(), 1, "软删后 list 不含墓碑行（ADR-009）");
        assert_eq!(
            storage.latest_assistant_message(sid).unwrap().map(|m| m.id),
            Some(a1.id),
            "latest_assistant 跳过软删条"
        );

        storage.restore_message(a2.id).unwrap();
        assert_eq!(storage.list_messages(sid).unwrap().len(), 2);
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// replace_last_assistant（FR-008）：软删旧条 + 插新条；软删后重插不触发唯一约束冲突；
    /// 墓碑行保留（restore 可还原证明），但不构成可回看版本历史。
    #[test]
    fn replace_last_assistant_soft_deletes_old_and_inserts_new() {
        let (storage, dir) = temp_storage("msg_replace");
        let sid = setup(&storage);
        let _user = storage
            .insert_message(&NewMessage::new(sid, MessageRole::User, "讲个故事"))
            .unwrap();
        let old = storage
            .insert_message(&NewMessage {
                session_id: sid,
                role: MessageRole::Assistant,
                content: "旧版本故事".into(),
                reasoning: Some("旧思考".into()),
                think_ms: Some(100),
                tokens: Some(10),
                interrupt_flag: Some("error".into()),
                instance_id: None,
            })
            .unwrap();

        sleep(Duration::from_millis(2));
        let new = storage
            .replace_last_assistant_message(&NewMessage {
                session_id: sid,
                role: MessageRole::Assistant,
                content: "新版本故事".into(),
                reasoning: Some("新思考".into()),
                think_ms: Some(900),
                tokens: Some(64),
                interrupt_flag: None,
                instance_id: None,
            })
            .unwrap();
        assert_ne!(new.id, old.id, "新条是新插入行，主键不复用");

        let list = storage.list_messages(sid).unwrap();
        assert_eq!(list.len(), 2, "旧 assistant 已隐藏：user + 新 assistant");
        assert_eq!(list.last().unwrap().id, new.id);
        assert_eq!(new.content, "新版本故事");
        assert_eq!(new.interrupt_flag, None);
        assert_eq!(
            storage.latest_assistant_message(sid).unwrap().map(|m| m.id),
            Some(new.id)
        );

        // 墓碑行仍在库中（还原即可见），软删后重插无唯一约束冲突
        storage.restore_message(old.id).unwrap();
        let list = storage.list_messages(sid).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[1].id, old.id);
        assert_eq!(list[1].content, "旧版本故事");

        // 连续重新生成：再替换一次同样成立
        let newer = storage
            .replace_last_assistant_message(&NewMessage::new(sid, MessageRole::Assistant, "再再来"))
            .unwrap();
        assert_eq!(
            storage.latest_assistant_message(sid).unwrap().map(|m| m.id),
            Some(newer.id)
        );

        // 非 assistant 消息不得走整条替换
        assert!(matches!(
            storage.replace_last_assistant_message(&NewMessage::new(sid, MessageRole::User, "x")),
            Err(StorageError::Conflict(_))
        ));
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// FR-007：每条新消息刷新会话 updated_at（含 replace 路径）。
    #[test]
    fn insert_and_replace_touch_session_updated_at() {
        let (storage, dir) = temp_storage("msg_touch");
        let sid = setup(&storage);
        let before = storage.get_session(sid).unwrap().updated_at;

        sleep(Duration::from_millis(3));
        storage
            .insert_message(&NewMessage::new(sid, MessageRole::User, "你好"))
            .unwrap();
        let after_insert = storage.get_session(sid).unwrap().updated_at;
        assert!(after_insert > before, "insert_message 必须刷新会话 updated_at");

        sleep(Duration::from_millis(3));
        storage
            .replace_last_assistant_message(&NewMessage::new(
                sid,
                MessageRole::Assistant,
                "嗯",
            ))
            .unwrap();
        let after_replace = storage.get_session(sid).unwrap().updated_at;
        assert!(after_replace > after_insert, "replace 也必须刷新会话 updated_at");
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
