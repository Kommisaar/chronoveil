//! sessions 表查询（FR-007：多会话管理）。软删过滤统一封装在本层（ADR-009）。

use rusqlite::{params, Connection, Row};

use crate::domain::error::StorageError;
use crate::domain::models::{NewScene, NewSession, Session};

use super::{now, scenes};

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

/// 角色卡日历快照（FR-013「日历归属与继承」）：从被引用的角色行复制，之后各自演进
/// 互不回写；角色为 NULL 则会话亦 NULL = 内置默认历。只做数据复制、不查墓碑（可见性
/// 由 FK 与调用方语义决定，与既有行为一致；角色不存在由外键检查报 Conflict）。
fn snapshot_calendar(
    conn: &Connection,
    character_id: i64,
) -> Result<Option<String>, StorageError> {
    match conn.query_row(
        "SELECT calendar_config FROM characters WHERE id = ?1",
        params![character_id],
        |r| r.get::<_, Option<String>>(0),
    ) {
        Ok(v) => Ok(v),
        // 角色不存在：日历取 None，由下方 INSERT 的外键检查报 Conflict（保持既有错误语义）。
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// 建会话（FR-007 + FR-014 开局包），单事务（unchecked_transaction，模式同
/// insert_message / commit_settlement）：会话行与开场锚行同生共死，任一失败整体回滚。
///
/// - 日历：向导显式指定优先（由 Rust 序列化 domain `CalendarConfig` 得 snake_case
///   存储 JSON，wire camelCase 不会入库），否则角色卡快照兜底（FR-013）；
/// - 开场锚行（scenes idx-0）**无条件 seed**（§7-6）：显式开局与降级路径（opening =
///   None）都落「第 1 天 · 夜」缺省锚（§7-3），保证 latest_scene 从第一拍就存在；
///   `fic_day` / `fic_part` 缺省取 1 / 夜，`date_label` 落库前经
///   `fiction_time::date_label` 派生（与结算共用同一函数），`present` = 会话角色。
pub(crate) fn insert(conn: &Connection, new: &NewSession) -> Result<Session, StorageError> {
    let ts = now();
    let tx = conn.unchecked_transaction()?;

    let explicit = new.opening.as_ref().and_then(|o| o.calendar.as_ref());
    let (calendar_config, calendar) = match explicit {
        Some(cal) => {
            let json = serde_json::to_string(cal)
                .map_err(|e| StorageError::Backend(format!("会话日历序列化失败：{e}")))?;
            (Some(json), cal.clone())
        }
        None => {
            let raw = snapshot_calendar(&tx, new.character_id)?;
            let cal = crate::domain::fiction_time::parse(raw.as_deref());
            (raw, cal)
        }
    };

    tx.execute(
        "INSERT INTO sessions (character_id, title, calendar_config, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![new.character_id, new.title, calendar_config, ts],
    )?;
    let session_id = tx.last_insert_rowid();

    // 开场锚行：day 缺省 1（防御性钳到 ≥1，入口校验在命令层）、part 缺省「夜」。
    let opening = new.opening.as_ref();
    let fic_day = opening.and_then(|o| o.fic_day).unwrap_or(1).max(1);
    let fic_part = opening
        .and_then(|o| o.fic_part.clone())
        .unwrap_or_else(|| "夜".to_string());
    scenes::insert(&tx, &NewScene {
        session_id,
        location: opening.and_then(|o| o.location.clone()),
        time_note: opening.and_then(|o| o.time_note.clone()),
        fic_day: Some(fic_day),
        fic_part: Some(fic_part.clone()),
        date_label: Some(crate::domain::fiction_time::date_label(
            &calendar, fic_day, &fic_part,
        )),
        summary: None,
        // 开场锚行无收束段，无 recap（Task-03）。
        recap: None,
        // 在场 = 会话角色（FR-014 §1；对齐导演备忘 §7-7 v1 收窄，单角色 roster）。
        present: vec![new.character_id],
    })?;

    tx.commit()?;
    Ok(Session {
        id: session_id,
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
    use crate::domain::fiction_time;
    use crate::domain::models::{MessageRole, NewCharacter, OpeningSeed};
    use crate::domain::ports::StoragePort;
    use crate::infra::storage::test_support::{cleanup, temp_storage};
    use crate::infra::storage::Storage;
    use rusqlite::Connection;
    use std::thread::sleep;
    use std::time::Duration;

    fn make_session(storage: &crate::infra::storage::Storage, title: &str) -> i64 {
        let char_id = storage
            .create_character(&NewCharacter {
                name: "卡".into(),
                ..Default::default()
            })
            .unwrap()
            .id;
        storage
            .create_session(&NewSession {
                character_id: char_id,
                title: title.into(),
                opening: None,
            })
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
            .create_character(&NewCharacter {
                name: "有历".into(),
                ..Default::default()
            })
            .unwrap()
            .id;
        let without_cal = storage
            .create_character(&NewCharacter {
                name: "默认".into(),
                ..Default::default()
            })
            .unwrap()
            .id;
        drop(storage);

        // 预置角色卡日历（JSON 任意，存储层透传不解释）
        let config = r#"{"months":["白蜡月"],"days_per_month":30,"dayNames":["晨露日"]}"#;
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
            .create_session(&NewSession {
                character_id: with_cal,
                title: String::new(),
                opening: None,
            })
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
            .create_session(&NewSession {
                character_id: without_cal,
                title: String::new(),
                opening: None,
            })
            .unwrap();
        assert_eq!(
            default_cal.calendar_config, None,
            "角色无日历（NULL）则会话亦 NULL = 内置默认历"
        );
        drop(storage);
        cleanup(&dir);
    }

    // ---- FR-014：开局包单事务落库 ----

    /// 夹具：建角色并返回 (storage, dir, char_id)。
    fn char_fixture(tag: &str) -> (Storage, std::path::PathBuf, i64) {
        let (storage, dir) = temp_storage(tag);
        let char_id = storage
            .create_character(&NewCharacter { name: "苏鸢".into(), ..Default::default() })
            .unwrap()
            .id;
        (storage, dir, char_id)
    }

    /// 显式开局：向导指定的日历 / 锚 / 场景字段逐一落库——日历覆盖快照（snake_case
    /// 存储 JSON）、锚行 idx=0、date_label 经 date_label 派生、present = 会话角色。
    #[test]
    fn opening_seeds_explicit_calendar_and_anchor_scene() {
        let (storage, dir, char_id) = char_fixture("opening_explicit");
        let preset = fiction_time::presets::fantasy();
        let session = storage
            .create_session(&NewSession {
                character_id: char_id,
                title: String::new(),
                opening: Some(OpeningSeed {
                    calendar: Some(preset.clone()),
                    fic_day: Some(45),
                    fic_part: Some("夜".into()),
                    location: Some("旧都 · 灯市".into()),
                    time_note: Some("灯节点亮的那一刻".into()),
                }),
            })
            .unwrap();

        // 日历显式指定优先于角色卡快照（本例角色无快照，JSON 为 Rust 序列化产物）。
        let stored = session.calendar_config.as_deref().unwrap();
        assert_eq!(fiction_time::parse(Some(stored)), preset, "显式日历原样落库");
        assert!(stored.contains("days_per_month"), "存储 JSON 为 snake_case：{stored}");

        let scene = storage.latest_scene(session.id).unwrap().unwrap();
        assert_eq!(scene.idx, 0, "开场锚 = 首场景行");
        assert_eq!(scene.fic_day, Some(45));
        assert_eq!(scene.fic_part.as_deref(), Some("夜"));
        assert_eq!(
            scene.date_label.as_deref(),
            Some("白蜡月·潮汐日·夜（灯节）"),
            "date_label 与结算共用 date_label 派生（日名按年内日序取模）"
        );
        assert_eq!(scene.location.as_deref(), Some("旧都 · 灯市"));
        assert_eq!(scene.time_note.as_deref(), Some("灯节点亮的那一刻"));
        assert_eq!(scene.summary, None, "开场行无摘要");
        assert_eq!(scene.present, vec![char_id], "在场 = 会话角色");
        drop(storage);
        cleanup(&dir);
    }

    /// 降级路径（opening = None）也无条件 seed 默认锚行：day=1 / part=夜；日历走
    /// 角色卡快照兜底，date_label 按快照皮肤派生（§7-6：从第一拍有账可记）。
    #[test]
    fn degraded_path_still_seeds_default_anchor_from_snapshot() {
        let (storage, dir) = temp_storage("opening_degraded");
        let char_id = storage
            .create_character(&NewCharacter { name: "有历".into(), ..Default::default() })
            .unwrap()
            .id;
        drop(storage);
        // 预置角色卡日历（带皮肤）：降级路径的锚行 date_label 应按快照派生。
        {
            let conn = Connection::open(dir.join("test.db")).unwrap();
            conn.execute(
                "UPDATE characters SET calendar_config = ?1 WHERE id = ?2",
                rusqlite::params![
                    r#"{"name":"旧都历","months":["霜月","白蜡月"],"days_per_month":30,"day_names":["晨露日","萤火日"]}"#,
                    char_id
                ],
            )
            .unwrap();
        }
        let storage = Storage::open(&dir.join("test.db")).unwrap();

        let session = storage
            .create_session(&NewSession {
                character_id: char_id,
                title: String::new(),
                opening: None,
            })
            .unwrap();
        assert!(
            session.calendar_config.is_some(),
            "降级路径日历 = 角色卡快照兜底"
        );
        let scene = storage.latest_scene(session.id).unwrap().unwrap();
        assert_eq!(scene.idx, 0);
        assert_eq!(scene.fic_day, Some(1), "day 缺省 1");
        assert_eq!(scene.fic_part.as_deref(), Some("夜"), "part 缺省「夜」");
        assert_eq!(
            scene.date_label.as_deref(),
            Some("霜月·晨露日·夜"),
            "date_label 按快照日历派生"
        );
        assert_eq!(scene.location, None, "降级路径无用户场景字段");
        assert_eq!(scene.time_note, None);
        drop(storage);
        cleanup(&dir);
    }

    /// 事务原子性：外键冲突（角色不存在）→ 会话行与开场锚行都不留痕迹。
    #[test]
    fn opening_rolls_back_session_and_scene_together() {
        let (storage, dir) = temp_storage("opening_rollback");
        let err = storage
            .create_session(&NewSession {
                character_id: 999_999,
                title: String::new(),
                opening: Some(OpeningSeed {
                    calendar: Some(fiction_time::presets::modern()),
                    fic_day: None,
                    fic_part: None,
                    location: None,
                    time_note: None,
                }),
            })
            .unwrap_err();
        assert!(matches!(err, StorageError::Conflict(_)), "实际：{err:?}");

        // scenes 表全库无行（会话行未落 → 锚行必然也未落）。
        let conn = Connection::open(dir.join("test.db")).unwrap();
        let scenes: i64 = conn
            .query_row("SELECT COUNT(*) FROM scenes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(scenes, 0, "开场锚行随会话行一并回滚");
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
