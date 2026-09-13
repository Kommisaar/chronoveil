//! 端口定义：存储 trait（CMP-003）；infra::storage 实现之（ADR-010 依赖倒置）。
//! 上层（services / interfaces）只依赖本 trait，不接触 rusqlite。
//!
//! 软删除约定（ADR-009）：所有列表 / 查询默认过滤 `deleted_at IS NULL`，过滤封装在存储实现内，
//! 调用方不写 SQL；删除一律走 soft_delete_*（置墓碑），restore_* 清墓碑还原；
//! 全库不存在物理删除语句。写入软删行不违反任何唯一约束（主键自增不复用）。
//!
//! 时间戳统一 Unix 毫秒。

use crate::domain::error::StorageError;
use crate::domain::llm_call::{LlmCall, NewLlmCall};
use crate::domain::models::{
    Character, CharacterInstance, CharacterState, Message, NewCharacter, NewCharacterInstance,
    NewCharacterState, NewMessage, NewScene, NewSession, Scene, Session, UpdateCharacter,
};

/// 消息归属半开区间 `(after_message_id, upto_message_id]`（FR-011）：区间内的在世消息
/// `UPDATE messages SET scene_id = scene_id`。起点取上一道场景线所在消息 id（没有则 0），
/// 保证已归属的历史消息不被重挂。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachRange {
    pub scene_id: i64,
    pub after_message_id: i64,
    pub upto_message_id: i64,
}

