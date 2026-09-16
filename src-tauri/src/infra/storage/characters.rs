//! characters 表查询（FR-006 / DOM-001）。软删过滤统一封装在本层（ADR-009）。
//! 这里的自由函数只做单条 SQL，接收 `&Connection`；事务边界与连接持有在 `super`（mod.rs）。

use rusqlite::{params, Connection, Row};

use crate::domain::error::StorageError;
use crate::domain::models::{Character, NewCharacter, UpdateCharacter};

use super::now;

pub(crate) const ENTITY: &str = "character";

const COLS: &str = "id, name, avatar, persona, gender, age, render_style, \
                    model_provider_id, model_name, model_temperature, \
                    model_top_p, model_frequency_penalty, model_presence_penalty, \
                    accent_color, anim_duration_ms, anim_rhythm_ms, anim_punct_pause, \
                    titles, \
                    created_at, updated_at, deleted_at";

/// titles 列（JSON 文本）→ Vec；NULL = 空数组。坏 JSON 属后端数据损坏，上抛不吞。
fn parse_titles(raw: Option<String>) -> Result<Vec<String>, StorageError> {
    match raw {
        None => Ok(Vec::new()),
        Some(text) => serde_json::from_str(&text)
            .map_err(|e| StorageError::Backend(format!("characters.titles 非法 JSON：{e}"))),
    }
}

fn serialize_titles(titles: &[String]) -> Result<String, StorageError> {
    serde_json::to_string(titles)
        .map_err(|e| StorageError::Backend(format!("characters.titles 序列化失败：{e}")))
}

/// 行 → 领域对象；titles 解析需携带领域错误，故不走 `rusqlite::Result` 闭包签名
/// （与 scenes.rs 的 scene_from_row 同款）。
fn character_from_row(row: &Row<'_>) -> Result<Character, StorageError> {
    let titles_raw: Option<String> = row.get(17)?;
    Ok(Character {
        id: row.get(0)?,
        name: row.get(1)?,
        avatar: row.get(2)?,
        persona: row.get(3)?,
        gender: row.get(4)?,
        age: row.get(5)?,
        render_style: row.get(6)?,
        model_provider_id: row.get(7)?,
        model_name: row.get(8)?,
        model_temperature: row.get(9)?,
        model_top_p: row.get(10)?,
        model_frequency_penalty: row.get(11)?,
        model_presence_penalty: row.get(12)?,
        accent_color: row.get(13)?,
        anim_duration_ms: row.get(14)?,
        anim_rhythm_ms: row.get(15)?,
        anim_punct_pause: row.get::<_, Option<i64>>(16)?.map(|v| v != 0),
        titles: parse_titles(titles_raw)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
        deleted_at: row.get(20)?,
    })
}

pub(crate) fn insert(conn: &Connection, new: &NewCharacter) -> Result<Character, StorageError> {
    let ts = now();
    let titles = serialize_titles(&new.titles)?;
    conn.execute(
               "INSERT INTO characters (name, avatar, persona, gender, age, render_style, \
             model_provider_id, model_name, model_temperature, \
             model_top_p, model_frequency_penalty, model_presence_penalty, \
             accent_color, anim_duration_ms, anim_rhythm_ms, anim_punct_pause, \
             titles, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)",
        params![
            new.name,
            new.avatar,
            new.persona,
            new.gender,
            new.age,
            new.render_style,
            new.model_provider_id,
            new.model_name,
            new.model_temperature,
            new.model_top_p,
            new.model_frequency_penalty,
            new.model_presence_penalty,
            new.accent_color,
            new.anim_duration_ms,
            new.anim_rhythm_ms,
            new.anim_punct_pause.map(i64::from),
            titles,
            ts,
        ],
    )?;
    Ok(Character {
        id: conn.last_insert_rowid(),
        name: new.name.clone(),
        avatar: new.avatar.clone(),
        persona: new.persona.clone(),
        gender: new.gender.clone(),
        age: new.age.clone(),
        render_style: new.render_style.clone(),
        model_provider_id: new.model_provider_id.clone(),
        model_name: new.model_name.clone(),
        model_temperature: new.model_temperature,
        model_top_p: new.model_top_p,
        model_frequency_penalty: new.model_frequency_penalty,
        model_presence_penalty: new.model_presence_penalty,
        accent_color: new.accent_color.clone(),
        anim_duration_ms: new.anim_duration_ms,
        anim_rhythm_ms: new.anim_rhythm_ms,
        anim_punct_pause: new.anim_punct_pause,
        titles: new.titles.clone(),
        created_at: ts,
        updated_at: ts,
        deleted_at: None,
    })
}

