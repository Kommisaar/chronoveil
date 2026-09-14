//! character_instances 表查询（多角色群像地基，方案 §2 第 1 步：会话内运行时角色
//! 身份 = 角色卡一次性快照）。软删过滤统一封装在本层（ADR-009）。
//! 这里的自由函数只做单条 SQL，接收 `&Connection`；事务边界与连接持有在 `super`。

use rusqlite::{params, Connection, Row};

use crate::domain::error::StorageError;
use crate::domain::models::{CharacterInstance, NewCharacterInstance};

use super::now;

pub(crate) const ENTITY: &str = "character_instance";

const COLS: &str = "id, session_id, character_id, name, persona, render_style, is_user, \
                    created_at, deleted_at";

fn row_to_instance(row: &Row<'_>) -> rusqlite::Result<CharacterInstance> {
    Ok(CharacterInstance {
        id: row.get(0)?,
        session_id: row.get(1)?,
        character_id: row.get(2)?,
        name: row.get(3)?,
        persona: row.get(4)?,
        render_style: row.get(5)?,
        // 库值 0/1（CHECK 值域）；非零即真，坏值已由 CHECK 挡在写入侧。
        is_user: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
        deleted_at: row.get(8)?,
    })
}

pub(crate) fn insert(
    conn: &Connection,
    new: &NewCharacterInstance,
) -> Result<CharacterInstance, StorageError> {
    conn.execute(
        "INSERT INTO character_instances (session_id, character_id, name, persona, \
             render_style, is_user, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            new.session_id,
            new.character_id,
            new.name,
            new.persona,
            new.render_style,
            i64::from(new.is_user),
            now(),
        ],
    )?;
    Ok(CharacterInstance {
        id: conn.last_insert_rowid(),
        session_id: new.session_id,
        character_id: new.character_id,
        name: new.name.clone(),
        persona: new.persona.clone(),
        render_style: new.render_style.clone(),
        is_user: new.is_user,
        created_at: now(),
        deleted_at: None,
    })
}

/// 会话内在世实例：用户扮演位在前（is_user DESC），其余按创建序（id ASC）——
/// roster 展示序与装配分段序的基础。
pub(crate) fn list_by_session(
    conn: &Connection,
    session_id: i64,
) -> Result<Vec<CharacterInstance>, StorageError> {
    let sql = format!(
        "SELECT {COLS} FROM character_instances \
         WHERE session_id = ?1 AND deleted_at IS NULL ORDER BY is_user DESC, id ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![session_id], row_to_instance)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub(crate) fn get(conn: &Connection, id: i64) -> Result<CharacterInstance, StorageError> {
    let sql = format!("SELECT {COLS} FROM character_instances WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], row_to_instance)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound { entity: ENTITY, id },
            other => other.into(),
        })
}

pub(crate) fn soft_delete(conn: &Connection, id: i64, ts: i64) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE character_instances SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, ts],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

#[cfg(test)]
mod tests;
