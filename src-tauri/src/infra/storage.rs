//! db.rs（CMP-003）：rusqlite 连接持有 + 手写顺序迁移 + 软删除统一过滤（ADR-009）。
//! 库文件：`~/.chronoveil/chronoveil.db`（ADR-012）。
//!
//! 分层约定（ADR-010）：本模块实现 `domain::ports::StoragePort`；调用方不写 SQL，
//! 「`deleted_at IS NULL` 过滤」「软删 = 置墓碑」「替换 = 软删旧条 + 插新条」全部封装在此。
//! 库内不存在任何 `DELETE FROM` 物理删除语句（ADR-009）。

mod character_states;
mod characters;
mod instances;
mod llm_calls;
mod messages;
mod migrations;
mod scenes;
mod session_fork;
mod sessions;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use crate::domain::error::StorageError;
use crate::domain::models::{
    Character, CharacterInstance, CharacterState, LlmCall, Message, MessageRole, NewCharacter,
    NewCharacterInstance, NewCharacterState, NewLlmCall, NewMessage, NewScene, NewSession, Scene,
    Session, UpdateCharacter,
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

    // 时间线分叉（方案 §2 第 3 步）：拷贝编排单事务见 session_fork 模块；
    // 生产调用方 = 「从此分叉」IPC 命令（ipc/fork.rs，Task-45 接线）。
    fn fork_session(
        &self,
        source_session_id: i64,
        anchor_scene_idx: i64,
        new_title: &str,
    ) -> Result<Session, StorageError> {
        self.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let session = session_fork::fork(&tx, source_session_id, anchor_scene_idx, new_title)?;
            tx.commit()?;
            Ok(session)
        })
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
            // 4) 状态清算：追加式状态变更（迁移 0010：旧行打 superseded_at + 追加新行，
            //    历史链保留）/ 软删清除（ADR-009 可还原）。本层外层事务保证取代 +
            //    插入 + 清除同生共死（INT-003）。
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

    // ---- character_state（FR-012，挂实例；迁移 0010 状态历史化）----
    // FR-012：生产状态写入走 commit_settlement 清算支路（内部直调 character_states::upsert，
    // 复用其外层事务），直连端口（状态手动编辑类 UI）接线前无生产调用方（仅测试消费）。
    #[allow(dead_code)]
    fn upsert_character_state(
        &self,
        new: &NewCharacterState,
    ) -> Result<CharacterState, StorageError> {
        self.with_conn(|conn| {
            // 历史化后「一次变更」= 旧行打 superseded_at + 追加新行两步——半写会留下
            // 「旧行已让位、新行缺失」的断链，端口直连路径在此绑成单事务（结算路径
            // 复用 commit_settlement 的外层事务）。
            let tx = conn.unchecked_transaction()?;
            let state = character_states::upsert(&tx, new)?;
            tx.commit()?;
            Ok(state)
        })
    }

    fn list_character_states(&self, session_id: i64) -> Result<Vec<CharacterState>, StorageError> {
        self.with_conn(|conn| character_states::list_by_session(conn, session_id))
    }

    // 状态时间点还原（迁移 0010 / 方案 §2 第 2 步）：第 3 步「时间线分叉」的读原语，
    // 分叉落新实例前取「锚点前最后生效状态行」；该步接线前无生产调用方（仅测试消费）。
    #[allow(dead_code)]
    fn list_character_states_as_of_scene(
        &self,
        session_id: i64,
        scene_idx: i64,
    ) -> Result<Vec<CharacterState>, StorageError> {
        self.with_conn(|conn| character_states::list_as_of_scene(conn, session_id, scene_idx))
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

    // ---- character_instances（多角色群像地基：会话内运行时角色身份）----
    // 建会话阵容实例化走 create_session 内部路径（sessions::insert 单事务）；本端口
    // 供动态造人（第 3 步后）与测试直接落实例。
    fn create_instance(
        &self,
        new: &NewCharacterInstance,
    ) -> Result<CharacterInstance, StorageError> {
        self.with_conn(|conn| instances::insert(conn, new))
    }

    fn list_instances(&self, session_id: i64) -> Result<Vec<CharacterInstance>, StorageError> {
        self.with_conn(|conn| instances::list_by_session(conn, session_id))
    }

    fn get_instance(&self, id: i64) -> Result<CharacterInstance, StorageError> {
        self.with_conn(|conn| instances::get(conn, id))
    }

    // 实例软删（D4 离场清算的存储原语）：运行中加人 / 离场 UI 属第 3 步后接线，
    // 端口先行（与 ADR-009 其余墓碑原语同惯例），测试消费。
    #[allow(dead_code)]
    fn soft_delete_instance(&self, id: i64) -> Result<(), StorageError> {
        self.with_conn(|conn| {
            let ts = now();
            instances::soft_delete(conn, id, ts)
        })
    }

    // ---- llm_calls（透明化功能：LLM 调用轨迹，日志性质旁路数据）----
    // 本表不做软删除（无墓碑列，ADR-009 不适用）：只插不改不删，见 infra/storage/llm_calls.rs。
    fn insert_llm_call(&self, new: &NewLlmCall) -> Result<LlmCall, StorageError> {
        self.with_conn(|conn| llm_calls::insert(conn, new))
    }

    fn list_llm_calls(&self, session_id: i64, limit: u32) -> Result<Vec<LlmCall>, StorageError> {
        self.with_conn(|conn| llm_calls::list_by_session(conn, session_id, limit))
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
mod tests;
