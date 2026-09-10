//! character_state 表查询（FR-012：会话内人物状态）。软删过滤统一封装在本层（ADR-009）。
//! 唯一约束选型（迁移 0002 / data_model 开工决策点）：partial unique index 只约束在世行，
//! 本模块 upsert 先查在世同键行再覆盖或插入，天然不触碰墓碑行。

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::domain::error::StorageError;
use crate::domain::models::{CharacterState, CharacterStateScope, NewCharacterState};

use super::now;

pub(crate) const ENTITY: &str = "character_state";

const COLS: &str = "id, character_id, session_id, scope, \"key\", value, expiry, \
                    source_scene, updated_at, deleted_at";

/// 行 → 领域对象；scope 解析需携带领域错误，故不走 `rusqlite::Result` 闭包签名。
fn state_from_row(row: &Row<'_>) -> Result<CharacterState, StorageError> {
    Ok(CharacterState {
        id: row.get(0)?,
        character_id: row.get(1)?,
        session_id: row.get(2)?,
        scope: CharacterStateScope::from_db(&row.get::<_, String>(3)?)?,
        key: row.get(4)?,
        value: row.get(5)?,
        expiry: row.get(6)?,
        source_scene: row.get(7)?,
        updated_at: row.get(8)?,
        deleted_at: row.get(9)?,
    })
}

/// 按主键取整行（upsert 内部回读用；不过滤墓碑——upsert 只产在世行）。
fn get_by_id(conn: &Connection, id: i64) -> Result<CharacterState, StorageError> {
    let sql = format!("SELECT {COLS} FROM character_state WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => state_from_row(row),
        None => Err(StorageError::NotFound { entity: ENTITY, id }),
    }
}

/// upsert：同键（character_id, session_id, key）在世行覆盖 value / expiry / source_scene
/// 并 bump updated_at；无在世同键行则插入（scope 只在插入时生效）。
/// 连接互斥串行（单进程单写入，data_model「迁移与并发」），查后写无竞态。
pub(crate) fn upsert(
    conn: &Connection,
    new: &NewCharacterState,
) -> Result<CharacterState, StorageError> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM character_state \
             WHERE character_id = ?1 AND session_id = ?2 AND \"key\" = ?3 AND deleted_at IS NULL",
            params![new.character_id, new.session_id, new.key],
            |r| r.get(0),
        )
        .optional()?;
    let id = match existing {
        Some(id) => {
            conn.execute(
                "UPDATE character_state SET value = ?2, expiry = ?3, source_scene = ?4, \
                     updated_at = ?5 \
                 WHERE id = ?1 AND deleted_at IS NULL",
                params![id, new.value, new.expiry, new.source_scene, now()],
            )?;
            id
        }
        // 墓碑行不阻塞重插：partial unique index 只约束在世行（迁移 0002 决策，验收 2）。
        None => {
            conn.execute(
                "INSERT INTO character_state (character_id, session_id, scope, \"key\", \
                     value, expiry, source_scene, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    new.character_id,
                    new.session_id,
                    new.scope.as_str(),
                    new.key,
                    new.value,
                    new.expiry,
                    new.source_scene,
                    now(),
                ],
            )?;
            conn.last_insert_rowid()
        }
    };
    get_by_id(conn, id)
}

/// 会话内全部在世状态（跨角色、不分组），按 id 升序（插入序稳定）。
pub(crate) fn list_by_session(
    conn: &Connection,
    session_id: i64,
) -> Result<Vec<CharacterState>, StorageError> {
    let sql = format!(
        "SELECT {COLS} FROM character_state WHERE session_id = ?1 AND deleted_at IS NULL \
         ORDER BY id ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![session_id])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(state_from_row(row)?);
    }
    Ok(out)
}

