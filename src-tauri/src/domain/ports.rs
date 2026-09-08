//! 端口定义：存储 trait（CMP-003）；infra::storage 实现之（ADR-010 依赖倒置）。
//! 上层（services / interfaces）只依赖本 trait，不接触 rusqlite。
//!
//! 软删除约定（ADR-009）：所有列表 / 查询默认过滤 `deleted_at IS NULL`，过滤封装在存储实现内，
//! 调用方不写 SQL；删除一律走 soft_delete_*（置墓碑），restore_* 清墓碑还原；
//! 全库不存在物理删除语句。写入软删行不违反任何唯一约束（主键自增不复用）。
//!
//! 时间戳统一 Unix 毫秒。

use crate::domain::error::StorageError;
use crate::domain::models::{
    Character, Message, NewCharacter, NewMessage, NewSession, Session, UpdateCharacter,
};

/// SQLite 持久化端口（CMP-003）。实现必须线程安全（&self 即可调用）；
/// `Send + Sync` 上界供生成编排（TASK-006）把 `Arc<dyn StoragePort>` 带入后台任务。
pub trait StoragePort: Send + Sync {
    // ---- characters（FR-006：人设卡 CRUD） ----
    fn create_character(&self, new: &NewCharacter) -> Result<Character, StorageError>;
    /// 在世角色卡列表（不含墓碑行），按创建顺序。
    fn list_characters(&self) -> Result<Vec<Character>, StorageError>;
    fn get_character(&self, id: i64) -> Result<Character, StorageError>;
    /// 整卡覆盖更新（编辑表单全量提交）；目标不存在或已软删时报 NotFound。
    fn update_character(&self, id: i64, update: &UpdateCharacter) -> Result<(), StorageError>;
    fn soft_delete_character(&self, id: i64) -> Result<(), StorageError>;
    fn restore_character(&self, id: i64) -> Result<(), StorageError>;

    // ---- sessions（FR-007：多会话管理） ----
    fn create_session(&self, new: &NewSession) -> Result<Session, StorageError>;
    /// 会话列表，按 updated_at 倒序（每条新消息自动刷新 updated_at）。
    fn list_sessions(&self) -> Result<Vec<Session>, StorageError>;
    fn get_session(&self, id: i64) -> Result<Session, StorageError>;
    /// 刷新会话 updated_at（排序用）。
    fn touch_session(&self, id: i64) -> Result<(), StorageError>;
    fn update_session_title(&self, id: i64, title: &str) -> Result<(), StorageError>;
    fn soft_delete_session(&self, id: i64) -> Result<(), StorageError>;
    fn restore_session(&self, id: i64) -> Result<(), StorageError>;

    // ---- messages（ADR-001：终态落库原语） ----
    /// 插入消息；同一事务内刷新所属会话 updated_at（FR-007：每条新消息刷新）。
    fn insert_message(&self, new: &NewMessage) -> Result<Message, StorageError>;
    /// 会话内消息，按 id 升序（对话顺序），不含墓碑行。
    fn list_messages(&self, session_id: i64) -> Result<Vec<Message>, StorageError>;
    /// 最后一条在世 assistant 消息；没有则 None。
    fn latest_assistant_message(&self, session_id: i64)
        -> Result<Option<Message>, StorageError>;
    /// 整条替换最后一条 assistant 消息（FR-008：重新生成与断流重试共用）——
    /// 软删旧条（置墓碑）+ 插入新条 + 刷新会话 updated_at，单事务完成。
    fn replace_last_assistant_message(&self, new: &NewMessage)
        -> Result<Message, StorageError>;
    fn soft_delete_message(&self, id: i64) -> Result<(), StorageError>;
    fn restore_message(&self, id: i64) -> Result<(), StorageError>;
}
