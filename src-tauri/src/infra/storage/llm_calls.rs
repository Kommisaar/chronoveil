//! llm_calls 表查询（透明化功能：LLM 调用轨迹）。
//!
//! 日志性质旁路数据：**只插不改不删**——全库软删除约定（ADR-009）在此不适用
//! （无 deleted_at 列、无软删端口），轨迹保留全量供面板回放，清理交由后续维护路径。
//! 这里的自由函数只做单条 SQL，接收 `&Connection`；事务边界与连接持有在 `super`。

use rusqlite::{params, Connection, Row};

use crate::domain::error::StorageError;
use crate::domain::models::{LlmCall, LlmCallKind, LlmCallStatus, NewLlmCall};

const COLS: &str = "id, session_id, kind, model, started_at, duration_ms, prompt_json, \
                    response_text, reasoning_text, tool_calls_json, prompt_tokens, \
                    completion_tokens, status, error_text";

/// 行 → 领域对象；kind / status 需从库值解析（未知值属后端数据损坏，上抛不吞）。
fn call_from_row(row: &Row<'_>) -> Result<LlmCall, StorageError> {
    let kind_raw: String = row.get(2)?;
    let status_raw: String = row.get(12)?;
    Ok(LlmCall {
        id: row.get(0)?,
        session_id: row.get(1)?,
        kind: LlmCallKind::from_db(&kind_raw)?,
        model: row.get(3)?,
        started_at: row.get(4)?,
        duration_ms: row.get(5)?,
        prompt_json: row.get(6)?,
        response_text: row.get(7)?,
        reasoning_text: row.get(8)?,
        tool_calls_json: row.get(9)?,
        prompt_tokens: row.get(10)?,
        completion_tokens: row.get(11)?,
        status: LlmCallStatus::from_db(&status_raw)?,
        error_text: row.get(13)?,
    })
}

/// 插入一条调用轨迹；id 由自增主键分配。
pub(crate) fn insert(conn: &Connection, new: &NewLlmCall) -> Result<LlmCall, StorageError> {
    conn.execute(
        "INSERT INTO llm_calls (session_id, kind, model, started_at, duration_ms, prompt_json, \
             response_text, reasoning_text, tool_calls_json, prompt_tokens, completion_tokens, \
             status, error_text) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            new.session_id,
            new.kind.as_str(),
            new.model,
            new.started_at,
            new.duration_ms,
            new.prompt_json,
            new.response_text,
            new.reasoning_text,
            new.tool_calls_json,
            new.prompt_tokens,
            new.completion_tokens,
            new.status.as_str(),
            new.error_text,
        ],
    )?;
    Ok(LlmCall {
        id: conn.last_insert_rowid(),
        session_id: new.session_id,
        kind: new.kind,
        model: new.model.clone(),
        started_at: new.started_at,
        duration_ms: new.duration_ms,
        prompt_json: new.prompt_json.clone(),
        response_text: new.response_text.clone(),
        reasoning_text: new.reasoning_text.clone(),
        tool_calls_json: new.tool_calls_json.clone(),
        prompt_tokens: new.prompt_tokens,
        completion_tokens: new.completion_tokens,
        status: new.status,
        error_text: new.error_text.clone(),
    })
}

