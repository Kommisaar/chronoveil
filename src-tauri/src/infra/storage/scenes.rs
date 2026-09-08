//! scenes 表查询（FR-011 数据地基）。软删过滤统一封装在本层（ADR-009）。
//! 这里的自由函数只做单条 SQL，接收 `&Connection`；事务边界与连接持有在 `super`（mod.rs）。

use rusqlite::{params, Connection, Row};

use crate::domain::error::StorageError;
use crate::domain::models::{NewScene, Scene};

const COLS: &str = "id, session_id, idx, location, time_note, fic_day, fic_part, \
                    date_label, summary, present, deleted_at";
/// present 列（JSON 文本）→ Vec；NULL = 空数组。坏 JSON 属后端数据损坏，上抛不吞。
fn parse_present(raw: Option<String>) -> Result<Vec<i64>, StorageError> {
    match raw {
        None => Ok(Vec::new()),
        Some(text) => serde_json::from_str(&text)
            .map_err(|e| StorageError::Backend(format!("scenes.present 非法 JSON：{e}"))),
    }
}

fn serialize_present(present: &[i64]) -> Result<String, StorageError> {
    serde_json::to_string(present)
        .map_err(|e| StorageError::Backend(format!("scenes.present 序列化失败：{e}")))
}

/// 行 → 领域对象；present 解析需携带领域错误，故不走 `rusqlite::Result` 闭包签名。
fn scene_from_row(row: &Row<'_>) -> Result<Scene, StorageError> {
    let present_raw: Option<String> = row.get(9)?;
    Ok(Scene {
        id: row.get(0)?,
        session_id: row.get(1)?,
        idx: row.get(2)?,
        location: row.get(3)?,
        time_note: row.get(4)?,
        fic_day: row.get(5)?,
        fic_part: row.get(6)?,
        date_label: row.get(7)?,
        summary: row.get(8)?,
        present: parse_present(present_raw)?,
        deleted_at: row.get(10)?,
    })
}

/// 插入场景；idx 同会话单调自增——MAX 计入墓碑行，全历史不重号（迁移 0002 注）。
pub(crate) fn insert(conn: &Connection, new: &NewScene) -> Result<Scene, StorageError> {
    let idx: i64 = conn.query_row(
        "SELECT COALESCE(MAX(idx) + 1, 0) FROM scenes WHERE session_id = ?1",
        params![new.session_id],
        |r| r.get(0),
    )?;
    let present = serialize_present(&new.present)?;
    conn.execute(
        "INSERT INTO scenes (session_id, idx, location, time_note, fic_day, fic_part, \
             date_label, summary, present) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            new.session_id,
            idx,
            new.location,
            new.time_note,
            new.fic_day,
            new.fic_part,
            new.date_label,
            new.summary,
            present,
        ],
    )?;
    Ok(Scene {
        id: conn.last_insert_rowid(),
        session_id: new.session_id,
        idx,
        location: new.location.clone(),
        time_note: new.time_note.clone(),
        fic_day: new.fic_day,
        fic_part: new.fic_part.clone(),
        date_label: new.date_label.clone(),
        summary: new.summary.clone(),
        present: new.present.clone(),
        deleted_at: None,
    })
}

/// 会话内在世场景，按 idx 升序（叙事顺序）。
pub(crate) fn list_by_session(
    conn: &Connection,
    session_id: i64,
) -> Result<Vec<Scene>, StorageError> {
    let sql = format!(
        "SELECT {COLS} FROM scenes WHERE session_id = ?1 AND deleted_at IS NULL ORDER BY idx ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![session_id])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(scene_from_row(row)?);
    }
    Ok(out)
}

