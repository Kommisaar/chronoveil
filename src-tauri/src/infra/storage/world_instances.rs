//! world_instances 表查询（2026-09-15 世界卡定稿）：会话内世界 = 世界卡的一次性
//! 快照（恰一，partial unique index 库级保证）。本模块的 insert 只被建会话事务
//! （sessions::insert）与分叉拷贝（session_fork）调用；读路径 world_instance
//! 供生成 / 结算 / 装配取世界观正文与历法（历法唯一归属，迁移 0017）。

use rusqlite::{params, Connection, Row};

use crate::domain::error::StorageError;
use crate::domain::models::{NewWorldInstance, WorldInstance};

use super::now;

const COLS: &str = "id, session_id, world_id, name, worldbook, calendar_config, \
                    created_at, deleted_at";

fn row_to_world_instance(row: &Row<'_>) -> rusqlite::Result<WorldInstance> {
    Ok(WorldInstance {
        id: row.get(0)?,
        session_id: row.get(1)?,
        world_id: row.get(2)?,
        name: row.get(3)?,
        worldbook: row.get(4)?,
        calendar_config: row.get(5)?,
        created_at: row.get(6)?,
        deleted_at: row.get(7)?,
    })
}

/// 落世界实例（建会话事务内专用）：恰一约束由 partial unique index 兜底，
/// 重复插入报 ConstraintViolation（→ StorageError::Conflict）。
pub(crate) fn insert(
    conn: &Connection,
    new: &NewWorldInstance,
) -> Result<WorldInstance, StorageError> {
    conn.execute(
        "INSERT INTO world_instances (session_id, world_id, name, worldbook, \
             calendar_config, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            new.session_id,
            new.world_id,
            new.name,
            new.worldbook,
            new.calendar_config,
            now(),
        ],
    )?;
    Ok(WorldInstance {
        id: conn.last_insert_rowid(),
        session_id: new.session_id,
        world_id: new.world_id,
        name: new.name.clone(),
        worldbook: new.worldbook.clone(),
        calendar_config: new.calendar_config.clone(),
        created_at: now(),
        deleted_at: None,
    })
}

/// 会话的在世世界实例（恰一：建会话事务保证存在，部分唯一索引保证至多一行）。
pub(crate) fn by_session(
    conn: &Connection,
    session_id: i64,
) -> Result<Option<WorldInstance>, StorageError> {
    let sql = format!(
        "SELECT {COLS} FROM world_instances \
         WHERE session_id = ?1 AND deleted_at IS NULL ORDER BY id ASC LIMIT 1"
    );
    conn.query_row(&sql, params![session_id], row_to_world_instance)
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.into()),
        })
}
