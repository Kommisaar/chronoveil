//! db.rs（CMP-003）：rusqlite 连接持有 + 手写顺序迁移 + 软删除统一过滤（ADR-009）。
//! 库文件：`~/.chronoveil/chronoveil.db`（ADR-012）。
//!
//! 分层约定（ADR-010）：本模块实现 `domain::ports::StoragePort`；调用方不写 SQL，
//! 「`deleted_at IS NULL` 过滤」「软删 = 置墓碑」「替换 = 软删旧条 + 插新条」全部封装在此。
//! 库内不存在任何 `DELETE FROM` 物理删除语句（ADR-009）。

mod character_states;
mod characters;
mod messages;
mod migrations;
mod scenes;
mod sessions;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use crate::domain::error::StorageError;
use crate::domain::models::{
    Character, CharacterState, Message, MessageRole, NewCharacter, NewCharacterState, NewMessage,
    NewScene, NewSession, Scene, Session, UpdateCharacter,
};
use crate::domain::ports::StoragePort;

/// SQLite 单文件持久化。内部互斥串行化访问（rusqlite Connection 非 Sync），
/// 对外 `&self` 即可调用，天然满足 Tauri `manage` 的 Send + Sync 要求。
pub struct Storage {
    conn: Mutex<Connection>,
}

/// 全库时间戳统一 Unix 毫秒（created_at / updated_at / deleted_at）。
pub(crate) fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

impl Storage {
    /// 打开（或创建）库文件并迁移到最新版本（幂等）；打开即启用外键完整性保护
    /// （外键保留仅作完整性检查，无物理删除路径，ADR-009）。
    pub fn open(db_path: &Path) -> Result<Self, StorageError> {
        let conn = Connection::open(db_path)?;
        conn.pragma_update(None, "foreign_keys", true)?;
        migrations::run(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock_conn(&self) -> Result<MutexGuard<'_, Connection>, StorageError> {
        self.conn
            .lock()
            .map_err(|_| StorageError::Backend("数据库连接锁中毒".into()))
    }

    fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, StorageError>,
    ) -> Result<T, StorageError> {
        f(&*self.lock_conn()?)
    }
}

/// rusqlite 错误 → 领域错误：约束冲突语义化，其余归后端故障（CMP-003：弹错即可，无补偿事务）。
impl From<rusqlite::Error> for StorageError {
    fn from(err: rusqlite::Error) -> Self {
        match &err {
            rusqlite::Error::SqliteFailure(ffi, Some(msg))
                if ffi.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                StorageError::Conflict(msg.clone())
            }
            _ => StorageError::Backend(err.to_string()),
        }
    }
}

// 端口实现同上：消费方在 TASK-005 接线后出现。
#[allow(dead_code)]
impl StoragePort for Storage {
    // ---- characters ----
    fn create_character(&self, new: &NewCharacter) -> Result<Character, StorageError> {
        self.with_conn(|conn| characters::insert(conn, new))
    }

    fn list_characters(&self) -> Result<Vec<Character>, StorageError> {
        self.with_conn(characters::list)
    }

    fn get_character(&self, id: i64) -> Result<Character, StorageError> {
        self.with_conn(|conn| characters::get(conn, id))
    }

    fn update_character(&self, id: i64, update: &UpdateCharacter) -> Result<(), StorageError> {
        self.with_conn(|conn| characters::update(conn, id, update))
    }

