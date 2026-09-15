//! worlds 表查询（2026-09-15 世界卡定稿）：世界观资产 CRUD。软删过滤统一封装
//! 在本层（ADR-009）。这里的自由函数只做单条 SQL，接收 `&Connection`；事务边界
//! 与连接持有在 `super`（storage.rs）。

use rusqlite::{params, Connection, Row};

use crate::domain::error::StorageError;
use crate::domain::models::{NewWorld, UpdateWorld, World};

use super::now;

pub(crate) const ENTITY: &str = "world";

const COLS: &str = "id, name, worldbook, calendar_config, created_at, updated_at, deleted_at";

fn row_to_world(row: &Row<'_>) -> rusqlite::Result<World> {
    Ok(World {
        id: row.get(0)?,
        name: row.get(1)?,
        worldbook: row.get(2)?,
        // 存储形态 = Rust serde 产出的 snake_case JSON 文本，本层透传不解析
        // （parse 在消费方 fiction_time::parse，坏 JSON 由其降级默认历兜底）。
        calendar_config: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        deleted_at: row.get(6)?,
    })
}

pub(crate) fn insert(conn: &Connection, new: &NewWorld) -> Result<World, StorageError> {
    let ts = now();
    conn.execute(
        "INSERT INTO worlds (name, worldbook, calendar_config, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![new.name, new.worldbook, new.calendar_config, ts],
    )?;
    Ok(World {
        id: conn.last_insert_rowid(),
        name: new.name.clone(),
        worldbook: new.worldbook.clone(),
        calendar_config: new.calendar_config.clone(),
        created_at: ts,
        updated_at: ts,
        deleted_at: None,
    })
}

/// 在世世界卡，按创建顺序。
pub(crate) fn list(conn: &Connection) -> Result<Vec<World>, StorageError> {
    let sql = format!("SELECT {COLS} FROM worlds WHERE deleted_at IS NULL ORDER BY id ASC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_world)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 按 id 取在世世界卡；不存在或已软删均报 NotFound（对调用方等价，ADR-009）。
/// 建会话实例化路径（sessions::insert）复用本函数做必选校验。
pub(crate) fn get(conn: &Connection, id: i64) -> Result<World, StorageError> {
    let sql = format!("SELECT {COLS} FROM worlds WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], row_to_world)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound { entity: ENTITY, id },
            other => other.into(),
        })
}

/// 整卡覆盖更新；目标在世才生效（墓碑行不可改），bump updated_at。
pub(crate) fn update(
    conn: &Connection,
    id: i64,
    upd: &UpdateWorld,
) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE worlds SET name = ?1, worldbook = ?2, calendar_config = ?3, updated_at = ?4 \
         WHERE id = ?5 AND deleted_at IS NULL",
        params![upd.name, upd.worldbook, upd.calendar_config, now(), id],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

pub(crate) fn soft_delete(conn: &Connection, id: i64, ts: i64) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE worlds SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, ts],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

pub(crate) fn restore(conn: &Connection, id: i64) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE worlds SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
        params![id],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

#[cfg(test)]
mod tests;
