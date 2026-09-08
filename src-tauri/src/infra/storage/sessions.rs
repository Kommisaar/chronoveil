//! sessions 表查询（FR-007：多会话管理）。软删过滤统一封装在本层（ADR-009）。

use rusqlite::{params, Connection, Row};

use crate::domain::error::StorageError;
use crate::domain::models::{NewSession, Session};

use super::now;

pub(crate) const ENTITY: &str = "session";

const COLS: &str = "id, character_id, title, calendar_config, created_at, updated_at, deleted_at";

fn row_to_session(row: &Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get(0)?,
        character_id: row.get(1)?,
        title: row.get(2)?,
        calendar_config: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        deleted_at: row.get(6)?,
    })
}

pub(crate) fn insert(conn: &Connection, new: &NewSession) -> Result<Session, StorageError> {
    let ts = now();
    // 建会话日历快照（FR-013；data_model「日历归属与继承」）：从被引用的角色行复制，
    // 之后各自演进互不回写；角色为 NULL 则会话亦 NULL = 内置默认历。
    // 只做数据复制、不查墓碑（可见性由 FK 与调用方语义决定，与 create_session 既有行为一致）。
    let calendar_config: Option<String> = match conn.query_row(
        "SELECT calendar_config FROM characters WHERE id = ?1",
        params![new.character_id],
        |r| r.get::<_, Option<String>>(0),
    ) {
        Ok(v) => v,
        // 角色不存在：日历取 None，由下方 INSERT 的外键检查报 Conflict（保持既有错误语义）。
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(e.into()),
    };
    conn.execute(
        "INSERT INTO sessions (character_id, title, calendar_config, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![new.character_id, new.title, calendar_config, ts],
    )?;
    Ok(Session {
        id: conn.last_insert_rowid(),
        character_id: new.character_id,
        title: new.title.clone(),
        calendar_config,
        created_at: ts,
        updated_at: ts,
        deleted_at: None,
    })
}

/// 在世会话，按 updated_at 倒序（FR-007）；同刻以 id 降序保稳定。
pub(crate) fn list_by_updated_desc(conn: &Connection) -> Result<Vec<Session>, StorageError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM sessions WHERE deleted_at IS NULL \
         ORDER BY updated_at DESC, id DESC"
    ))?;
    let rows = stmt.query_map([], row_to_session)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub(crate) fn get(conn: &Connection, id: i64) -> Result<Session, StorageError> {
    let sql = format!("SELECT {COLS} FROM sessions WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], row_to_session)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound { entity: ENTITY, id },
            other => other.into(),
        })
}

/// 刷新 updated_at（排序用）；只动时间戳，不参与可见性语义，故不过滤墓碑。
pub(crate) fn touch_at(conn: &Connection, id: i64, ts: i64) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
        params![id, ts],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

pub(crate) fn update_title(conn: &Connection, id: i64, title: &str) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE sessions SET title = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, title],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

pub(crate) fn soft_delete(conn: &Connection, id: i64, ts: i64) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE sessions SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, ts],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

pub(crate) fn restore(conn: &Connection, id: i64) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE sessions SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
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
    use crate::domain::models::MessageRole;
    use crate::domain::ports::StoragePort;
    use crate::infra::storage::test_support::{cleanup, temp_storage};
    use crate::infra::storage::Storage;
    use std::thread::sleep;
    use std::time::Duration;

    fn make_session(storage: &crate::infra::storage::Storage, title: &str) -> i64 {
        let char_id = storage
            .create_character(&crate::domain::models::NewCharacter {
                name: "卡".into(),
                ..Default::default()
            })
            .unwrap()
            .id;
        storage
            .create_session(&NewSession { character_id: char_id, title: title.into() })
            .unwrap()
            .id
    }

    /// 验收 4（TASK-011）：create_session 复制 characters.calendar_config 快照——
    /// 角色有日历则会话拿到同值；角色为 NULL（内置默认历）则会话亦 NULL。
    /// 角色卡日历的写入路径随角色卡编辑任务接线，此处经 SQL 预置以验证复制语义。
    #[test]
    fn create_session_snapshots_character_calendar() {
        let (storage, dir) = temp_storage("sess_calendar");
        let db_path = dir.join("test.db");
        let with_cal = storage
            .create_character(&crate::domain::models::NewCharacter {
                name: "有历".into(),
                ..Default::default()
            })
            .unwrap()
            .id;
        let without_cal = storage
            .create_character(&crate::domain::models::NewCharacter {
                name: "默认".into(),
                ..Default::default()
            })
            .unwrap()
            .id;
        drop(storage);

        // 预置角色卡日历（JSON 任意，存储层透传不解释）
        let config = r#"{"months":["白蜡月"],"daysPerMonth":30,"dayNames":["晨露日"]}"#;
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "UPDATE characters SET calendar_config = ?1 WHERE id = ?2",
                rusqlite::params![config, with_cal],
            )
            .unwrap();
        }

        let storage = Storage::open(&db_path).unwrap();
        let snapshotted = storage
            .create_session(&NewSession { character_id: with_cal, title: String::new() })
            .unwrap();
        assert_eq!(
            snapshotted.calendar_config.as_deref(),
            Some(config),
            "建会话必须复制角色卡日历快照（FR-013）"
        );
        // 快照随行读回一致
        assert_eq!(
            storage.get_session(snapshotted.id).unwrap().calendar_config.as_deref(),
            Some(config)
        );

        let default_cal = storage
            .create_session(&NewSession { character_id: without_cal, title: String::new() })
            .unwrap();
        assert_eq!(
            default_cal.calendar_config, None,
            "角色无日历（NULL）则会话亦 NULL = 内置默认历"
        );
        drop(storage);
        cleanup(&dir);
    }

    #[test]
    fn session_crud_and_title_update() {
        let (storage, dir) = temp_storage("sess_crud");
        let id = make_session(&storage, "");

        assert_eq!(storage.get_session(id).unwrap().title, "");

        storage.update_session_title(id, "第一夜").unwrap();
        assert_eq!(storage.get_session(id).unwrap().title, "第一夜");

        // 软删过滤 + NotFound + 还原
        storage.soft_delete_session(id).unwrap();
        assert!(storage.list_sessions().unwrap().is_empty());
        assert!(matches!(
            storage.get_session(id),
            Err(StorageError::NotFound { .. })
        ));
        storage.restore_session(id).unwrap();
        assert_eq!(storage.list_sessions().unwrap().len(), 1);
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sessions_listed_by_updated_at_desc() {
        let (storage, dir) = temp_storage("sess_order");
        let s1 = make_session(&storage, "一");
        sleep(Duration::from_millis(4));
        let s2 = make_session(&storage, "二");
        sleep(Duration::from_millis(4));
        let s3 = make_session(&storage, "三");

        let ids: Vec<i64> = storage
            .list_sessions()
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec![s3, s2, s1], "默认按 updated_at 倒序（FR-007）");

        // 触碰最旧的 s1 → 跳到最前
        sleep(Duration::from_millis(4));
        storage.touch_session(s1).unwrap();
        let ids: Vec<i64> = storage
            .list_sessions()
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec![s1, s3, s2]);

        // 新消息刷新 updated_at：往 s2 插一条后 s2 应排最前
        sleep(Duration::from_millis(4));
        let _ = storage
            .insert_message(&crate::domain::models::NewMessage::new(
                s2,
                MessageRole::User,
                "你好",
            ))
            .unwrap();
        let ids: Vec<i64> = storage
            .list_sessions()
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec![s2, s1, s3]);
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