/// 在世角色卡（`deleted_at IS NULL`），按创建顺序。
pub(crate) fn list(conn: &Connection) -> Result<Vec<Character>, StorageError> {
    let sql = format!("SELECT {COLS} FROM characters WHERE deleted_at IS NULL ORDER BY id ASC");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(character_from_row(row)?);
    }
    Ok(out)
}

/// 按 id 取在世角色卡；不存在或已软删均报 NotFound（对调用方等价，ADR-009）。
pub(crate) fn get(conn: &Connection, id: i64) -> Result<Character, StorageError> {
    let sql =
        format!("SELECT {COLS} FROM characters WHERE id = ?1 AND deleted_at IS NULL");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => character_from_row(row),
        None => Err(StorageError::NotFound { entity: ENTITY, id }),
    }
}

/// 整卡覆盖更新；目标在世才生效（墓碑行不可改），bump updated_at。
pub(crate) fn update(
    conn: &Connection,
    id: i64,
    upd: &UpdateCharacter,
) -> Result<(), StorageError> {
    let titles = serialize_titles(&upd.titles)?;
    let n = conn.execute(
               "UPDATE characters SET name = ?1, avatar = ?2, persona = ?3, gender = ?4, age = ?5, \
             render_style = ?6, model_provider_id = ?7, model_name = ?8, model_temperature = ?9, \
             model_top_p = ?10, model_frequency_penalty = ?11, model_presence_penalty = ?12, \
             accent_color = ?13, anim_duration_ms = ?14, anim_rhythm_ms = ?15, \
             anim_punct_pause = ?16, titles = ?17, updated_at = ?18 \
             WHERE id = ?19 AND deleted_at IS NULL",
        params![
            upd.name,
            upd.avatar,
            upd.persona,
            upd.gender,
            upd.age,
            upd.render_style,
            upd.model_provider_id,
            upd.model_name,
            upd.model_temperature,
            upd.model_top_p,
            upd.model_frequency_penalty,
            upd.model_presence_penalty,
            upd.accent_color,
            upd.anim_duration_ms,
            upd.anim_rhythm_ms,
            upd.anim_punct_pause.map(i64::from),
            titles,
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
            gender: None,
            age: None,
            render_style: Some("type".into()),
            model_provider_id: None,
            model_name: None,
            model_temperature: None,
            model_top_p: None,
            model_frequency_penalty: None,
            model_presence_penalty: None,
            accent_color: None,
            anim_duration_ms: None,
            anim_rhythm_ms: None,
            anim_punct_pause: None,
            titles: Vec::new(),
        }
    }

    #[test]
    fn character_crud_roundtrip() {
        let (storage, dir) = temp_storage("char_crud");
        let id = storage.create_character(&sample("艾莉")).unwrap().id;

        let got = storage.get_character(id).unwrap();
        assert_eq!(got.name, "艾莉");
        // 新建默认 NULL = 跟随全局（0014 语义，NewCharacter::default）。
        assert_eq!(got.render_style, None);
        assert_eq!(got.deleted_at, None);

        // 更新：全字段覆盖 + 头像写入再清除
        let upd = UpdateCharacter {
            name: "艾莉丝".to_string(),
            avatar: Some("data:image/png;base64,xxx".to_string()),
            persona: " 你是时间旅人。".to_string(),
            gender: Some("女".to_string()),
            age: Some("24".to_string()),
            render_style: Some("fade".to_string()),
            model_provider_id: Some("p1".to_string()),
            model_name: Some("gpt-x".to_string()),
            model_temperature: Some(0.8),
            model_top_p: Some(0.9),
            model_frequency_penalty: Some(-1.5),
            model_presence_penalty: Some(0.5),
            accent_color: Some("#6b46b8".to_string()),
            anim_duration_ms: Some(600),
            anim_rhythm_ms: Some(80),
            anim_punct_pause: Some(false),
            titles: vec!["布拉维坎的屠夫".to_string(), "利维亚的战士".to_string()],
        };
        storage.update_character(id, &upd).unwrap();
        let got = storage.get_character(id).unwrap();
        assert_eq!(got.name, "艾莉丝");
        assert_eq!(got.avatar.as_deref(), Some("data:image/png;base64,xxx"));
        assert_eq!(got.persona, " 你是时间旅人。");
        assert_eq!(got.gender.as_deref(), Some("女"));
        assert_eq!(got.age.as_deref(), Some("24"));
        assert_eq!(got.render_style.as_deref(), Some("fade"));
        // 称号集合（0016）：多值 JSON 数组往返
        assert_eq!(got.titles, ["布拉维坎的屠夫", "利维亚的战士"]);
        // 模型覆写三标量（0015 扁平化）：全字段覆盖结果
        assert_eq!(got.model_provider_id.as_deref(), Some("p1"));
        assert_eq!(got.model_name.as_deref(), Some("gpt-x"));
        assert_eq!(got.model_temperature, Some(0.8));
        // 采样参数三列（0018）：全字段覆盖结果
        assert_eq!(got.model_top_p, Some(0.9));
        assert_eq!(got.model_frequency_penalty, Some(-1.5));
        assert_eq!(got.model_presence_penalty, Some(0.5));
        assert_eq!(got.accent_color.as_deref(), Some("#6b46b8"));
        // 演出参数覆写（0013）：上面 upd 已带 Some 值，直接断言全字段覆盖结果
        assert_eq!(got.anim_duration_ms, Some(600));
        assert_eq!(got.anim_rhythm_ms, Some(80));
        assert_eq!(got.anim_punct_pause, Some(false));
        // 覆写清除（None = 跟随全局）
        let upd_clear_anim = UpdateCharacter {
            anim_duration_ms: None,
            anim_rhythm_ms: None,
            anim_punct_pause: None,
            ..upd.clone()
        };
        storage.update_character(id, &upd_clear_anim).unwrap();
        let got = storage.get_character(id).unwrap();
        assert_eq!(got.anim_duration_ms, None);
        assert_eq!(got.anim_punct_pause, None);
        // 模型覆写清除（None = 跟随全局）
        let upd_clear_model = UpdateCharacter {
            model_provider_id: None,
            model_name: None,
            model_temperature: None,
            model_top_p: None,
            model_frequency_penalty: None,
            model_presence_penalty: None,
            ..upd.clone()
        };
        storage.update_character(id, &upd_clear_model).unwrap();
        let got = storage.get_character(id).unwrap();
        assert_eq!(got.model_provider_id, None);
        assert_eq!(got.model_name, None);
        assert_eq!(got.model_temperature, None);
        // 强调色清除（None = 跟随海报派生）
        let upd_clear_accent = UpdateCharacter { accent_color: None, ..upd.clone() };
        storage.update_character(id, &upd_clear_accent).unwrap();
        assert_eq!(storage.get_character(id).unwrap().accent_color, None);

        // 称号清除（空数组 = 清空全部，恒落 "[]" 不落 NULL）
        let upd_clear_titles = UpdateCharacter { titles: Vec::new(), ..upd.clone() };
        storage.update_character(id, &upd_clear_titles).unwrap();
        assert!(storage.get_character(id).unwrap().titles.is_empty());

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