/// 结算单事务写入包（FR-011 / INT-003「未成功的结算无副作用」）：新场景行 + 上一场景
/// summary / recap 回写 + 收束段消息归属 + 状态 upsert / 软删，由 [`StoragePort::commit_settlement`]
/// 绑成一次提交——任一支路失败整体回滚，不留半结算状态。
///
/// scenes 行语义为「边界快照」模型（§7-1 拍板）：新行 = `---` 之后新场景的 header
/// （location / fic_day / fic_part / date_label / present）；收束段的裁决文本与消息
/// 都归上一行（`latest_scene`）。
///
/// 契约（2026-09-12 裁决「边界快照只属于被收束的场景」）：`scene.summary` /
/// `scene.recap` 应恒为 None（编排层 build_write 保证）；裁决文本只经
/// close_summary / close_recap 回写上一行。
#[derive(Debug, Clone, PartialEq)]
pub struct SettlementWrite {
    /// 新场景行（边界快照；idx 由存储层按会话单调自增分配）。
    pub scene: NewScene,
    /// 收束段归属的场景行（上一行 latest_scene；开场即结算 = None）。
    pub close_scene_id: Option<i64>,
    /// 回写到 `close_scene_id` 行的 summary：收束段的远景一句话，
    /// 使上一行与其归属消息自洽（行内即该场景的 header + 消息 + 摘要）。None = 不回写。
    pub close_summary: Option<String>,
    /// 回写到 `close_scene_id` 行的 recap（Task-03 桥场加厚）：与 close_summary 同路径，
    /// 两三句加厚回顾。None = 不回写该字段（summary 分支不受影响）。
    pub close_recap: Option<String>,
    /// 收束段消息归属范围；开场即结算（无上一行）= None，消息留待后续结算自愈（§7-2）。
    pub attach: Option<AttachRange>,
    pub state_upserts: Vec<NewCharacterState>,
    /// 待软删的 character_state 行 id（clear 语义，ADR-009 软删可还原）。
    pub state_clears: Vec<i64>,
}

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
    /// 建会话（多角色阵容形态）：`new.roster` 逐卡实例化为会话角色实例（D1 快照），
    /// 与会话行、开场锚行（present = 全部实例 id）同一事务落库；校验「恰一用户位 +
    /// ≥1 LLM 位」（D2/D3），任一卡不存在整体回滚。
    fn create_session(&self, new: &NewSession) -> Result<Session, StorageError>;
    /// 会话列表，按 updated_at 倒序（每条新消息自动刷新 updated_at）。
    fn list_sessions(&self) -> Result<Vec<Session>, StorageError>;
    fn get_session(&self, id: i64) -> Result<Session, StorageError>;
    /// 刷新会话 updated_at（排序用）。
    fn touch_session(&self, id: i64) -> Result<(), StorageError>;
    fn update_session_title(&self, id: i64, title: &str) -> Result<(), StorageError>;
    fn soft_delete_session(&self, id: i64) -> Result<(), StorageError>;
    fn restore_session(&self, id: i64) -> Result<(), StorageError>;
    /// 时间线分叉（方案 §2 第 3 步）：在源会话的锚点场景上「从此分叉」，生成新会话
    /// 并从锚点重走自己的时间线，返回新会话行。单事务完成，任一步失败整体回滚。
    ///
    /// 契约（实现见 infra/storage/session_fork.rs，拷贝口径的详细取舍在其模块注释）：
    /// - 拷贝范围 = 源会话锚点前（**含锚点场**）全部在世行，session_id 整体改写、
    ///   逐字段值拷贝（禁止引用式偷懒）；场景**保留原 idx**（各线独立计数，号在
    ///   会话内唯一），新线自有场次从锚点下一号长起。
    /// - 消息按结算归属判定：归属场 ≤ 锚点的在世消息随线；`scene_id IS NULL` 的
    ///   未归属消息仅当锚点 = 最新在世场时随线（属于进行中的锚场）；墓碑消息不拷。
    /// - 状态取「含锚点场收束成果」口径 `as_of(锚点 idx + 1)`，每（实例, key）落
    ///   一条当前生效行，instance_id / source_scene 全部落到新线 id。
    /// - **llm_calls 不拷贝**：轨迹属原线，新线从零开始（两线轨迹各自独立）。
    /// - 新会话：标题 = `new_title` 原样（文案由调用方定）、日历 = 源会话快照值拷贝、
    ///   `forked_from_session_id` / `fork_anchor_scene_idx` 记分叉锚（迁移 0011）。
    /// - 错误：源会话不存在 / 已软删 → NotFound；锚点号无对应在世场景 → NotFound。
    ///   原线零影响（只读，不改任何行）。
    fn fork_session(
        &self,
        source_session_id: i64,
        anchor_scene_idx: i64,
        new_title: &str,
    ) -> Result<Session, StorageError>;

    // ---- messages（ADR-001：终态落库原语） ----
    /// 插入消息；同一事务内刷新所属会话 updated_at（FR-007：每条新消息刷新）。
    /// `new.instance_id` 为说话人实例归属（user = 用户位，assistant = 生成位）。
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

    // ---- scenes（FR-011 数据地基：场景结算落库在后续任务接线） ----
    /// 插入场景；`idx` 同会话单调自增（墓碑行一并计序），调用方不指定。
    fn insert_scene(&self, new: &NewScene) -> Result<Scene, StorageError>;
    /// 会话内场景，按 `idx` 升序（叙事顺序），不含墓碑行。
    fn list_scenes(&self, session_id: i64) -> Result<Vec<Scene>, StorageError>;
    /// 最后一个在世场景；没有则 None。
    fn latest_scene(&self, session_id: i64) -> Result<Option<Scene>, StorageError>;
    /// 结算落库（FR-011 / ADR-005 / INT-003 幂等）：把 [`SettlementWrite`] 的四类写入
    /// （新场景行、上一场景 summary 回写、收束段消息归属、状态 upsert / 软删）绑成
    /// **单事务**提交——任一支路失败整体回滚，重试从头再来。
    fn commit_settlement(&self, write: &SettlementWrite) -> Result<Scene, StorageError>;

    // ---- character_state（FR-012：会话内人物状态，挂实例） ----
    /// 追加式状态变更（迁移 0010 状态历史化，方案 §2 第 2 步）：同键（instance_id, key）
    /// 存在生效行时，旧行打 superseded_at + 插入新行（单事务，append-only 历史链）；
    /// 无生效行（含墓碑 / 被取代行）则直接插入。返回新插入的生效行。
    /// 「当前生效行」判定 = deleted_at IS NULL AND superseded_at IS NULL（与迁移 0010
    /// partial unique index、infra/storage/character_states.rs 查询过滤互指）。
    fn upsert_character_state(&self, new: &NewCharacterState)
        -> Result<CharacterState, StorageError>;
    /// 会话内全部**当前生效**状态（跨实例、不分组，按 id 升序）；历史链行 / 墓碑行
    /// 不出现。经实例表按会话过滤（状态行本身不携带 session_id，迁移 0009 换挂）。
    fn list_character_states(&self, session_id: i64) -> Result<Vec<CharacterState>, StorageError>;
    fn soft_delete_character_state(&self, id: i64) -> Result<(), StorageError>;
    /// 状态时间点还原（迁移 0010 / 方案 §2 第 2 步；第 3 步「时间线分叉」的读原语——
    /// 方案 B「LLM 重建」已否决，还原的必须是存的）：还原「锚点场景进行中时」的会话
    /// 状态全景。每（实例, key）取来源场景号**严格小于**锚点 idx 的最新行（updated_at
    /// 序，同刻按 id 序兜底稳定）。导演结算约定状态记在被收束场（source_scene）上、
    /// 自下一场起生效，故「号 < 锚点」= 当时已生效；若下游需要「含锚点场收束成果」的
    /// 口径，取 as_of(锚点 idx + 1)。source_scene 为 NULL 的行（首场结算无上一行 /
    /// 手工设置）视为自会话之始存在，任何锚点可还原。返回行可能含 superseded_at 非
    /// NULL 的历史行——该时点的最新行不等于当下的生效行，正是本查询的意义；
    /// 墓碑行一律排除；清除动作（soft_delete）本身没有场景锚，故被清除过的 key
    /// 在任何锚点都还原不出（宁可缺失、不虚构复活；第 3 步如需清除点之前的精确
    /// 还原，须先给清除动作补场景锚）。
    fn list_character_states_as_of_scene(
        &self,
        session_id: i64,
        scene_idx: i64,
    ) -> Result<Vec<CharacterState>, StorageError>;

    // ---- character_instances（多角色群像地基：会话内运行时角色身份，方案 §2 第 1 步） ----
    /// 插入实例（建会话阵容实例化走 [`StoragePort::create_session`] 内部路径；本方法
    /// 供动态造人〔第 3 步后〕与测试直接落实例）。
    fn create_instance(&self, new: &NewCharacterInstance) -> Result<CharacterInstance, StorageError>;
    /// 会话内在世实例，用户扮演位在前（is_user DESC），其余按创建序（id ASC）。
    fn list_instances(&self, session_id: i64) -> Result<Vec<CharacterInstance>, StorageError>;
    /// 取单个在世实例；不存在或已软删报 NotFound。
    fn get_instance(&self, id: i64) -> Result<CharacterInstance, StorageError>;
    /// 软删实例（置墓碑）；在世状态行 / 消息归属保留（D4 离场清算：遗忘 = 不再注入）。
    fn soft_delete_instance(&self, id: i64) -> Result<(), StorageError>;

    // ---- llm_calls（透明化功能：LLM 调用轨迹，日志性质旁路数据）----
    /// 插入一条调用轨迹（一次 HTTP 请求一条）。本表**不做软删除**（无墓碑列）：
    /// 轨迹是日志性质数据，只插不改不删，ADR-009 在此不适用。
    fn insert_llm_call(&self, new: &NewLlmCall) -> Result<LlmCall, StorageError>;
    /// 会话内轨迹，按 id 倒序（最新在前），`limit` 截断。无会话轨迹（session_id
    /// = NULL，历史起草调用遗留形态）不进任何会话查询。
    fn list_llm_calls(&self, session_id: i64, limit: u32) -> Result<Vec<LlmCall>, StorageError>;
}