/// 会话内轨迹，按 id 倒序（最新在前），`limit` 截断。无会话的起草调用
/// （session_id = NULL）不进任何会话查询（WHERE session_id = ?1 天然排除）。
pub(crate) fn list_by_session(
    conn: &Connection,
    session_id: i64,
    limit: u32,
) -> Result<Vec<LlmCall>, StorageError> {
    let sql =
        format!("SELECT {COLS} FROM llm_calls WHERE session_id = ?1 ORDER BY id DESC LIMIT ?2");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![session_id, limit])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(call_from_row(row)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ports::StoragePort;
    use crate::infra::storage::test_support::temp_storage;
    use crate::infra::storage::Storage;
    use std::path::PathBuf;

    /// 夹具：角色 + 会话，返回 (storage, dir, session_id)。
    fn setup(tag: &str) -> (Storage, PathBuf, i64) {
        let (storage, dir) = temp_storage(tag);
        let char_id = storage
            .create_character(&crate::domain::models::NewCharacter {
                name: "苏鸢".into(),
                ..Default::default()
            })
            .unwrap()
            .id;
        let session_id = storage
            .create_session(&crate::domain::models::NewSession {
                character_id: char_id,
                title: String::new(),
                opening: None,
            })
            .unwrap()
            .id;
        (storage, dir, session_id)
    }

    fn new_call(session_id: Option<i64>, kind: LlmCallKind, status: LlmCallStatus) -> NewLlmCall {
        NewLlmCall {
            session_id,
            kind,
            model: "test-model".into(),
            started_at: 1_000,
            duration_ms: 42,
            prompt_json: r#"[{"role":"user","content":"你好"}]"#.into(),
            response_text: Some("在。".into()),
            reasoning_text: Some("想了想".into()),
            tool_calls_json: None,
            prompt_tokens: Some(12),
            completion_tokens: Some(34),
            status,
            error_text: if status == LlmCallStatus::Error {
                Some("LLM 服务返回状态 500".into())
            } else {
                None
            },
        }
    }

    /// 插入后原样读回：全字段往返一致（含可空 usage 与 draft 的 NULL 会话）。
    #[test]
    fn insert_roundtrips_all_fields() {
        let (storage, dir, session_id) = setup("llmcall_roundtrip");
        let inserted = storage
            .insert_llm_call(&new_call(Some(session_id), LlmCallKind::Dialogue, LlmCallStatus::Ok))
            .unwrap();
        assert!(inserted.id > 0);
        let listed = storage.list_llm_calls(session_id, 10).unwrap();
        assert_eq!(listed, vec![inserted.clone()]);

        // draft：NULL 会话 + error 终态 + 无 usage / 无 reasoning 全可空形态。
        let draft = storage
            .insert_llm_call(&NewLlmCall {
                response_text: None,
                reasoning_text: None,
                prompt_tokens: None,
                completion_tokens: None,
                error_text: Some("LLM 请求超时".into()),
                ..new_call(None, LlmCallKind::Draft, LlmCallStatus::Error)
            })
            .unwrap();
        assert_eq!(draft.session_id, None);
        assert_eq!(draft.kind, LlmCallKind::Draft);
        assert_eq!(draft.status, LlmCallStatus::Error);
        assert_eq!(draft.prompt_tokens, None);
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 列表语义：id 倒序（最新在前）、limit 截断取最新、跨会话隔离、
    /// NULL 会话（draft）不进会话查询。
    #[test]
    fn list_orders_desc_filters_session_and_caps() {
        let (storage, dir, session_id) = setup("llmcall_list");
        let char_id = storage.list_characters().unwrap()[0].id;
        let other = storage
            .create_session(&crate::domain::models::NewSession {
                character_id: char_id,
                title: String::new(),
                opening: None,
            })
            .unwrap()
            .id;
        for i in 0..5 {
            let mut call = new_call(Some(session_id), LlmCallKind::Dialogue, LlmCallStatus::Ok);
            call.started_at = i;
            storage.insert_llm_call(&call).unwrap();
        }
        storage
            .insert_llm_call(&new_call(Some(other), LlmCallKind::Explorer, LlmCallStatus::Ok))
            .unwrap();
        storage
            .insert_llm_call(&new_call(None, LlmCallKind::Draft, LlmCallStatus::Ok))
            .unwrap();

        let listed = storage.list_llm_calls(session_id, 200).unwrap();
        assert_eq!(listed.len(), 5, "只含本会话轨迹（他 session 与 draft 不入）");
        let mut ids: Vec<i64> = listed.iter().map(|c| c.id).collect();
        assert!(ids.windows(2).all(|w| w[0] > w[1]), "按 id 倒序：{ids:?}");

        // limit 截断取最新 2 条。
        let capped = storage.list_llm_calls(session_id, 2).unwrap();
        assert_eq!(capped.len(), 2);
        ids = capped.iter().map(|c| c.id).collect();
        assert_eq!(ids, listed.iter().take(2).map(|c| c.id).collect::<Vec<_>>(), "截断保留最新");
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
