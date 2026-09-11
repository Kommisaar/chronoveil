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
use crate::domain::ports::{SettlementWrite, StoragePort};

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

// 端口实现的生产消费方已接线（IPC 命令层 + 生成/导演服务，TASK-005/006、FR-011）；
// 暂无生产调用方的预留方法逐方法标注 dead_code 豁免并注明预留阶段（勿再整块 allow）。
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

    // ADR-009 墓碑还原原语；回收站 / 撤销删除类 UI 接线前无生产调用方（仅测试消费）。
    #[allow(dead_code)]
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

    // 独立刷新会话 updated_at；生产路径经 insert_message 事务内刷新（FR-007），
    // 直连调用（如无消息的会话提权类操作）接线前无生产调用方（仅测试消费）。
    #[allow(dead_code)]
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

    // ADR-009 墓碑还原原语；会话回收站 UI 接线前无生产调用方（仅测试消费）。
    #[allow(dead_code)]
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

    // 消息级删除（置墓碑）；消息删除类 UI 接线前无生产调用方（仅测试消费）。
    #[allow(dead_code)]
    fn soft_delete_message(&self, id: i64) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            let ts = now();
            messages::soft_delete(conn, id, ts)
        })
    }

    // ADR-009 墓碑还原原语；消息回收站 UI 接线前无生产调用方（仅测试消费）。
    #[allow(dead_code)]
    fn restore_message(&self, id: i64) -> Result<(), StorageError> {
        self.with_conn(|conn| messages::restore(conn, id))
    }

    // ---- scenes（FR-011 数据地基）----
    // FR-011：生产落场景行走 commit_settlement 单事务（内部直调 scenes::insert），
    // 独立插场景接线前无生产调用方（仅测试消费）。
    #[allow(dead_code)]
    fn insert_scene(&self, new: &NewScene) -> Result<Scene, StorageError> {
        self.with_conn(|conn| scenes::insert(conn, new))
    }

    fn list_scenes(&self, session_id: i64) -> Result<Vec<Scene>, StorageError> {
        self.with_conn(|conn| scenes::list_by_session(conn, session_id))
    }

    fn latest_scene(&self, session_id: i64) -> Result<Option<Scene>, StorageError> {
        self.with_conn(|conn| scenes::latest(conn, session_id))
    }

    fn commit_settlement(&self, write: &SettlementWrite) -> Result<Scene, StorageError> {
        self.with_conn(|conn| {
            // 结算单事务（INT-003「未成功的结算无副作用」的字面实现）：四类写入绑成
            // 一次提交，任一支路失败整体回滚，不留半结算状态（避免 idx 空洞 / 摘要
            // 回写与消息归属脱节等不一致）。unchecked_transaction 模式同 insert_message。
            let tx = conn.unchecked_transaction()?;
            // 1) 上一场景收束回写（边界快照：上一行 = 它所辖场景的 header + 消息 +
            //    摘要；Task-03 起 recap 随 summary 同路径回写，None 字段不动既有值）。
            if let Some(scene_id) = write.close_scene_id {
                if write.close_summary.is_some() || write.close_recap.is_some() {
                    scenes::backfill_close(
                        &tx,
                        scene_id,
                        write.close_summary.as_deref(),
                        write.close_recap.as_deref(),
                    )?;
                }
            }
            // 2) 收束段消息归属（半开区间挂到上一行；无上一行则无归属，消息留待自愈）。
            if let Some(range) = &write.attach {
                messages::attach_to_scene(&tx, write.scene.session_id, range)?;
            }
            // 3) 新场景行（边界快照 header，idx 同会话单调自增）。
            let scene = scenes::insert(&tx, &write.scene)?;
            // 4) 状态清算：upsert 覆盖 / 软删清除（ADR-009 可还原）。
            for upsert in &write.state_upserts {
                character_states::upsert(&tx, upsert)?;
            }
            for id in &write.state_clears {
                character_states::soft_delete(&tx, *id, now())?;
            }
            tx.commit()?;
            Ok(scene)
        })
    }

    // ---- character_state（FR-012）----
    // FR-012：生产状态写入走 commit_settlement 清算支路（内部直调 character_states::upsert），
    // 直连端口（状态手动编辑类 UI）接线前无生产调用方（仅测试消费）。
    #[allow(dead_code)]
    fn upsert_character_state(
        &self,
        new: &NewCharacterState,
    ) -> Result<CharacterState, StorageError> {
        self.with_conn(|conn| character_states::upsert(conn, new))
    }

    fn list_character_states(&self, session_id: i64) -> Result<Vec<CharacterState>, StorageError> {
        self.with_conn(|conn| character_states::list_by_session(conn, session_id))
    }

    // FR-012 手动清除状态预留：生产清除走 commit_settlement 清算支路（内部直调
    // character_states::soft_delete），直连端口接线前无生产调用方（仅测试消费）。
    #[allow(dead_code)]
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
        assert_eq!(versions, vec![1, 2, 3, 4, 5, 6, 7], "schema_version 各版本只记录一次");

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
                opening: None,
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

    // ---- commit_settlement（FR-011：结算单事务）----

    use crate::domain::models::{CharacterStateScope, NewCharacterState};
    use crate::domain::ports::AttachRange;

    /// 在世消息的 scene_id 列快照（按 id 升序）：scene_id 已开进 Message 读路径，
    /// 直接经端口（list_messages，id ASC）读取断言，不再另开只读连接。
    fn attached_scene_ids(storage: &Storage, session_id: i64) -> Vec<Option<i64>> {
        storage
            .list_messages(session_id)
            .unwrap()
            .into_iter()
            .map(|message| message.scene_id)
            .collect()
    }

    /// 夹具：角色 + 会话 + 两条消息（user、assistant 各一），返回各 id。
    fn settlement_fixture(tag: &str) -> (Storage, PathBuf, i64, i64, i64, i64) {
        let (storage, dir) = temp_storage(tag);
        let char_id = storage
            .create_character(&NewCharacter { name: "苏鸢".into(), ..Default::default() })
            .unwrap()
            .id;
        let session_id = storage
            .create_session(&NewSession { character_id: char_id, title: String::new(), opening: None })
            .unwrap()
            .id;
        let user_id = storage
            .insert_message(&NewMessage::new(session_id, MessageRole::User, "推门进去。"))
            .unwrap()
            .id;
        let assistant_id = storage
            .insert_message(&NewMessage::new(
                session_id,
                MessageRole::Assistant,
                "她抬头。\n\n---\n\n新的开始。",
            ))
            .unwrap()
            .id;
        (storage, dir, char_id, session_id, user_id, assistant_id)
    }

    fn new_scene(session_id: i64) -> NewScene {
        NewScene {
            session_id,
            location: Some("旧书店 · 打烊后".into()),
            time_note: Some("次日清晨".into()),
            fic_day: Some(2),
            fic_part: Some("清晨".into()),
            date_label: Some("第2日·清晨".into()),
            summary: Some("昨夜争执后两人无言告别".into()),
            recap: None,
            present: vec![1],
        }
    }

    /// 结算成功路径：上一行 summary 回写、收束段消息归属、新行 idx 自增、
    /// 状态 upsert 与软删清除一次落库（FR-011 / INT-003）。
    #[test]
    fn commit_settlement_lands_all_branches_in_one_transaction() {
        let (storage, dir, char_id, session_id, _user_id, assistant_id) =
            settlement_fixture("settle_ok");
        // 上一结算的边界快照行（开场段）+ 一条待清除状态。
        let previous = storage.insert_scene(&new_scene(session_id)).unwrap();
        let stale = storage
            .upsert_character_state(&NewCharacterState {
                character_id: char_id,
                session_id,
                scope: CharacterStateScope::State,
                key: "别扭".into(),
                value: "欲言又止".into(),
                expiry: Some("scene_end".into()),
                source_scene: Some(previous.id),
            })
            .unwrap();

        let write = SettlementWrite {
            scene: NewScene {
                summary: Some("钟楼下的对峙无果而终".into()),
                ..new_scene(session_id)
            },
            close_scene_id: Some(previous.id),
            close_summary: Some("昨夜争执后两人无言告别".into()),
            close_recap: Some("争执从一句误口信开始。两人隔着柜台沉默了很久。最后她把伞留下，独自走进雨夜。".into()),
            attach: Some(AttachRange {
                scene_id: previous.id,
                after_message_id: 0,
                upto_message_id: assistant_id,
            }),
            state_upserts: vec![NewCharacterState {
                character_id: char_id,
                session_id,
                scope: CharacterStateScope::State,
                key: "情绪".into(),
                value: "释然".into(),
                expiry: Some("event:亮灯".into()),
                source_scene: Some(previous.id),
            }],
            state_clears: vec![stale.id],
        };
        let scene = storage.commit_settlement(&write).unwrap();

        // 新行：idx 沿上一行单调自增，边界快照字段原样落库。
        assert_eq!(scene.idx, previous.idx + 1);
        assert_eq!(scene.location.as_deref(), Some("旧书店 · 打烊后"));
        assert_eq!(scene.summary.as_deref(), Some("钟楼下的对峙无果而终"));
        assert_eq!(scene.present, vec![1]);
        // 上一行 summary / recap 回写（Task-03 同路径）+ 收束段两条消息归属到上一行
        // （边界快照语义）。
        let reloaded = storage.list_scenes(session_id).unwrap();
        assert_eq!(reloaded.len(), 3, "开场锚行（FR-014 seed）+ 上一行 + 新行");
        let previous_row = reloaded.iter().find(|s| s.id == previous.id).unwrap();
        assert_eq!(previous_row.summary.as_deref(), Some("昨夜争执后两人无言告别"));
        assert_eq!(
            previous_row.recap.as_deref(),
            Some("争执从一句误口信开始。两人隔着柜台沉默了很久。最后她把伞留下，独自走进雨夜。"),
            "recap 随 summary 同路径回写上一行"
        );
        assert_eq!(
            reloaded.last().unwrap().recap, None,
            "新行只预填 verdict 给出的 recap（本例 None），list_scenes 往返读出"
        );
        assert_eq!(
            attached_scene_ids(&storage, session_id),
            vec![Some(previous.id), Some(previous.id)],
            "收束段消息挂到上一行"
        );
        // 状态清算：新键 upsert、旧键软删（墓碑可还原，ADR-009）。
        let states = storage.list_character_states(session_id).unwrap();
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].key, "情绪");
        assert_eq!(states[0].value, "释然");
        assert_eq!(states[0].source_scene, Some(previous.id));
        assert_eq!(states[0].deleted_at, None);
        assert!(storage.soft_delete_character_state(stale.id).is_err(), "清除支路已置墓碑：再删报 NotFound");
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 「无上一行」支路（close / attach / 回写全部缺席）：仅落新场景行。
    /// FR-014 起建会话必 seed 开场锚行，本用例在锚行之上验证 None 支路不失败。
    #[test]
    fn commit_settlement_first_boundary_only_inserts_scene() {
        let (storage, dir, _char_id, session_id, _user_id, _assistant_id) =
            settlement_fixture("settle_first");
        let scene = storage
            .commit_settlement(&SettlementWrite {
                scene: new_scene(session_id),
                close_scene_id: None,
                close_summary: None,
                close_recap: None,
                attach: None,
                state_upserts: Vec::new(),
                state_clears: Vec::new(),
            })
            .unwrap();
        assert_eq!(scene.idx, 1, "开场锚行（idx 0）之上自增");
        assert_eq!(storage.list_scenes(session_id).unwrap().len(), 2);
        assert!(
            attached_scene_ids(&storage, session_id).iter().all(|id| id.is_none()),
            "无上一行不产生消息归属（留待后续结算自愈，§7-2）"
        );
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 回滚测试（INT-003 未成功的结算无副作用）：清除支路指向不存在行 → 整体失败，
    /// 新场景行 / summary 回写 / 消息归属 / upsert 一律不留痕迹。
    #[test]
    fn commit_settlement_rolls_back_on_any_branch_failure() {
        let (storage, dir, char_id, session_id, _user_id, assistant_id) =
            settlement_fixture("settle_rollback");
        let previous = storage.insert_scene(&new_scene(session_id)).unwrap();
        let before_summary = previous.summary.clone();
        let before_scenes = storage.list_scenes(session_id).unwrap().len();

        let err = storage
            .commit_settlement(&SettlementWrite {
                scene: new_scene(session_id),
                close_scene_id: Some(previous.id),
                close_summary: Some("不该被写进去的摘要".into()),
                close_recap: Some("不该被写进去的回顾".into()),
                attach: Some(AttachRange {
                    scene_id: previous.id,
                    after_message_id: 0,
                    upto_message_id: assistant_id,
                }),
                state_upserts: vec![NewCharacterState {
                    character_id: char_id,
                    session_id,
                    scope: CharacterStateScope::State,
                    key: "情绪".into(),
                    value: "释然".into(),
                    expiry: None,
                    source_scene: None,
                }],
                state_clears: vec![999_999], // 不存在的状态行 → NotFound → 整体回滚
            })
            .unwrap_err();
        assert!(matches!(err, StorageError::NotFound { .. }), "实际：{err:?}");

        assert_eq!(storage.list_scenes(session_id).unwrap().len(), before_scenes, "无新场景行");
        assert_eq!(
            storage.latest_scene(session_id).unwrap().unwrap().summary,
            before_summary,
            "summary 回写未发生"
        );
        assert_eq!(
            storage.latest_scene(session_id).unwrap().unwrap().recap,
            None,
            "recap 回写未发生（回滚覆盖 Task-03 同路径支路）"
        );
        assert!(
            attached_scene_ids(&storage, session_id).iter().all(|id| id.is_none()),
            "消息归属未发生"
        );
        assert!(storage.list_character_states(session_id).unwrap().is_empty(), "upsert 未发生");
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
