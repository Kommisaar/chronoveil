//! characters 表查询（FR-006 / DOM-001）。软删过滤统一封装在本层（ADR-009）。
//! 这里的自由函数只做单条 SQL，接收 `&Connection`；事务边界与连接持有在 `super`（mod.rs）。

use rusqlite::{params, Connection, Row};

use crate::domain::error::StorageError;
use crate::domain::models::{Character, NewCharacter, UpdateCharacter};

use super::now;

pub(crate) const ENTITY: &str = "character";

const COLS: &str = "id, name, avatar, persona, greeting, render_style, model_config, \
                    voice_config, calendar_config, accent_color, created_at, updated_at, \
                    deleted_at";

fn row_to_character(row: &Row<'_>) -> rusqlite::Result<Character> {
    Ok(Character {
        id: row.get(0)?,
        name: row.get(1)?,
        avatar: row.get(2)?,
        persona: row.get(3)?,
        greeting: row.get(4)?,
        render_style: row.get(5)?,
        model_config: row.get(6)?,
        voice_config: row.get(7)?,
        calendar_config: row.get(8)?,
        accent_color: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        deleted_at: row.get(12)?,
    })
}

pub(crate) fn insert(conn: &Connection, new: &NewCharacter) -> Result<Character, StorageError> {
    let ts = now();
    // calendar_config 的入参接线随角色卡编辑任务（NewCharacter 暂无该字段，落库 NULL = 内置默认历）。
    conn.execute(
        "INSERT INTO characters (name, avatar, persona, greeting, render_style, \
             model_config, voice_config, accent_color, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            new.name,
            new.avatar,
            new.persona,
            new.greeting,
            new.render_style,
            new.model_config,
            new.voice_config,
            new.accent_color,
            ts,
        ],
    )?;
    Ok(Character {
        id: conn.last_insert_rowid(),
        name: new.name.clone(),
        avatar: new.avatar.clone(),
        persona: new.persona.clone(),
        greeting: new.greeting.clone(),
        render_style: new.render_style.clone(),
        model_config: new.model_config.clone(),
        voice_config: new.voice_config.clone(),
        accent_color: new.accent_color.clone(),
        calendar_config: None,
        created_at: ts,
        updated_at: ts,
        deleted_at: None,
    })
}

/// 在世角色卡（`deleted_at IS NULL`），按创建顺序。
pub(crate) fn list(conn: &Connection) -> Result<Vec<Character>, StorageError> {
    let sql = format!("SELECT {COLS} FROM characters WHERE deleted_at IS NULL ORDER BY id ASC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_character)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 按 id 取在世角色卡；不存在或已软删均报 NotFound（对调用方等价，ADR-009）。
pub(crate) fn get(conn: &Connection, id: i64) -> Result<Character, StorageError> {
    let sql =
        format!("SELECT {COLS} FROM characters WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], row_to_character)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound { entity: ENTITY, id },
            other => other.into(),
        })
}

/// 整卡覆盖更新；目标在世才生效（墓碑行不可改），bump updated_at。
pub(crate) fn update(
    conn: &Connection,
    id: i64,
    upd: &UpdateCharacter,
) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE characters SET name = ?1, avatar = ?2, persona = ?3, greeting = ?4, \
             render_style = ?5, model_config = ?6, voice_config = ?7, accent_color = ?8, \
             updated_at = ?9 WHERE id = ?10 AND deleted_at IS NULL",
        params![
            upd.name,
            upd.avatar,
            upd.persona,
            upd.greeting,
            upd.render_style,
            upd.model_config,
            upd.voice_config,
            upd.accent_color,
            now(),
            id,
        ],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

pub(crate) fn soft_delete(conn: &Connection, id: i64, ts: i64) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE characters SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, ts],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

pub(crate) fn restore(conn: &Connection, id: i64) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE characters SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
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
    use crate::domain::models::NewCharacter;
    use crate::domain::ports::StoragePort;
    use crate::infra::storage::test_support::{cleanup, temp_storage};

    fn sample(name: &str) -> NewCharacter {
        NewCharacter {
            name: name.to_string(),
            ..NewCharacter::default()
        }
    }

    fn upd_default() -> UpdateCharacter {
        UpdateCharacter {
            name: String::new(),
            avatar: None,
            persona: String::new(),
            greeting: String::new(),
            render_style: "typewriter".into(),
            model_config: None,
            accent_color: None,
            voice_config: None,
        }
    }

    #[test]
    fn character_crud_roundtrip() {
        let (storage, dir) = temp_storage("char_crud");
        let id = storage.create_character(&sample("艾莉")).unwrap().id;

        let got = storage.get_character(id).unwrap();
        assert_eq!(got.name, "艾莉");
        assert_eq!(got.render_style, "typewriter");
        assert_eq!(got.deleted_at, None);

        // 更新：全字段覆盖 + 头像写入再清除
        let upd = UpdateCharacter {
            name: "艾莉丝".to_string(),
            avatar: Some("data:image/png;base64,xxx".to_string()),
            persona: " 你是时间旅人。".to_string(),
            greeting: " *她转过身* 你来了。".to_string(),
            render_style: "fade".to_string(),
            model_config: Some(r#"{"temperature":0.8}"#.to_string()),
            accent_color: Some("#6b46b8".to_string()),
            voice_config: None,
        };
        storage.update_character(id, &upd).unwrap();
        let got = storage.get_character(id).unwrap();
        assert_eq!(got.name, "艾莉丝");
        assert_eq!(got.avatar.as_deref(), Some("data:image/png;base64,xxx"));
        assert_eq!(got.persona, " 你是时间旅人。");
        assert_eq!(got.render_style, "fade");
        assert_eq!(got.model_config.as_deref(), Some(r#"{"temperature":0.8}"#));
        assert_eq!(got.accent_color.as_deref(), Some("#6b46b8"));
        // 强调色清除（None = 跟随海报派生）
        let upd_clear_accent = UpdateCharacter { accent_color: None, ..upd.clone() };
        storage.update_character(id, &upd_clear_accent).unwrap();
        assert_eq!(storage.get_character(id).unwrap().accent_color, None);

        let upd_clear = UpdateCharacter { avatar: None, ..upd };
        storage.update_character(id, &upd_clear).unwrap();
        assert_eq!(storage.get_character(id).unwrap().avatar, None);

        // 列表可见
        assert_eq!(storage.list_characters().unwrap().len(), 1);
        drop(storage);
        cleanup(&dir);
    }

    #[test]
    fn soft_deleted_character_hidden_then_restored() {
        let (storage, dir) = temp_storage("char_softdel");
        let keep = storage.create_character(&sample("留存")).unwrap().id;
        let gone = storage.create_character(&sample("删除我")).unwrap().id;

        storage.soft_delete_character(gone).unwrap();
        let list = storage.list_characters().unwrap();
        assert_eq!(list.len(), 1, "软删后 list 不得含墓碑行（ADR-009）");
        assert_eq!(list[0].id, keep);
        assert!(matches!(
            storage.get_character(gone),
            Err(StorageError::NotFound { .. })
        ));
        // 墓碑行不可改
        assert!(matches!(
            storage.update_character(gone, &UpdateCharacter { name: "x".into(), ..upd_default() }),
            Err(StorageError::NotFound { .. })
        ));

        // 误删可恢复：清墓碑即还原（ADR-009）
        storage.restore_character(gone).unwrap();
        assert_eq!(storage.list_characters().unwrap().len(), 2);
        drop(storage);
        cleanup(&dir);
    }
}