pub(crate) fn soft_delete(conn: &Connection, id: i64, ts: i64) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE character_state SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, ts],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::{NewCharacter, NewSession};
    use crate::domain::ports::StoragePort;
    use crate::infra::storage::{test_support::temp_storage, Storage};
    use std::path::PathBuf;
    use std::thread::sleep;
    use std::time::Duration;

    /// 测试夹具：建角色 + 会话，返回 (storage, dir, character_id, session_id)。
    fn setup(tag: &str) -> (Storage, PathBuf, i64, i64) {
        let (storage, dir) = temp_storage(tag);
        let char_id = storage
            .create_character(&NewCharacter { name: "艾莉".into(), ..Default::default() })
            .unwrap()
            .id;
        let session_id = storage
            .create_session(&NewSession { character_id: char_id, title: String::new(), opening: None })
            .unwrap()
            .id;
        (storage, dir, char_id, session_id)
    }

    fn state(char_id: i64, session_id: i64, key: &str, value: &str) -> NewCharacterState {
        NewCharacterState {
            character_id: char_id,
            session_id,
            scope: CharacterStateScope::State,
            key: key.into(),
            value: value.into(),
            expiry: Some("scene_end".into()),
            source_scene: None,
        }
    }

    /// 验收 3：同键覆盖 value / expiry / source_scene（同 id、scope 不变），updated_at 前进。
    #[test]
    fn upsert_overwrites_same_key() {
        let (storage, dir, cid, sid) = setup("state_upsert");
        let first = storage
            .upsert_character_state(&state(cid, sid, "情绪", "警觉"))
            .unwrap();
        assert_eq!(first.scope, CharacterStateScope::State);
        assert_eq!(first.expiry.as_deref(), Some("scene_end"));
        assert_eq!(first.deleted_at, None);

        sleep(Duration::from_millis(4));
        let second = storage
            .upsert_character_state(&NewCharacterState {
                expiry: Some("event:亮灯".into()),
                source_scene: Some(7),
                ..state(cid, sid, "情绪", "释然")
            })
            .unwrap();
        assert_eq!(second.id, first.id, "同键覆盖不换行");
        assert_eq!(second.value, "释然");
        assert_eq!(second.expiry.as_deref(), Some("event:亮灯"));
        assert_eq!(second.source_scene, Some(7));
        assert!(second.updated_at > first.updated_at, "覆盖必须 bump updated_at");
        assert_eq!(
            storage.list_character_states(sid).unwrap().len(),
            1,
            "同键覆盖后仍只有一行"
        );

        // 不同键 → 新行
        let other = storage
            .upsert_character_state(&state(cid, sid, "持有", "黄铜钥匙"))
            .unwrap();
        assert_ne!(other.id, first.id);
        assert_eq!(storage.list_character_states(sid).unwrap().len(), 2);
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 验收 2：软删墓碑行同键重插——partial unique index 只约束在世行，
    /// 重插为新行（新 id），墓碑原样保留。
    #[test]
    fn tombstone_does_not_block_same_key_reinsert() {
        let (storage, dir, cid, sid) = setup("state_tomb");
        let gone = storage
            .upsert_character_state(&state(cid, sid, "情绪", "警觉"))
            .unwrap();
        storage.soft_delete_character_state(gone.id).unwrap();
        assert!(
            storage.list_character_states(sid).unwrap().is_empty(),
            "软删后列表不得含墓碑行（ADR-009）"
        );
        assert!(matches!(
            storage.soft_delete_character_state(gone.id),
            Err(StorageError::NotFound { .. })
        ));

        let again = storage
            .upsert_character_state(&state(cid, sid, "情绪", "平静"))
            .unwrap();
        assert_ne!(again.id, gone.id, "重插是新行");
        assert_eq!(again.value, "平静");
        let list = storage.list_character_states(sid).unwrap();
        assert_eq!(list.len(), 1, "墓碑行不入列表，重插行可见");
        assert_eq!(list[0].id, again.id);
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 验收 3 + FR-012：状态挂 (character_id, session_id)——按会话查询跨角色可见、
    /// 软删过滤生效；scope=relation 与 state 并存。
    #[test]
    fn list_by_session_filters_and_covers_scopes() {
        let (storage, dir, cid, sid) = setup("state_list");
        let other_char = storage
            .create_character(&NewCharacter { name: "乙".into(), ..Default::default() })
            .unwrap()
            .id;

        let mut relation = state(cid, sid, "对乙的态度", "戒备");
        relation.scope = CharacterStateScope::Relation;
        let a = storage.upsert_character_state(&state(cid, sid, "情绪", "警觉")).unwrap();
        let b = storage.upsert_character_state(&relation).unwrap();
        // 另一角色、同一会话：按会话查询应一并返回（FR-012 会话内全景）
        let c = storage
            .upsert_character_state(&state(other_char, sid, "情绪", "平静"))
            .unwrap();
        // 干扰项：另一会话不可见
        let other_session = storage
            .create_session(&NewSession { character_id: cid, title: String::new(), opening: None })
            .unwrap()
            .id;
        storage
            .upsert_character_state(&state(cid, other_session, "情绪", "别串场"))
            .unwrap();

        let list = storage.list_character_states(sid).unwrap();
        let ids: Vec<i64> = list.iter().map(|s| s.id).collect();
        assert_eq!(ids, vec![a.id, b.id, c.id], "按 id 升序，跨角色、限会话");
        assert_eq!(list[1].scope, CharacterStateScope::Relation, "scope 往返一致");

        // 软删过滤
        storage.soft_delete_character_state(b.id).unwrap();
        let list = storage.list_character_states(sid).unwrap();
        let ids: Vec<i64> = list.iter().map(|s| s.id).collect();
        assert_eq!(ids, vec![a.id, c.id], "墓碑行被过滤");
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// scope 库值防御：非法值视为数据损坏（后端错误），不 panic。
    #[test]
    fn scope_from_db_rejects_unknown() {
        assert!(matches!(
            CharacterStateScope::from_db("mood"),
            Err(StorageError::Backend(_))
        ));
    }
}