    fn soft_delete_character(&self, id: i64) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            let ts = now();
            characters::soft_delete(conn, id, ts)
        })
    }

    fn restore_character(&self, id: i64) -> Result<(), StorageError> {
        self.with_conn(|conn| characters::restore(conn, id))
    }

    // ---- sessions ----
    fn create_session(&self, new: &NewSession) -> Result<Session, StorageError> {
        self.with_conn(|conn| sessions::insert(conn, new))
    }

    fn list_sessions(&self) -> Result<Vec<Session>, StorageError> {
        self.with_conn(sessions::list_by_updated_desc)
    }

    fn get_session(&self, id: i64) -> Result<Session, StorageError> {
        self.with_conn(|conn| sessions::get(conn, id))
    }

    fn touch_session(&self, id: i64) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            let ts = now();
            sessions::touch_at(conn, id, ts)
        })
    }

    fn update_session_title(&self, id: i64, title: &str) -> Result<(), StorageError> {
        self.with_conn(|conn| sessions::update_title(conn, id, title))
    }

    fn soft_delete_session(&self, id: i64) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            let ts = now();
            sessions::soft_delete(conn, id, ts)
        })
    }

    fn restore_session(&self, id: i64) -> Result<(), StorageError> {
        self.with_conn(|conn| sessions::restore(conn, id))
    }

    // ---- messages ----
    fn insert_message(&self, new: &NewMessage) -> Result<Message, StorageError> {
        self.with_conn(|conn| {
            // 消息插入 + 会话 updated_at 刷新同事务（FR-007：每条新消息刷新）。
            let tx = conn.unchecked_transaction()?;
            let ts = now();
            let msg = messages::insert(&tx, new, ts)?;
            sessions::touch_at(&tx, new.session_id, ts)?;
            tx.commit()?;
            Ok(msg)
        })
    }

    fn list_messages(&self, session_id: i64) -> Result<Vec<Message>, StorageError> {
        self.with_conn(|conn| messages::list_by_session(conn, session_id))
    }

    fn latest_assistant_message(
        &self,
        session_id: i64,
    ) -> Result<Option<Message>, StorageError> {
        self.with_conn(|conn| messages::latest_assistant(conn, session_id))
    }

    fn replace_last_assistant_message(
        &self,
        new: &NewMessage,
    ) -> Result<Message, StorageError> {
        if new.role != MessageRole::Assistant {
            return Err(StorageError::Conflict(
                "replace_last_assistant_message 只接受 assistant 消息".into(),
            ));
        }
        self.with_conn(|conn| {
            // 整条替换（FR-008：重新生成 / 断流重试共用）：软删旧条 + 插入新条 + 刷新会话，单事务。
            let tx = conn.unchecked_transaction()?;
            let ts = now();
            let _replaced = messages::soft_delete_latest_assistant(&tx, new.session_id, ts)?;
            let msg = messages::insert(&tx, new, ts)?;
            sessions::touch_at(&tx, new.session_id, ts)?;
            tx.commit()?;
            Ok(msg)
        })
    }

    fn soft_delete_message(&self, id: i64) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            let ts = now();
            messages::soft_delete(conn, id, ts)
        })
    }

    fn restore_message(&self, id: i64) -> Result<(), StorageError> {
        self.with_conn(|conn| messages::restore(conn, id))
    }

    // ---- scenes（FR-011 数据地基）----
    fn insert_scene(&self, new: &NewScene) -> Result<Scene, StorageError> {
        self.with_conn(|conn| scenes::insert(conn, new))
    }

    fn list_scenes(&self, session_id: i64) -> Result<Vec<Scene>, StorageError> {
        self.with_conn(|conn| scenes::list_by_session(conn, session_id))
    }

    fn latest_scene(&self, session_id: i64) -> Result<Option<Scene>, StorageError> {
        self.with_conn(|conn| scenes::latest(conn, session_id))
    }

    // ---- character_state（FR-012）----
    fn upsert_character_state(
        &self,
        new: &NewCharacterState,
    ) -> Result<CharacterState, StorageError> {
        self.with_conn(|conn| character_states::upsert(conn, new))
    }

    fn list_character_states(&self, session_id: i64) -> Result<Vec<CharacterState>, StorageError> {
        self.with_conn(|conn| character_states::list_by_session(conn, session_id))
    }

    fn soft_delete_character_state(&self, id: i64) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            let ts = now();
            character_states::soft_delete(conn, id, ts)
        })
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::Storage;

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// 每个测试独享的临时目录 + 库文件；根路径注入，绝不写真实 home（ADR-012）。
    pub(crate) fn temp_storage(tag: &str) -> (Storage, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "chronoveil_test_{}_{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed),
            tag
        ));
        cleanup(&dir); // 清理可能的残留
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        (Storage::open(&path).unwrap(), dir)
    }

    pub(crate) fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{cleanup, temp_storage};
    use super::*;
    use crate::domain::models::{NewCharacter, NewSession};
    use rusqlite::Connection;
    use std::path::PathBuf;

    /// 迁移幂等（验收 3）：同一库文件重复打开，版本记录不重复、建表语句不报错。
    #[test]
    fn reopen_same_db_is_idempotent() {
        let dir = std::env::temp_dir().join(format!(
            "chronoveil_test_{}_reopen",
            std::process::id()
        ));
        cleanup(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("test.db");

        drop(Storage::open(&db_path).unwrap());
        drop(Storage::open(&db_path).unwrap());
        drop(Storage::open(&db_path).unwrap());

        let conn = Connection::open(&db_path).unwrap();
        let versions: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT version FROM schema_version ORDER BY version")
                .unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(versions, vec![1, 2, 3, 4, 5, 6], "schema_version 各版本只记录一次");

        let tables: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN \
                     ('characters', 'sessions', 'messages', 'scenes', 'character_state') \
                     ORDER BY name",
                )
                .unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(
            tables,
            vec!["character_state", "characters", "messages", "scenes", "sessions"],
            "v1 三表 + 5b 两新表（迁移 0002）"
        );
        drop(conn);
        cleanup(&dir);
    }

    /// 验收 3：avatar 列、三表 deleted_at、两个索引都在迁移产物中。
    #[test]
    fn schema_has_avatar_deleted_at_and_indexes() {
        let (storage, dir): (_, PathBuf) = temp_storage("schema");
        let db_path = dir.join("test.db");
        drop(storage);

        let conn = Connection::open(&db_path).unwrap();
        let column_names = |table: &str| -> Vec<String> {
            let mut stmt = conn
                .prepare(&format!("PRAGMA table_info({table})"))
                .unwrap();
            let rows = stmt.query_map([], |r| r.get::<_, String>(1)).unwrap();
            rows.map(|r| r.unwrap()).collect()
        };

        let char_cols = column_names("characters");
        assert!(
            char_cols.iter().any(|c| c == "avatar"),
            "characters.avatar 缺失（data_model rev 6）"
        );
        for table in ["characters", "sessions", "messages"] {
            assert!(
                column_names(table).iter().any(|c| c == "deleted_at"),
                "{table}.deleted_at 缺失（ADR-009 全库软删除）"
            );
        }

        let indexes: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'index' \
                     AND name IN ('idx_sessions_updated', 'idx_messages_session') ORDER BY name",
                )
                .unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        assert_eq!(
            indexes,
            vec!["idx_messages_session", "idx_sessions_updated"],
            "验收 3 要求的两个索引必须存在"
        );
        drop(conn);
        cleanup(&dir);
    }

    /// 外键完整性保护：character_id 指向不存在的角色 → Conflict（打开即 PRAGMA foreign_keys=ON）。
    #[test]
    fn foreign_keys_enforced() {
        let (storage, dir) = temp_storage("fk");
        let err = storage
            .create_session(&NewSession {
                character_id: 999_999,
                title: String::new(),
            })
            .unwrap_err();
        assert!(matches!(err, StorageError::Conflict(_)), "实际：{err:?}");
        drop(storage);
        cleanup(&dir);
    }

    /// Storage 必须实现存储端口（DIP：上层只依赖 domain::ports）。
    #[test]
    fn storage_impls_storage_port() {
        fn assert_impl<T: StoragePort>(_: &T) {}
        let (storage, dir) = temp_storage("port");
        assert_impl(&storage);
        let _ = storage
            .create_character(&NewCharacter {
                name: "经端口创建".into(),
                ..Default::default()
            })
            .unwrap();
        drop(storage);
        cleanup(&dir);
    }
}