/// 最后一个在世场景；没有则 None。
pub(crate) fn latest(conn: &Connection, session_id: i64) -> Result<Option<Scene>, StorageError> {
    let sql = format!(
        "SELECT {COLS} FROM scenes WHERE session_id = ?1 AND deleted_at IS NULL \
         ORDER BY idx DESC LIMIT 1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![session_id])?;
    match rows.next()? {
        Some(row) => Ok(Some(scene_from_row(row)?)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::{MessageRole, NewCharacter, NewMessage, NewSession};
    use crate::domain::ports::StoragePort;
    use crate::infra::storage::{test_support::temp_storage, Storage};
    use rusqlite::Connection;
    use std::path::PathBuf;

    /// 测试夹具：建角色 + 会话，返回 (storage, dir, session_id)。
    fn setup(tag: &str) -> (Storage, PathBuf, i64) {
        let (storage, dir) = temp_storage(tag);
        let char_id = storage
            .create_character(&NewCharacter { name: "艾莉".into(), ..Default::default() })
            .unwrap()
            .id;
        let session_id = storage
            .create_session(&NewSession { character_id: char_id, title: String::new() })
            .unwrap()
            .id;
        (storage, dir, session_id)
    }

    fn scene(session_id: i64, day: i64, summary: &str) -> NewScene {
        NewScene {
            session_id,
            location: Some("钟楼下".into()),
            time_note: Some("入夜".into()),
            fic_day: Some(day),
            fic_part: Some("夜".into()),
            date_label: Some("白蜡月·晨露日".into()),
            summary: Some(summary.into()),
            present: vec![1, 2],
        }
    }

    /// 验收 3：插入 idx 单调自增；按会话列表按 idx 升序；latest 取最大 idx。
    #[test]
    fn insert_idx_monotonic_and_latest() {
        let (storage, dir, sid) = setup("scene_idx");
        let s0 = storage.insert_scene(&scene(sid, 1, "开场")).unwrap();
        let s1 = storage.insert_scene(&scene(sid, 2, "推进")).unwrap();
        let s2 = storage.insert_scene(&scene(sid, 3, "高潮")).unwrap();
        assert_eq!((s0.idx, s1.idx, s2.idx), (0, 1, 2), "idx 从 0 起单调自增");
        assert_eq!(s0.present, vec![1, 2], "在场数组往返一致");

        let list = storage.list_scenes(sid).unwrap();
        let idxes: Vec<i64> = list.iter().map(|s| s.idx).collect();
        assert_eq!(idxes, vec![0, 1, 2]);

        let latest = storage.latest_scene(sid).unwrap().unwrap();
        assert_eq!(latest.id, s2.id, "latest = 最大 idx 的在世场景");
        assert_eq!(latest.summary.as_deref(), Some("高潮"));

        // 空会话 latest = None
        let char_id = storage.list_characters().unwrap()[0].id;
        let other = storage
            .create_session(&NewSession { character_id: char_id, title: String::new() })
            .unwrap();
        let _ = storage.insert_message(&NewMessage::new(other.id, MessageRole::User, "hi"));
        assert!(storage.latest_scene(other.id).unwrap().is_none());
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 验收 3：软删过滤（墓碑行不入列表 / latest）+ 墓碑计序（idx 继续增长不重号）。
    /// 软删写入路径属结算任务，此处经 SQL 预置墓碑以验证查询过滤语义（ADR-009）。
    #[test]
    fn tombstones_hidden_and_idx_keeps_growing() {
        let (storage, dir, sid) = setup("scene_tomb");
        let keep = storage.insert_scene(&scene(sid, 1, "留存")).unwrap().id;
        let gone = storage.insert_scene(&scene(sid, 2, "删我")).unwrap().id;
        drop(storage);

        {
            let conn = Connection::open(&dir.join("test.db")).unwrap();
            conn.execute(
                "UPDATE scenes SET deleted_at = 123 WHERE id = ?1",
                params![gone],
            )
            .unwrap();
        }
        let storage = Storage::open(&dir.join("test.db")).unwrap();
        let list = storage.list_scenes(sid).unwrap();
        assert_eq!(list.len(), 1, "墓碑行不得入列表（ADR-009）");
        assert_eq!(list[0].id, keep);
        assert_eq!(storage.latest_scene(sid).unwrap().unwrap().id, keep);

        // idx 以墓碑行计序：新场景继续 2 之后，不与墓碑重号
        let next = storage.insert_scene(&scene(sid, 3, "新场")).unwrap();
        assert_eq!(next.idx, 2, "墓碑行参与 MAX 计序");
        assert_eq!(storage.list_scenes(sid).unwrap().len(), 2);
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 多会话隔离：A 会话的场景不出现在 B 会话查询里。
    #[test]
    fn scenes_isolated_per_session() {
        let (storage, dir, sid_a) = setup("scene_iso");
        let char_id = storage.list_characters().unwrap()[0].id;
        let sid_b = storage
            .create_session(&NewSession { character_id: char_id, title: String::new() })
            .unwrap()
            .id;
        storage.insert_scene(&scene(sid_a, 1, "A 场")).unwrap();
        assert!(storage.list_scenes(sid_b).unwrap().is_empty());
        assert!(storage.latest_scene(sid_b).unwrap().is_none());
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
