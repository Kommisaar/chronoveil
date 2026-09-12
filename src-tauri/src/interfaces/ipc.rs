//! Tauri 命令层（ADR-010 interfaces 层；TASK-005）。
//!
//! 命令面（验收 4）：会话列表/创建/软删、消息列表、发送消息、取消生成、重新生成最后一条、
//! 场景 / 人物状态列表（叙事账本读路径）、
//! 角色 CRUD（含 avatar）、角色卡单卡导出/导入（Task-04，原生文件对话框）、config.json 读取/保存。
//!
//! wire 契约（类型同源，ADR-010）：
//! - DTO 统一 `#[serde(rename_all = "camelCase")]`，与 `src/api/types.ts` 一一对应；
//!   TS 侧类型经 tauri-specta 同源生成于 `src/api/generated/bindings.ts`（`builder()` +
//!   `export_ts_bindings` 测试负责再生成，勿手改）；
//! - 错误统一 [`IpcError`]：`Serialize` + `std::error::Error`，前端拿到可判别的结构化错误；
//! - 新增命令必须同步登记 `config/ipc-command-whitelist.json`（ADR-010 守卫）。
//!
//! 生成编排边界（TASK-006 已接线）：`send_message` / `regenerate_last` 校验入参、落库用户条
//! （重新生成为软删旧条 + 新条从零演出，FR-008）、装配生成任务交异步运行时 spawn；
//! 生成闭环本体（prompt 装配 → LLM 流式 → 终态落库）在 services/generation。
//! 事件经 `AppState::sink`（setup 注入的 `TauriEventSink`）广播；`cancel_generation`
//! 经生成注册表取消，无活跃生成时为幂等 no-op（返回 false）。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::domain::fiction_time;
use crate::domain::models;
use crate::domain::ports::StoragePort;
use crate::infra::config::Config as FileConfig;
use crate::infra::config::ProviderConfig as FileProvider;
use crate::infra::llm::{cancel_channel, CancelHandle, EventSink, LlmClient};
use crate::services::{
    calendar_draft,
    character_io,
    director,
    generation::{self, GenerationDeps, PendingGeneration},
};
use crate::state::AppState;

/// 生成任务驱动器：命令层传 `tauri::async_runtime::spawn`，测试传 no-op（不经运行时）。
pub(crate) type GenerationSpawner = Arc<dyn Fn(PendingGeneration) + Send + Sync>;

// ---------------------------------------------------------------------------
// 错误（验收 4：命令错误可序列化）
// ---------------------------------------------------------------------------

/// 命令错误的统一 wire 形态。`kind` 是判别字段（camelCase），前端可 switch 分型。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum IpcError {
    /// 目标不存在或已软删除（ADR-009：对调用方等价）。
    NotFound { entity: String, id: i64 },
    /// 约束冲突 / 非法入参。
    Conflict { message: String },
    /// 存储后端故障。
    Storage { message: String },
    /// 配置装载 / 校验 / 保存失败（ADR-012：坏文件快速失败，不静默重置）。
    Config { message: String },
    /// 能力尚未接线（生成闭环由 TASK-006 接入）。
    Unavailable { message: String },
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IpcError::NotFound { entity, id } => write!(f, "{entity} #{id} 不存在（或已软删除）"),
            IpcError::Conflict { message } => write!(f, "{message}"),
            IpcError::Storage { message } => write!(f, "存储错误：{message}"),
            IpcError::Config { message } => write!(f, "配置错误：{message}"),
            IpcError::Unavailable { message } => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for IpcError {}

impl From<crate::domain::error::StorageError> for IpcError {
    fn from(e: crate::domain::error::StorageError) -> Self {
        use crate::domain::error::StorageError;
        match e {
            StorageError::NotFound { entity, id } => {
                IpcError::NotFound { entity: entity.to_string(), id }
            }
            StorageError::Conflict(message) => IpcError::Conflict { message },
            StorageError::Backend(message) => IpcError::Storage { message },
        }
    }
}

impl From<crate::infra::config::ConfigError> for IpcError {
    fn from(e: crate::infra::config::ConfigError) -> Self {
        IpcError::Config { message: e.to_string() }
    }
}

// ---------------------------------------------------------------------------
// DTO：camelCase wire 形态（与 src/api/types.ts 逐一对应，specta 同源生成）
// ---------------------------------------------------------------------------

/// 消息角色（data_model：role CHECK IN ('user', 'assistant')）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Assistant,
}

impl From<models::MessageRole> for MessageRole {
    fn from(role: models::MessageRole) -> Self {
        match role {
            models::MessageRole::User => MessageRole::User,
            models::MessageRole::Assistant => MessageRole::Assistant,
        }
    }
}

/// 会话角色实例回显行（多角色阵容制 wire，Task-31）：`SessionSummary.instances`
/// 逐行——建会话时逐卡实例化的运行时身份快照（D1），非模板卡。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionInstanceDto {
    pub id: i64,
    /// 设定快照名（建会话时值拷贝自卡，改卡不回写，D1）。
    pub name: String,
    /// 扮演位标记（D2）：全会话恰好 1；侧栏标题 / 统计读它。
    pub is_user: bool,
    /// 模板溯源（D1）：选卡实例化记卡 id；None = 动态造人（D6，本切片不产生）。
    pub character_id: Option<i64>,
    /// 出场动画风格快照（D1）——回显快照值而非模板卡现值，改卡不影响既有会话；
    /// 消费方（聊天渲染参数）读这里，不再回查模板卡。
    pub render_style: String,
}

impl From<models::CharacterInstance> for SessionInstanceDto {
    fn from(i: models::CharacterInstance) -> Self {
        Self {
            id: i.id,
            name: i.name,
            is_user: i.is_user,
            character_id: i.character_id,
            render_style: i.render_style,
        }
    }
}

/// 会话摘要（FR-007：列表按 updated_at 倒序）。
/// 多角色阵容制（wire 重设计，Task-31）：sessions.character_id 已随迁移 0009
/// 移除，阵容 / 扮演位信息改经 `instances` 回显（建会话快照，D1/D2）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: i64,
    pub title: String,
    pub updated_at: i64,
    /// 建成后的阵容回显（在世实例，创建序 = 用户位在前）；本切片无实例增删，
    /// 空数组仅出现在异常数据（正常建会话至少一个用户位）。
    pub instances: Vec<SessionInstanceDto>,
}

/// 角色卡摘要（角色页卡片；session_count 为关系侧汇总）。
///
/// TASK-008 起 `persona` / `model_config` 随列表返回：编辑表单点选即载入全量
/// 字段（UI-002），避免为预填再发一次单条查询。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSummary {
    pub id: i64,
    pub name: String,
    /// 头像可空：data URL 或 `~/.chronoveil` 相对路径；null 时前端首字占位。
    pub avatar: Option<String>,
    /// 人设系统提示词（编辑预填）。
    pub persona: String,
    /// 性别（可选展示元数据）。
    pub gender: Option<String>,
    /// 年龄（可选展示元数据，自由文本）。
    pub age: Option<String>,
    /// 出场动画风格（18 种之一，FR-005）。
    pub render_style: String,
    /// 每角色模型覆写 JSON（camelCase 键，`resolve_effective_llm` 消费）；
    /// None = 跟随全局默认。
    pub model_config: Option<String>,
    /// 强调色 #RRGGBB，可空；None = 跟随海报派生色（前端 accentColorOf）。
    pub accent_color: Option<String>,
    /// 角色卡世界观日历 JSON（FR-013；FR-014 起随摘要透传，供开局向导
    /// 「跟随角色卡」项显示历法名）；None = 内置默认历。
    pub calendar_config: Option<String>,
    pub updated_at: i64,
    /// 该角色开启的会话数（在世会话）。
    pub session_count: i64,
}

/// 领域角色卡 → 摘要 DTO（session_count 由调用方按会话计数填充）。
fn character_summary_from(c: models::Character) -> CharacterSummary {
    CharacterSummary {
        id: c.id,
        name: c.name,
        avatar: c.avatar,
        persona: c.persona,
        gender: c.gender,
        age: c.age,
        render_style: c.render_style,
        model_config: c.model_config,
        accent_color: c.accent_color,
        calendar_config: c.calendar_config,
        updated_at: c.updated_at,
        session_count: 0,
    }
}

/// 聊天消息（前端 ChatMessage；wire 定案 Task-31）：字段名沿用 `characterId`
/// （旧 wire 相容名，避免纯改名 churn），语义已是「说话人实例 id 真值」——
/// assistant → messages.instance_id（未指认的旧行为 null），user → null（用户条
/// 调用方按 role 渲染，无需实例 id；实例身份的权威回显在 SessionSummary.instances
/// 与状态 DTO 的 instanceId，消费方勿把本字段当模板卡 id 用）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: i64,
    pub session_id: i64,
    pub character_id: Option<i64>,
    pub role: MessageRole,
    /// 原始 markdown-lite 正文，显示时才解析（BR-005）。
    pub content: String,
    /// 思考内容，与正文分离（FR-003）。
    pub reasoning: Option<String>,
    /// 思考可见时长（毫秒）。
    pub think_ms: Option<i64>,
    pub created_at: i64,
    /// 终态落库中断标记（ADR-001）。
    pub interrupted: bool,
}

/// 新建角色卡入参（FR-006）。建卡不带历法——FR-014 开局向导显式指定的历法经
/// `create_session` 回写角色卡（FR-013）；历法编辑走 [`UpdateCharacterInput`]。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CharacterInput {
    pub name: String,
    /// None = 不带头像 / 更新时清除头像。
    pub avatar: Option<String>,
    pub persona: String,
    /// 性别 / 年龄（可选展示元数据，自由文本；None = 未设置）。
    pub gender: Option<String>,
    pub age: Option<String>,
    pub render_style: String,
    pub model_config: Option<String>,
    /// 强调色 #RRGGBB，可空；None = 跟随海报派生色。
    pub accent_color: Option<String>,
    /// TTS 预留缝（CON-003），前端恒传 null。
    pub voice_config: Option<String>,
}

impl From<character_io::CharacterCardPayload> for CharacterInput {
    /// 卡文件负载（Task-04 导入）→ create 负载：同形九字段直移，不复用旧 id。
    fn from(p: character_io::CharacterCardPayload) -> Self {
        Self {
            name: p.name,
            avatar: p.avatar,
            persona: p.persona,
            gender: p.gender,
            age: p.age,
            render_style: p.render_style,
            model_config: p.model_config,
            accent_color: p.accent_color,
            voice_config: p.voice_config,
        }
    }
}

/// 更新角色卡入参（FR-006 / FR-013）：[`CharacterInput`] 全字段 + 世界观历法。
/// 编辑器整卡提交（Task-17 `buildInput` 返回 `CharacterInput & { calendarConfig }`，
/// 与本结构 wire 同形）；历法域语义：
/// - `Some(dto)`：经 [`fiction_time::validate`] 校验后序列化落库（snake_case 存储
///   JSON，与会话快照同构），编辑器保存历法即此形态；
/// - `None` / wire 缺键：**清除历法**（回退内置默认历）——整卡覆盖语义与 avatar
///   从众（既有可空字段无「不动」形态，`Option` 一层即足够，无需嵌套区分）。
#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCharacterInput {
    pub name: String,
    /// None = 更新时清除头像。
    pub avatar: Option<String>,
    pub persona: String,
    /// 性别 / 年龄（可选展示元数据，自由文本；None = 未设置）。
    pub gender: Option<String>,
    pub age: Option<String>,
    pub render_style: String,
    pub model_config: Option<String>,
    /// 强调色 #RRGGBB，可空；None = 跟随海报派生色。
    pub accent_color: Option<String>,
    /// TTS 预留缝（CON-003），前端恒传 null。
    pub voice_config: Option<String>,
    /// 世界观历法（FR-013）；None = 清除。
    pub calendar_config: Option<CalendarConfigDto>,
}

/// 单套 LLM Provider（FR-009；OpenAI 兼容）。双层级（2026-09-09）：一个服务
/// 提供多个模型（`models`，模型名字符串即身份）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDto {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    /// 该服务可用的模型名列表；至少一个才能用于生成。
    pub models: Vec<String>,
}

/// 应用配置（FR-009 / ADR-012；wire 形态 camelCase，落盘文件仍为 infra 的 snake_case 键）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDto {
    pub providers: Vec<ProviderDto>,
    /// 全局默认模型指向的 provider id；null = 未选择。
    pub active_provider_id: Option<String>,
    /// 全局默认模型名（双层级 2026-09-09）：active_provider_id 的 models 之一；
    /// null = 未显式选择（解析回落该服务第一个模型）。
    pub active_model: Option<String>,
    /// 打字节奏 ms/字（10–160，FR-009）。
    pub rhythm_ms_per_char: u32,
    pub punct_pause_enabled: bool,
    /// 动效时长基准 ms。
    pub anim_duration_base: u32,
    pub ui_language: String,
    /// system / light / dark。
    pub ui_theme: String,
    /// 导演专用模型；null / 空 = 跟随主模型（INT-003）。
    pub director_model: Option<String>,
    /// 近景场景数（近景窗口可选化：最近 N 个已结算场整场进近景，1–6，默认 2）。
    pub near_scenes: u32,
}

impl From<&FileConfig> for ConfigDto {
    fn from(c: &FileConfig) -> Self {
        Self {
            providers: c
                .providers
                .iter()
                .map(|p| ProviderDto {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    base_url: p.base_url.clone(),
                    api_key: p.api_key.clone(),
                    models: p.models.clone(),
                })
                .collect(),
            active_provider_id: c.active_provider_id.clone(),
            active_model: c.active_model.clone(),
            rhythm_ms_per_char: c.rhythm_ms_per_char,
            punct_pause_enabled: c.punct_pause_enabled,
            anim_duration_base: c.anim_duration_base,
            ui_language: c.ui_language.clone(),
            ui_theme: c.ui_theme.clone(),
            director_model: c.director_model.clone(),
            near_scenes: c.near_scenes,
        }
    }
}

impl From<ConfigDto> for FileConfig {
    fn from(d: ConfigDto) -> Self {
        Self {
            providers: d
                .providers
                .into_iter()
                .map(|p| FileProvider {
                    id: p.id,
                    name: p.name,
                    base_url: p.base_url,
                    api_key: p.api_key,
                    models: p.models,
                    model: None,
                })
                .collect(),
            active_provider_id: d.active_provider_id,
            active_model: d.active_model,
            rhythm_ms_per_char: d.rhythm_ms_per_char,
            punct_pause_enabled: d.punct_pause_enabled,
            anim_duration_base: d.anim_duration_base,
            ui_language: d.ui_language,
            ui_theme: d.ui_theme,
            director_model: d.director_model,
            near_scenes: d.near_scenes,
        }
    }
}

// ---------------------------------------------------------------------------
// DTO：场景与人物状态（FR-011 / FR-012 读路径，叙事账本面板数据地基）
// ---------------------------------------------------------------------------

/// 人物状态 scope（FR-012：state = 随戏状态，relation = 缓演关系；wire 小写）。
/// 领域 `models::CharacterStateScope` 的库值同为小写字符串，wire 与存储形态一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CharacterStateScope {
    State,
    Relation,
}

impl From<models::CharacterStateScope> for CharacterStateScope {
    fn from(scope: models::CharacterStateScope) -> Self {
        match scope {
            models::CharacterStateScope::State => CharacterStateScope::State,
            models::CharacterStateScope::Relation => CharacterStateScope::Relation,
        }
    }
}

/// 场景（FR-011 边界快照行）：`list_scenes` 按 idx 升序（叙事顺序）返回。
/// 不含 `session_id`（列表已按会话过滤，调用方已知）与 `deleted_at`
/// （存储层默认滤墓碑，ADR-009）；在世行才会出现在列表里。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SceneDto {
    pub id: i64,
    /// 同会话内单调自增（含墓碑行一并计序），场景顺序即叙事顺序。
    pub idx: i64,
    /// 场景地点，可空。
    pub location: Option<String>,
    /// 叙事层时间原文（自由书写），可空。
    pub time_note: Option<String>,
    /// 记账层：第几天，可空。
    pub fic_day: Option<i64>,
    /// 记账层：时段，可空。
    pub fic_part: Option<String>,
    /// 虚拟日历命名缓存（FR-013，如「白蜡月·晨露日·夜」），可空。
    pub date_label: Option<String>,
    /// 本场一句话（远景压缩单元），可空。
    pub summary: Option<String>,
    /// 桥场加厚回顾（Task-03），可空；渲染回退单行 summary。
    pub recap: Option<String>,
    /// 在场**实例** id 数组（多角色换挂后语义翻转：迁移 0009 前为模板卡 id，写入端
    /// 现按实例记值——开场锚行 seed 与结算裁决 schema 均为实例 id；名字映射由
    /// 消费方经 SessionSummary.instances 回显派生）。
    pub present: Vec<i64>,
}

impl From<models::Scene> for SceneDto {
    fn from(s: models::Scene) -> Self {
        Self {
            id: s.id,
            idx: s.idx,
            location: s.location,
            time_note: s.time_note,
            fic_day: s.fic_day,
            fic_part: s.fic_part,
            date_label: s.date_label,
            summary: s.summary,
            recap: s.recap,
            present: s.present,
        }
    }
}

/// 人物状态（FR-012）：会话内「这个角色实例」的状态 / 关系条目，
/// `list_character_states` 按 id 升序返回全部在世行。不含 `session_id` /
/// `deleted_at`（同 [`SceneDto`]；会话隶属由实例携带，迁移 0009 换挂）。
/// 机械适配：wire 字段 characterId → instanceId（真值换挂），整体语义重设计属
/// Task-31。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CharacterStateDto {
    pub id: i64,
    /// 状态所属的角色实例（运行时身份，非模板卡）。
    pub instance_id: i64,
    pub scope: CharacterStateScope,
    /// 状态键：情绪 / 持有 / 约定 / 对某实例的态度。
    pub key: String,
    /// 叙事语言的值，非数字。
    pub value: String,
    /// 过期三义透传（BR-002：scene_end / event:xxx / manual），可空。
    pub expiry: Option<String>,
    /// 来源场景 id，可空。
    pub source_scene: Option<i64>,
    pub updated_at: i64,
}

impl From<models::CharacterState> for CharacterStateDto {
    fn from(s: models::CharacterState) -> Self {
        Self {
            id: s.id,
            instance_id: s.instance_id,
            scope: CharacterStateScope::from(s.scope),
            key: s.key,
            value: s.value,
            expiry: s.expiry,
            source_scene: s.source_scene,
            updated_at: s.updated_at,
        }
    }
}

// ---------------------------------------------------------------------------
// DTO：LLM 调用轨迹（透明化功能：llm_calls 读路径 + Trace 事件负载）
// ---------------------------------------------------------------------------

/// LLM 调用类别（wire 小写；与 llm_calls.kind 库值一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum LlmCallKindDto {
    Dialogue,
    Explorer,
    Director,
    Draft,
}

impl From<models::LlmCallKind> for LlmCallKindDto {
    fn from(kind: models::LlmCallKind) -> Self {
        match kind {
            models::LlmCallKind::Dialogue => LlmCallKindDto::Dialogue,
            models::LlmCallKind::Explorer => LlmCallKindDto::Explorer,
            models::LlmCallKind::Director => LlmCallKindDto::Director,
            models::LlmCallKind::Draft => LlmCallKindDto::Draft,
        }
    }
}

/// LLM 调用终态（wire 小写；与 llm_calls.status 库值一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum LlmCallStatusDto {
    Ok,
    Error,
}

impl From<models::LlmCallStatus> for LlmCallStatusDto {
    fn from(status: models::LlmCallStatus) -> Self {
        match status {
            models::LlmCallStatus::Ok => LlmCallStatusDto::Ok,
            models::LlmCallStatus::Error => LlmCallStatusDto::Error,
        }
    }
}

/// LLM 调用轨迹（透明化功能）：llm_calls 行投影。`promptJson` / `toolCallsJson`
/// 以 string 透传（前端 parse）——内容是网关请求 / 响应的原始 JSON，序列化形态
/// 由网关侧钉死，wire 层不再二次建模。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LlmCallDto {
    pub id: i64,
    /// 所属会话；null = 无会话调用（历法起草），不出现在会话查询里。
    pub session_id: Option<i64>,
    pub kind: LlmCallKindDto,
    pub model: String,
    /// 请求发起时刻（Unix 毫秒）。
    pub started_at: i64,
    /// 本次 HTTP 请求墙钟耗时（毫秒）。
    pub duration_ms: i64,
    /// 请求消息数组 JSON（[{role, content, …}]），string 透传。
    pub prompt_json: String,
    /// 响应正文；失败 / 取消为已收到的半条。
    pub response_text: Option<String>,
    pub reasoning_text: Option<String>,
    /// 该轮模型发起的工具调用 [{name, arguments}] JSON，string 透传。
    pub tool_calls_json: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub status: LlmCallStatusDto,
    /// status = error 时的人类可读原因。
    pub error_text: Option<String>,
}

impl From<models::LlmCall> for LlmCallDto {
    fn from(call: models::LlmCall) -> Self {
        Self {
            id: call.id,
            session_id: call.session_id,
            kind: LlmCallKindDto::from(call.kind),
            model: call.model,
            started_at: call.started_at,
            duration_ms: call.duration_ms,
            prompt_json: call.prompt_json,
            response_text: call.response_text,
            reasoning_text: call.reasoning_text,
            tool_calls_json: call.tool_calls_json,
            prompt_tokens: call.prompt_tokens,
            completion_tokens: call.completion_tokens,
            status: LlmCallStatusDto::from(call.status),
            error_text: call.error_text,
        }
    }
}

// ---------------------------------------------------------------------------
// 命令实现（薄壳：State 解包后走 *_impl，便于不起 Tauri 运行时直接测试）
// ---------------------------------------------------------------------------

/// 命令注册：collect_commands（Rust 侧）与 config/ipc-command-whitelist.json（登记表）
/// 双处登记，一致性由 scripts/check-ipc-whitelist.mjs 守卫（ADR-010）。
pub fn builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            list_sessions,
            create_session,
            delete_session,
            draft_calendar,
            list_messages,
            list_scenes,
            list_character_states,
            list_llm_calls,
            send_message,
            cancel_generation,
            regenerate_last,
            list_characters,
            create_character,
            update_character,
            delete_character,
            export_character,
            import_character,
            get_config,
            save_config,
        ])
        .events(tauri_specta::collect_events![
            crate::interfaces::events::StreamEvent,
        ])
        // Result 模式：生成的 bindings 返回 Result<T, IpcError>（结构化错误可判别），
        // 由 src/api/commands.ts 统一解包成 ApiError。
        .error_handling(tauri_specta::ErrorHandlingMode::Result)
}

// ---- 会话（FR-007）+ 开局包（FR-014）----

/// 会话日历 wire DTO（FR-014 开局向导）。**wire camelCase 只管本 DTO**——落库存储
/// JSON 由存储层序列化 domain `CalendarConfig` 得 snake_case 键，前端永不手写。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarConfigDto {
    /// 历法名；None = 无命名皮肤。
    pub name: Option<String>,
    /// 月名序列（day-1 → 月序双射换算）。
    pub months: Vec<String>,
    /// 每月天数（固定天数历）；须 > 0。
    pub days_per_month: u32,
    /// 日名序列，按 (day-1) 对序列长度取模循环。
    pub day_names: Vec<String>,
    /// 节日表：键 = 年内第几天（1 起），值 = 节日名；None = 无节日。
    pub festivals: Option<std::collections::BTreeMap<i64, String>>,
}

impl From<&CalendarConfigDto> for fiction_time::CalendarConfig {
    fn from(dto: &CalendarConfigDto) -> Self {
        fiction_time::CalendarConfig {
            name: dto.name.clone(),
            months: dto.months.clone(),
            days_per_month: dto.days_per_month,
            day_names: dto.day_names.clone(),
            festivals: dto.festivals.clone().unwrap_or_default(),
        }
    }
}

impl From<&fiction_time::CalendarConfig> for CalendarConfigDto {
    fn from(cal: &fiction_time::CalendarConfig) -> Self {
        Self {
            name: cal.name.clone(),
            months: cal.months.clone(),
            days_per_month: cal.days_per_month,
            day_names: cal.day_names.clone(),
            // 空节日表 → None（wire 规范形态：「None = 无节日」，与反向 From 对称）。
            festivals: if cal.festivals.is_empty() { None } else { Some(cal.festivals.clone()) },
        }
    }
}

/// 开局包入参（FR-014）：`create_session` 第三参；None = 降级路径——同样无条件
/// seed 默认锚开场行（day=1 / part=夜 / 日历走角色卡快照，§7-6）。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpeningInput {
    /// 显式会话日历；None = 跟随角色卡快照。
    pub calendar: Option<CalendarConfigDto>,
    /// 起始「第 N 天」；None = 1。
    pub fic_day: Option<i64>,
    /// 时段（`fiction_time::PARTS` 六值之一）；None = 「夜」。
    pub fic_part: Option<String>,
    /// 首场景地点原文，可空。
    pub location: Option<String>,
    /// 首场景时间原文，可空。
    pub time_note: Option<String>,
}

/// 开局入参 → 领域 [`models::OpeningSeed`]（FR-014）：入口校验集中在此，非法入参
/// 统一 [`IpcError::Conflict`]——时段六值、起始日 ≥ 1、显式日历需满足命名皮肤
/// 可用性（对齐 `fiction_time::validate`，与 date_label 回退同一判定）。
fn opening_seed_from(input: &SessionOpeningInput) -> Result<models::OpeningSeed, IpcError> {
    if let Some(part) = &input.fic_part {
        if !fiction_time::is_valid_part(part) {
            return Err(IpcError::Conflict {
                message: format!("开局时段「{part}」不在六值内（{:?}）", fiction_time::PARTS),
            });
        }
    }
    if let Some(day) = input.fic_day {
        if day < 1 {
            return Err(IpcError::Conflict { message: format!("开局「第 {day} 天」需 ≥ 1") });
        }
    }
    let calendar = match &input.calendar {
        Some(dto) => {
            let cal = fiction_time::CalendarConfig::from(dto);
            if !fiction_time::validate(&cal) {
                return Err(IpcError::Conflict {
                    message: "开局日历需每月天数 > 0 且月名 / 日名至少其一非空".into(),
                });
            }
            Some(cal)
        }
        None => None,
    };
    Ok(models::OpeningSeed {
        calendar,
        fic_day: input.fic_day,
        fic_part: input.fic_part.clone(),
        location: input.location.clone(),
        time_note: input.time_note.clone(),
    })
}

/// 领域会话 → 摘要 DTO：instances 回显需查实例表（会失败、带 AppState），故不用
/// `From<models::Session>`，所有 SessionSummary 产出统一走本助手（wire 回显单点）。
fn session_summary_with_roster(
    app: &AppState,
    session: models::Session,
) -> Result<SessionSummary, IpcError> {
    let instances = app
        .storage
        .list_instances(session.id)?
        .into_iter()
        .map(SessionInstanceDto::from)
        .collect();
    Ok(SessionSummary {
        id: session.id,
        title: session.title,
        updated_at: session.updated_at,
        instances,
    })
}

fn list_sessions_impl(app: &AppState) -> Result<Vec<SessionSummary>, IpcError> {
    app.storage
        .list_sessions()?
        .into_iter()
        .map(|session| session_summary_with_roster(app, session))
        .collect()
}

#[tauri::command]
#[specta::specta]
pub fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionSummary>, IpcError> {
    list_sessions_impl(&state)
}

/// 建会话阵容位 wire 形态（多角色换挂的最小透传 DTO；两步选人 UI 的语义设计属
/// Task-31）。`characterId` = 模板卡 id，`isUser` = 用户扮演位标记。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RosterPickInput {
    pub character_id: i64,
    pub is_user: bool,
}

fn create_session_impl(
    app: &AppState,
    roster: Vec<RosterPickInput>,
    title: Option<String>,
    opening: Option<&SessionOpeningInput>,
) -> Result<SessionSummary, IpcError> {
    // 阵容逐卡 NotFound 由存储层实例化路径上报（比外键冲突更精确，ADR-009 语义）。
    let opening = opening.map(opening_seed_from).transpose()?;
    let session = app.storage.create_session(&models::NewSession {
        roster: roster
            .into_iter()
            .map(|pick| models::RosterPick { character_id: pick.character_id, is_user: pick.is_user })
            .collect(),
        title: title.unwrap_or_default(),
        opening,
    })?;
    session_summary_with_roster(app, session)
}

#[tauri::command]
#[specta::specta]
pub fn create_session(
    state: State<'_, AppState>,
    roster: Vec<RosterPickInput>,
    title: Option<String>,
    opening: Option<SessionOpeningInput>,
) -> Result<SessionSummary, IpcError> {
    create_session_impl(&state, roster, title, opening.as_ref())
}

fn delete_session_impl(app: &AppState, session_id: i64) -> Result<(), IpcError> {
    // 软删（ADR-009）：置墓碑；不存在 / 已软删报 NotFound。
    app.storage.soft_delete_session(session_id)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn delete_session(state: State<'_, AppState>, session_id: i64) -> Result<(), IpcError> {
    delete_session_impl(&state, session_id)
}

// ---- AI 起草历法（FR-014 二期：单次结构化调用，结果仅供审阅，不落库）----

/// 起草错误 → IpcError 分型：入参 / 模型输出不合格 / 取消 → Conflict（用户可
/// 修正或重试的错误，文案即原因）；LLM 网关错误 → Unavailable（网络 / 401 /
/// 429 / 协议，可稍后重试或检查设置）。
fn map_draft_error(error: calendar_draft::CalendarDraftError) -> IpcError {
    use calendar_draft::CalendarDraftError as DraftError;
    match error {
        DraftError::InvalidDescription(_)
        | DraftError::InvalidOutput(_)
        | DraftError::Cancelled => IpcError::Conflict { message: error.to_string() },
        DraftError::Llm(llm_error) => IpcError::Unavailable { message: llm_error.to_string() },
    }
}

async fn draft_calendar_impl(
    app: &AppState,
    description: &str,
    cancel: &CancelHandle,
) -> Result<CalendarConfigDto, IpcError> {
    // 全局默认模型解析（起草不吃角色覆写 / 导演专用模型，见 calendar_draft）。
    let llm = with_call_trace(
        app,
        calendar_draft::resolve_draft_llm(&app.config.load()?)
            .map_err(|message| IpcError::Config { message })?,
    );
    let calendar = calendar_draft::draft_calendar(&llm, description, cancel)
        .await
        .map_err(map_draft_error)?;
    Ok(CalendarConfigDto::from(&calendar))
}

/// AI 起草历法（FR-014 二期）：按世界观描述起草自定义历法，返回给前端审阅后
/// 由用户走既有保存路径（本命令**不做持久化、不自动应用**）。单次调用、前端
/// 弹窗等待——不走生成注册表（无会话互斥语义）也不流式；cancel 通道本切片
/// 暂无触发方（UI 取消按钮属后续切片），此处预留打断缝。
#[tauri::command]
#[specta::specta]
pub async fn draft_calendar(
    state: State<'_, AppState>,
    description: String,
) -> Result<CalendarConfigDto, IpcError> {
    let (_signal, cancel) = cancel_channel();
    draft_calendar_impl(&state, &description, &cancel).await
}

// ---- 消息（ADR-001 落库原语的读路径）----

fn to_chat_message(message: models::Message, character_id: Option<i64>) -> ChatMessage {
    ChatMessage {
        id: message.id,
        session_id: message.session_id,
        character_id,
        role: MessageRole::from(message.role),
        content: message.content,
        reasoning: message.reasoning,
        think_ms: message.think_ms,
        created_at: message.created_at,
        interrupted: message.interrupt_flag.is_some(),
    }
}

fn list_messages_impl(app: &AppState, session_id: i64) -> Result<Vec<ChatMessage>, IpcError> {
    app.storage.get_session(session_id)?;
    Ok(app
        .storage
        .list_messages(session_id)?
        .into_iter()
        .map(|m| {
            // 说话人实例真值（多角色换挂）：assistant 取 messages.instance_id；
            // user 恒 null（保留旧 wire 语义）。字段名沿用 characterId、值=实例
            // 真值的 wire 定案见 ChatMessage 结构体文档注释。
            let speaker = match m.role {
                models::MessageRole::Assistant => m.instance_id,
                models::MessageRole::User => None,
            };
            to_chat_message(m, speaker)
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn list_messages(
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<Vec<ChatMessage>, IpcError> {
    list_messages_impl(&state, session_id)
}

// ---- 场景与人物状态（FR-011 / FR-012 读路径：叙事账本面板数据地基）----

fn list_scenes_impl(app: &AppState, session_id: i64) -> Result<Vec<SceneDto>, IpcError> {
    // 先校验会话在世（不存在 / 已软删报 NotFound，与 list_messages_impl 同语义），
    // 再走存储端口；列表默认滤墓碑、按 idx 升序（infra/storage/scenes.rs）。
    app.storage.get_session(session_id)?;
    Ok(app
        .storage
        .list_scenes(session_id)?
        .into_iter()
        .map(SceneDto::from)
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn list_scenes(
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<Vec<SceneDto>, IpcError> {
    list_scenes_impl(&state, session_id)
}

fn list_character_states_impl(
    app: &AppState,
    session_id: i64,
) -> Result<Vec<CharacterStateDto>, IpcError> {
    // 同上：先会话在世校验，再读端口；按 id 升序（infra/storage/character_states.rs）。
    app.storage.get_session(session_id)?;
    Ok(app
        .storage
        .list_character_states(session_id)?
        .into_iter()
        .map(CharacterStateDto::from)
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn list_character_states(
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<Vec<CharacterStateDto>, IpcError> {
    list_character_states_impl(&state, session_id)
}

// ---- LLM 调用轨迹（透明化功能：llm_calls 读路径）----

/// `list_llm_calls` 未显式传 limit 时的默认截断（最新 200 条，面板单页足够）。
pub const DEFAULT_LLM_CALL_LIST_LIMIT: u32 = 200;

fn list_llm_calls_impl(
    app: &AppState,
    session_id: i64,
    limit: Option<u32>,
) -> Result<Vec<LlmCallDto>, IpcError> {
    // 先会话在世校验（不存在 / 已软删报 NotFound，与 list_messages_impl 同构），
    // 再走存储端口；列表按 id 倒序（最新在前），无会话的 draft 轨迹天然不入。
    app.storage.get_session(session_id)?;
    Ok(app
        .storage
        .list_llm_calls(session_id, limit.unwrap_or(DEFAULT_LLM_CALL_LIST_LIMIT))?
        .into_iter()
        .map(LlmCallDto::from)
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn list_llm_calls(
    state: State<'_, AppState>,
    session_id: i64,
    limit: Option<u32>,
) -> Result<Vec<LlmCallDto>, IpcError> {
    list_llm_calls_impl(&state, session_id, limit)
}

// ---- 生成（TASK-006 闭环接线：FR-001 / FR-007 / FR-008 / SEQ-001）----

/// 命令层生成任务驱动：交给 Tauri 异步运行时（fire-and-forget；终态经事件通道回传）。
fn tauri_spawner() -> GenerationSpawner {
    Arc::new(|pending: PendingGeneration| {
        tauri::async_runtime::spawn(pending.run());
    })
}

fn generation_deps(app: &AppState, sink: Arc<dyn EventSink>, llm: LlmClient) -> GenerationDeps {
    // 配置读取一次（读当次值不缓存，ADR-012），派生两个装配期参数：
    // - 导演模型解析（FR-011 / INT-003）：跟随主模型、不做角色级覆写（§7-5）。
    //   解析失败 = 未配置 → None，生成闭环跳过结算（导演是可选能力，不阻塞生成）。
    // - 近景场景数（近景窗口可选化）：1–6，缺省 2；config 读取失败（坏文件等）
    //   回落 ADR-004 默认值，不阻塞正文生成。
    let config = app.config.load().ok();
    let director_llm = config
        .as_ref()
        .and_then(|config| director::resolve_director_llm(config).ok())
        .map(|client| Arc::new(with_call_trace(app, client)));
    let near_scenes = config
        .map_or(
            crate::domain::context::SETTLED_SCENES_IN_NEAR,
            |config| config.near_scenes as usize,
        );
    GenerationDeps {
        storage: app.storage.clone(),
        sink,
        llm: Arc::new(llm),
        director_llm,
        near_scenes,
    }
}

/// 给解析好的客户端挂接调用轨迹 sink（透明化功能）：组合根 setup 注入的组合实现
/// （TauriCallSink：落库 + Trace 事件）经 AppState 取用；None = 测试装配未注入，
/// 不记录（轨迹是旁路，缺席不阻塞任何主流程）。
fn with_call_trace(app: &AppState, llm: LlmClient) -> LlmClient {
    match app.call_sink() {
        Some(sink) => llm.with_call_sink(sink),
        None => llm,
    }
}

/// 两级模型配置解析（INT-002 / 验收 4）多角色裁量版：config.json 全局默认 ←
/// 「主持实例」模板卡的 model_config 覆写。主持实例 = 首个 LLM 位实例（与
/// generation::host_instance 同一归属语义）；实例无模板（动态造人）或无 LLM 位
/// （畸形阵容，存储层已拒绝）→ 不覆写，跟随全局默认。
fn resolve_llm(app: &AppState, session_id: i64) -> Result<LlmClient, IpcError> {
    let host_card = app
        .storage
        .list_instances(session_id)?
        .into_iter()
        .find(|i| !i.is_user)
        .and_then(|i| i.character_id)
        .map(|id| app.storage.get_character(id))
        .transpose()?;
    let config = app.config.load()?;
    let llm_config = generation::resolve_effective_llm(&config, host_card.as_ref())
        .map_err(|message| IpcError::Config { message })?;
    let llm =
        LlmClient::new(llm_config).map_err(|e| IpcError::Config { message: e.to_string() })?;
    Ok(with_call_trace(app, llm))
}

fn send_message_impl(
    app: &AppState,
    sink: Arc<dyn EventSink>,
    spawner: &GenerationSpawner,
    session_id: i64,
    content: String,
) -> Result<ChatMessage, IpcError> {
    let session = app.storage.get_session(session_id)?;
    let trimmed = content.trim().to_string();
    if trimmed.is_empty() {
        return Err(IpcError::Conflict { message: "消息内容为空".into() });
    }
    let llm = resolve_llm(app, session.id)?;
    // 同会话互斥（FR-007 多路并发为跨会话并发；同会话重复触发拒绝，FR-008）。
    let ticket = app
        .generation
        .begin(session_id)
        .map_err(|_| IpcError::Conflict { message: "该会话已有进行中的生成".into() })?;
    // 用户条先落库（FR-001 / SEQ-001：RS->RS 落库用户消息），归属用户位实例
    // （多角色换挂；恰一用户位由建会话保证）。
    let user_instance = app
        .storage
        .list_instances(session_id)?
        .into_iter()
        .find(|i| i.is_user);
    let user_message = match app.storage.insert_message(&models::NewMessage {
        instance_id: user_instance.map(|i| i.id),
        ..models::NewMessage::new(session_id, models::MessageRole::User, trimmed.clone())
    }) {
        Ok(m) => m,
        Err(e) => {
            app.generation.finish(session_id);
            return Err(e.into());
        }
    };
    // FR-007：会话标题缺省取首条用户消息截断。
    if session.title.is_empty() {
        if let Err(e) = app
            .storage
            .update_session_title(session_id, &generation::default_title(&trimmed))
        {
            app.generation.finish(session_id);
            return Err(e.into());
        }
    }
    spawner(PendingGeneration {
        deps: generation_deps(app, sink, llm),
        registry: app.generation.clone(),
        ticket,
        regenerate: false,
    });
    Ok(to_chat_message(user_message, None))
}

#[tauri::command]
#[specta::specta]
pub fn send_message(
    state: State<'_, AppState>,
    session_id: i64,
    content: String,
) -> Result<ChatMessage, IpcError> {
    send_message_impl(&state, state.sink(), &tauri_spawner(), session_id, content)
}

fn cancel_generation_impl(app: &AppState, session_id: i64) -> Result<bool, IpcError> {
    // 无活跃生成即幂等 no-op（返回 false）；有则瞬时取消（FR-001 / NFR-004），
    // 半条按 cancel 终态落库并经 error 事件收尾（services/generation）。
    Ok(app.generation.cancel(session_id))
}

#[tauri::command]
#[specta::specta]
pub fn cancel_generation(state: State<'_, AppState>, session_id: i64) -> Result<bool, IpcError> {
    cancel_generation_impl(&state, session_id)
}

fn regenerate_last_impl(
    app: &AppState,
    sink: Arc<dyn EventSink>,
    spawner: &GenerationSpawner,
    session_id: i64,
) -> Result<ChatMessage, IpcError> {
    let session = app.storage.get_session(session_id)?;
    let llm = resolve_llm(app, session.id)?;
    // FR-008：只对最后一条 assistant 消息提供重新生成。
    let old = app
        .storage
        .latest_assistant_message(session_id)?
        .ok_or_else(|| IpcError::Conflict { message: "会话没有可重新生成的回复".into() })?;
    let ticket = app
        .generation
        .begin(session_id)
        .map_err(|_| IpcError::Conflict { message: "该会话已有进行中的生成".into() })?;
    spawner(PendingGeneration {
        deps: generation_deps(app, sink, llm),
        registry: app.generation.clone(),
        ticket,
        regenerate: true,
    });
    // 返回被替换的旧条：前端据此将其从界面移除（旧条软删发生在终态落库时，FR-008）；
    // speaker = 消息自带实例真值（机械适配，同 list_messages_impl）。
    let speaker = old.instance_id;
    Ok(to_chat_message(old, speaker))
}

#[tauri::command]
#[specta::specta]
pub fn regenerate_last(state: State<'_, AppState>, session_id: i64) -> Result<ChatMessage, IpcError> {
    regenerate_last_impl(&state, state.sink(), &tauri_spawner(), session_id)
}

// ---- 角色 CRUD（FR-006，含 avatar）----

fn list_characters_impl(app: &AppState) -> Result<Vec<CharacterSummary>, IpcError> {
    // 会话计数（关系侧）多角色换挂：sessions 不再挂 character_id，改经在世会话的
    // 实例溯源统计（character_id = 模板卡 id 的实例数）。
    let sessions = app.storage.list_sessions()?;
    let mut counts: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    for s in sessions {
        for instance in app.storage.list_instances(s.id)? {
            if let Some(card) = instance.character_id {
                *counts.entry(card).or_insert(0) += 1;
            }
        }
    }
    Ok(app
        .storage
        .list_characters()?
        .into_iter()
        .map(|c| {
            let mut summary = character_summary_from(c);
            summary.session_count = counts.get(&summary.id).copied().unwrap_or(0);
            summary
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn list_characters(state: State<'_, AppState>) -> Result<Vec<CharacterSummary>, IpcError> {
    list_characters_impl(&state)
}

fn create_character_impl(
    app: &AppState,
    input: CharacterInput,
) -> Result<CharacterSummary, IpcError> {
    let created = app.storage.create_character(&models::NewCharacter {
        name: input.name,
        avatar: input.avatar,
        persona: input.persona,
        gender: input.gender,
        age: input.age,
        render_style: input.render_style,
        model_config: input.model_config,
        accent_color: input.accent_color,
        voice_config: input.voice_config,
    })?;
    Ok(CharacterSummary {
        session_count: 0,
        ..character_summary_from(created)
    })
}

#[tauri::command]
#[specta::specta]
pub fn create_character(
    state: State<'_, AppState>,
    input: CharacterInput,
) -> Result<CharacterSummary, IpcError> {
    create_character_impl(&state, input)
}

fn update_character_impl(
    app: &AppState,
    id: i64,
    input: UpdateCharacterInput,
) -> Result<(), IpcError> {
    // 历法接线（FR-013）：Some → 领域校验（对齐开局包惯例，失败报 Conflict）后序列化
    // 为存储 JSON（domain snake_case 键，与会话快照同构）；None / 缺键 → 清除历法。
    let calendar_config = match &input.calendar_config {
        Some(dto) => {
            let cal = fiction_time::CalendarConfig::from(dto);
            if !fiction_time::validate(&cal) {
                return Err(IpcError::Conflict {
                    message: "角色卡日历需每月天数 > 0 且月名 / 日名至少其一非空".into(),
                });
            }
            Some(serde_json::to_string(&cal).map_err(|e| IpcError::Conflict {
                message: format!("角色卡日历序列化失败：{e}"),
            })?)
        }
        None => None,
    };
    // 整卡覆盖（FR-006：编辑表单全量提交）；目标不存在 / 已软删报 NotFound。
    app.storage.update_character(
        id,
        &models::UpdateCharacter {
            name: input.name,
            avatar: input.avatar,
            persona: input.persona,
            gender: input.gender,
            age: input.age,
            render_style: input.render_style,
            model_config: input.model_config,
            accent_color: input.accent_color,
            voice_config: input.voice_config,
            calendar_config,
        },
    )?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn update_character(
    state: State<'_, AppState>,
    id: i64,
    input: UpdateCharacterInput,
) -> Result<(), IpcError> {
    update_character_impl(&state, id, input)
}

fn delete_character_impl(app: &AppState, id: i64) -> Result<(), IpcError> {
    // 软删（ADR-009）；其会话 / 消息保留墓碑之下，restore 可还原。
    app.storage.soft_delete_character(id)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn delete_character(state: State<'_, AppState>, id: i64) -> Result<(), IpcError> {
    delete_character_impl(&state, id)
}

// ---- 角色卡导出/导入（Task-04；对话框 + 文件读写属 interface 关注点）----
//
// JSON 构建/解析/校验纯函数在 services::character_io；本节只负责：原生「保存 /
// 打开文件」对话框（tauri-plugin-dialog 的 Rust 侧 blocking API，不经前端 IPC
// 权限）、磁盘读写、把服务层错误映射为 IpcError。blocking API 不得在主线程调用
//（会与事件循环互锁），故两条命令均标 `#[tauri::command(async)]` 交给异步运行时线程。

/// 卡文件导入错误 → IpcError：全部是「所选文件非法入参」，统一归入 Conflict。
fn map_card_import_error(e: character_io::CardImportError) -> IpcError {
    IpcError::Conflict { message: e.to_string() }
}

/// 对话框选出的路径（可能为 file:// URL 形态）→ 常规路径；UNC 前缀（`\\?\`）简化。
fn picked_file_path(picked: tauri_plugin_dialog::FilePath) -> Result<std::path::PathBuf, IpcError> {
    picked
        .simplified()
        .into_path()
        .map_err(|e| IpcError::Conflict { message: format!("无法解析所选文件路径：{e}") })
}

/// 导出数据段（对话框前的纯数据部分，可测）：目标不存在/已软删报 NotFound；
/// 成功返回（默认文件名 `<角色名>.json`，卡 JSON 文本）。
fn export_character_data(app: &AppState, id: i64) -> Result<(String, String), IpcError> {
    let character = app.storage.get_character(id)?;
    Ok((
        character_io::card_file_name(&character.name),
        character_io::build_card_json(&character),
    ))
}

#[tauri::command(async)]
#[specta::specta]
pub fn export_character(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<String>, IpcError> {
    let (file_name, json) = export_character_data(&state, id)?;
    // 「保存文件」对话框：默认文件名 <角色名>.json，JSON 过滤；取消返回 None。
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name(file_name)
        .blocking_save_file();
    let Some(path) = picked.map(picked_file_path).transpose()? else {
        return Ok(None);
    };
    std::fs::write(&path, json)
        .map_err(|e| IpcError::Storage { message: format!("写入角色卡文件失败：{e}") })?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// 导入数据段（对话框后的纯数据部分，可测）：解析校验（services::character_io）
/// 后经既有 create_character 路径建新卡——不复用旧 id、允许重名，直接落库。
fn import_character_data(app: &AppState, text: &str) -> Result<CharacterSummary, IpcError> {
    let payload = character_io::parse_card_json(text).map_err(map_card_import_error)?;
    create_character_impl(app, CharacterInput::from(payload))
}

#[tauri::command(async)]
#[specta::specta]
pub fn import_character(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<CharacterSummary>, IpcError> {
    // 「打开文件」对话框：JSON 过滤；取消返回 None。
    let picked = app.dialog().file().add_filter("JSON", &["json"]).blocking_pick_file();
    let Some(path) = picked.map(picked_file_path).transpose()? else {
        return Ok(None);
    };
    let text = std::fs::read_to_string(&path)
        .map_err(|e| IpcError::Storage { message: format!("读取角色卡文件失败：{e}") })?;
    Ok(Some(import_character_data(&state, &text)?))
}

// ---- 配置（FR-009 / ADR-012 / TASK-003）----

fn get_config_impl(app: &AppState) -> Result<ConfigDto, IpcError> {
    // 读当次值不缓存（ADR-012）：每次 load()，外部手改立即生效。
    Ok(ConfigDto::from(&app.config.load()?))
}

#[tauri::command]
#[specta::specta]
pub fn get_config(state: State<'_, AppState>) -> Result<ConfigDto, IpcError> {
    get_config_impl(&state)
}

fn save_config_impl(app: &AppState, config: ConfigDto) -> Result<(), IpcError> {
    // save = 校验 + 原子写（ADR-012）；越界值（如 rhythm 10–160 外）在此被拒。
    app.config.save(&FileConfig::from(config))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn save_config(state: State<'_, AppState>, config: ConfigDto) -> Result<(), IpcError> {
    save_config_impl(&state, config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::{NewCharacter, NewMessage, NewSession, RosterPick};
    use crate::domain::ports::StoragePort;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// 每个测试独享的临时主目录；绝不写真实 home（ADR-012）。
    fn temp_state(tag: &str) -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "chronoveil_ipc_test_{}_{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed),
            tag
        ));
        let _ = std::fs::remove_dir_all(&dir);
        (AppState::init_with_home(Some(dir.clone())).unwrap(), dir)
    }

    fn sample_character(app: &AppState, name: &str) -> models::Character {
        app.storage
            .create_character(&NewCharacter {
                name: name.into(),
                ..Default::default()
            })
            .unwrap()
    }

    /// 由 create 负载派生更新入参（历法缺省 None = 清除；历法用例按需覆写 calendar_config）。
    fn upd_input(name: &str, base: &CharacterInput) -> UpdateCharacterInput {
        UpdateCharacterInput {
            name: name.into(),
            avatar: base.avatar.clone(),
            persona: base.persona.clone(),
            gender: base.gender.clone(),
            age: base.age.clone(),
            render_style: base.render_style.clone(),
            model_config: base.model_config.clone(),
            accent_color: base.accent_color.clone(),
            voice_config: base.voice_config.clone(),
            calendar_config: None,
        }
    }

    // ---- 生成命令测试替身（不经 Tauri 运行时 / 事件通道）----

    struct DropSink;

    impl crate::infra::llm::EventSink for DropSink {
        fn emit(&self, _event: crate::infra::llm::LlmEvent) {}
    }

    fn noop_sink() -> Arc<dyn crate::infra::llm::EventSink> {
        Arc::new(DropSink)
    }

    fn noop_spawner() -> GenerationSpawner {
        Arc::new(|_pending: PendingGeneration| {
            // 测试不驱动生成任务（闭环集成见 services/generation 的 mock 网关测试）。
        })
    }

    // ---- wire 契约（camelCase 对应 types.ts；验收 2/4 的测试兜底）----

    #[test]
    fn session_summary_serializes_camel_case() {
        // 语义（多角色阵容制，Task-31）：sessions.character_id 移除，阵容/扮演位
        // 经 instances 回显（wire camelCase：isUser / characterId / renderStyle）。
        let json = serde_json::to_value(SessionSummary {
            id: 3,
            title: "雨夜来电".into(),
            updated_at: 1234,
            instances: vec![SessionInstanceDto {
                id: 1,
                name: "旅人".into(),
                is_user: true,
                character_id: Some(9),
                render_style: "type".into(),
            }],
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": 3,
                "title": "雨夜来电",
                "updatedAt": 1234,
                "instances": [
                    { "id": 1, "name": "旅人", "isUser": true, "characterId": 9, "renderStyle": "type" }
                ]
            })
        );
    }

    #[test]
    fn chat_message_serializes_camel_case_and_interrupted() {
        let msg = to_chat_message(
            models::Message {
                id: 9,
                session_id: 1,
                role: models::MessageRole::Assistant,
                content: "**雨**落".into(),
                reasoning: Some("氛围".into()),
                think_ms: Some(1800),
                tokens: None,
                created_at: 42,
                interrupt_flag: Some("user_cancel".into()),
                scene_id: None,
                instance_id: Some(5),
                deleted_at: None,
            },
            Some(5),
        );
        let json = serde_json::to_value(&msg).unwrap();
        assert_eq!(json["sessionId"], 1);
        assert_eq!(json["characterId"], 5);
        assert_eq!(json["role"], "assistant");
        assert_eq!(json["thinkMs"], 1800);
        assert_eq!(json["createdAt"], 42);
        assert_eq!(json["interrupted"], true, "interrupt_flag 有值即 interrupted");
    }

    #[test]
    fn user_message_has_null_character() {
        let msg = to_chat_message(
            models::Message {
                role: models::MessageRole::User,
                interrupt_flag: None,
                id: 1,
                session_id: 1,
                content: String::new(),
                reasoning: None,
                think_ms: None,
                tokens: None,
                created_at: 1,
                scene_id: None,
                instance_id: None,
                deleted_at: None,
            },
            None,
        );
        let json = serde_json::to_value(&msg).unwrap();
        assert!(json["characterId"].is_null(), "用户消息 characterId 必须为 null");
        assert_eq!(json["interrupted"], false);
    }

    #[test]
    fn scene_dto_serializes_camel_case_without_session_or_tombstone() {
        let dto = SceneDto::from(models::Scene {
            id: 7,
            session_id: 3,
            idx: 2,
            location: Some("旧都 · 灯市".into()),
            time_note: Some("入夜后一刻".into()),
            fic_day: Some(45),
            fic_part: Some("夜".into()),
            date_label: Some("白蜡月·晨露日·夜（灯节）".into()),
            summary: Some("灯市口的一场相逢".into()),
            recap: None,
            present: vec![1, 5],
            deleted_at: None,
        });
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": 7, "idx": 2,
                "location": "旧都 · 灯市", "timeNote": "入夜后一刻",
                "ficDay": 45, "ficPart": "夜",
                "dateLabel": "白蜡月·晨露日·夜（灯节）",
                "summary": "灯市口的一场相逢", "recap": null,
                "present": [1, 5],
            })
        );
        assert!(json.get("sessionId").is_none(), "列表已按会话过滤，不重复携带 sessionId");
        assert!(json.get("deletedAt").is_none(), "存储层滤墓碑，wire 不带 deletedAt");
    }

    #[test]
    fn character_state_dto_serializes_camel_case_with_scope() {
        let to_json = |scope| {
            serde_json::to_value(CharacterStateDto::from(models::CharacterState {
                id: 9,
                instance_id: 5,
                scope,
                key: "情绪".into(),
                value: "强撑镇定".into(),
                expiry: Some("scene_end".into()),
                source_scene: Some(2),
                updated_at: 84,
                deleted_at: None,
            }))
            .unwrap()
        };
        let json = to_json(models::CharacterStateScope::State);
        assert_eq!(json["scope"], "state", "scope wire 小写（state | relation）");
        assert_eq!(json["instanceId"], 5, "机械适配：characterId → instanceId 真值换挂");
        assert_eq!(json["sourceScene"], 2);
        assert_eq!(json["expiry"], "scene_end");
        assert_eq!(json["updatedAt"], 84);
        assert!(json.get("sessionId").is_none(), "同 SceneDto：不重复携带 sessionId");

        let relation = to_json(models::CharacterStateScope::Relation);
        assert_eq!(relation["scope"], "relation");
    }

    #[test]
    fn ipc_error_is_serializable_and_typed_by_kind() {
        let e = IpcError::from(crate::domain::error::StorageError::NotFound {
            entity: "session",
            id: 404,
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "notFound", "判别字段 kind（camelCase）");
        assert_eq!(json["entity"], "session");
        assert_eq!(json["id"], 404);

        let conflict = serde_json::to_value(IpcError::Conflict { message: "内容为空".into() }).unwrap();
        assert_eq!(conflict["kind"], "conflict");
        assert_eq!(conflict["message"], "内容为空");
        // Display / std::error::Error 可用（日志与前端提示均可读）。
        assert!(e.to_string().contains("session #404"), "Display 人类可读：{e}");
    }

    #[test]
    fn config_dto_roundtrip_through_file_config() {
        let dto = ConfigDto {
            providers: vec![ProviderDto {
                id: "p1".into(),
                name: "本地中转".into(),
                base_url: "https://example.invalid/v1".into(),
                api_key: "sk-test".into(),
                models: vec!["m1".into(), "m2".into()],
            }],
            active_provider_id: Some("p1".into()),
            active_model: Some("m2".into()),
            rhythm_ms_per_char: 90,
            punct_pause_enabled: false,
            anim_duration_base: 300,
            ui_language: "zh".into(),
            ui_theme: "dark".into(),
            director_model: None,
            near_scenes: 4,
        };
        let wire = serde_json::to_value(&dto).unwrap();
        assert_eq!(wire["activeProviderId"], "p1", "wire camelCase");
        assert_eq!(wire["activeModel"], "m2", "wire camelCase");
        assert_eq!(wire["providers"][0]["baseUrl"], "https://example.invalid/v1");
        assert_eq!(wire["providers"][0]["models"], serde_json::json!(["m1", "m2"]));
        assert_eq!(wire["rhythmMsPerChar"], 90);
        assert_eq!(wire["nearScenes"], 4, "近景场景数 camelCase 透传");

        let file: FileConfig = dto.clone().into();
        let back: ConfigDto = (&file).into();
        assert_eq!(dto, back, "DTO ↔ 落盘结构往返无损");
        assert_eq!(file.rhythm_ms_per_char, 90);
        assert_eq!(file.near_scenes, 4);
        assert_eq!(file.providers[0].models, vec!["m1".to_string(), "m2".to_string()]);
    }

    // ---- 命令实现（不经 Tauri 运行时，直接走 AppState）----

    #[test]
    fn session_commands_cover_list_create_softdelete() {
        let (app, dir) = temp_state("sessions");
        let llm_card = sample_character(&app, "苏鸢");
        let user_card = sample_character(&app, "旅人");
        let roster = |user: i64, llm: i64| {
            vec![
                RosterPickInput { character_id: user, is_user: true },
                RosterPickInput { character_id: llm, is_user: false },
            ]
        };

        let created = create_session_impl(&app, roster(user_card.id, llm_card.id), None, None).unwrap();
        assert_eq!(created.title, "", "缺省标题为空串（首条用户消息后回填属 TASK-006）");

        create_session_impl(&app, roster(user_card.id, llm_card.id), Some("旧书店".into()), None)
            .unwrap();
        let listed = list_sessions_impl(&app).unwrap();
        assert_eq!(listed.len(), 2);

        delete_session_impl(&app, created.id).unwrap();
        assert!(list_sessions_impl(&app).unwrap().len() == 1, "软删后列表不再可见");
        // 重复删除同一目标：已软删等价不可见 → NotFound。
        assert!(matches!(
            delete_session_impl(&app, created.id),
            Err(IpcError::NotFound { .. })
        ));
        // 阵容引用不存在的卡 → NotFound（实例化路径的逐卡语义，而非裸外键冲突）。
        assert!(matches!(
            create_session_impl(&app, roster(user_card.id, 999_999), None, None),
            Err(IpcError::NotFound { .. })
        ));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 阵容回显（多角色阵容制 wire，Task-31）：create / list 的 SessionSummary.instances
    /// 携带建会话快照（D1/D2）——快照名值拷贝、is_user 恰好一、模板溯源、renderStyle
    /// 快照；顺序 = 创建序（用户位在前）。改卡不回写既有会话的快照（D1 经 wire 可验）。
    #[test]
    fn session_summary_echoes_roster_instances() {
        let (app, dir) = temp_state("roster_echo");
        let llm_card = sample_character(&app, "苏鸢");
        let user_card = sample_character(&app, "旅人");
        let roster = vec![
            RosterPickInput { character_id: user_card.id, is_user: true },
            RosterPickInput { character_id: llm_card.id, is_user: false },
        ];

        let created =
            create_session_impl(&app, roster, Some("雨夜来电".into()), None).unwrap();
        // 回显 = 建会话入参的实例化快照；示例卡 render_style 均为缺省 "type"（models::NewCharacter）。
        assert_eq!(created.title, "雨夜来电", "title 保留在 wire（缺省空串由首条用户消息回填）");
        let echo: Vec<(&str, bool, Option<i64>, &str)> = created
            .instances
            .iter()
            .map(|i| (i.name.as_str(), i.is_user, i.character_id, i.render_style.as_str()))
            .collect();
        assert_eq!(
            echo,
            vec![
                ("旅人", true, Some(user_card.id), "type"),
                ("苏鸢", false, Some(llm_card.id), "type"),
            ],
            "instances 按创建序（用户位在前），快照字段齐全"
        );
        assert_eq!(created.instances[0].id, 1, "实例 id 为全局自增 PK，跨会话不重复");

        // list_sessions 同样回显（列表消费方〈侧栏 / 聊天说话人映射〉不依赖 create 返回值）。
        let listed = list_sessions_impl(&app).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].instances.len(), 2);

        // D1 快照语义：改卡不回写既有会话——renderStyle / 名字保持建会话时的值拷贝。
        app.storage.update_character(
            llm_card.id,
            &models::UpdateCharacter {
                name: "苏鸢·改".into(),
                avatar: llm_card.avatar.clone(),
                persona: llm_card.persona.clone(),
                gender: llm_card.gender.clone(),
                age: llm_card.age.clone(),
                render_style: "ink".into(),
                model_config: llm_card.model_config.clone(),
                accent_color: llm_card.accent_color.clone(),
                voice_config: None,
                calendar_config: None,
            },
        ).unwrap();
        let after = list_sessions_impl(&app).unwrap();
        let llm_instance = &after[0].instances[1];
        assert_eq!(llm_instance.name, "苏鸢", "实例名 = 建会话快照，改卡不回写");
        assert_eq!(llm_instance.render_style, "type", "renderStyle = 建会话快照，改卡不回写");
        assert_eq!(llm_instance.character_id, Some(llm_card.id), "模板溯源不变");

        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn create_session_with_opening_seeds_calendar_and_anchor() {
        let (app, dir) = temp_state("opening");
        let llm_card = sample_character(&app, "苏鸢");
        let user_card = sample_character(&app, "旅人");
        let roster = vec![
            RosterPickInput { character_id: user_card.id, is_user: true },
            RosterPickInput { character_id: llm_card.id, is_user: false },
        ];

        let opening = SessionOpeningInput {
            calendar: Some(CalendarConfigDto {
                name: Some("旧都历".into()),
                months: vec!["霜月".into(), "白蜡月".into()],
                days_per_month: 30,
                day_names: vec!["晨露日".into(), "萤火日".into()],
                festivals: Some(std::collections::BTreeMap::from([(45, "灯节".into())])),
            }),
            fic_day: Some(45),
            fic_part: Some("夜".into()),
            location: Some("旧都 · 灯市".into()),
            time_note: None,
        };
        let created = create_session_impl(&app, roster.clone(), None, Some(&opening)).unwrap();

        // 会话日历 = 显式指定的 snake_case 存储 JSON（wire camelCase 不入库）。
        let stored = app.storage.get_session(created.id).unwrap().calendar_config.unwrap();
        assert!(stored.contains("days_per_month"), "存储 JSON 为 snake_case：{stored}");
        assert!(!stored.contains("daysPerMonth"), "存储 JSON 不得混入 wire 键：{stored}");
        // 开场锚行：idx=0、锚位与派生 date_label、在场 = 会话角色。
        let scene = app.storage.latest_scene(created.id).unwrap().unwrap();
        assert_eq!(scene.idx, 0);
        assert_eq!(scene.fic_day, Some(45));
        assert_eq!(scene.fic_part.as_deref(), Some("夜"));
        assert_eq!(scene.date_label.as_deref(), Some("白蜡月·晨露日·夜（灯节）"));
        assert_eq!(scene.location.as_deref(), Some("旧都 · 灯市"));
        // 在场 = 全部阵容实例（roster 输入序 = 实例创建序，多角色换挂语义）。
        assert_eq!(scene.present, vec![1, 2]);

        // 降级路径（opening = None）：默认锚行（day=1 / part=夜）无条件存在。
        let degraded = create_session_impl(&app, roster, None, None).unwrap();
        let scene = app.storage.latest_scene(degraded.id).unwrap().unwrap();
        assert_eq!((scene.idx, scene.fic_day, scene.fic_part.as_deref()), (0, Some(1), Some("夜")));
        assert_eq!(scene.date_label.as_deref(), Some("第1日·夜"), "角色无日历 → 数字形式");
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// FR-014：开局入参校验（Conflict）——时段六值、起始日 ≥ 1、显式日历皮肤可用性。
    #[test]
    fn create_session_rejects_invalid_opening() {
        let (app, dir) = temp_state("opening_invalid");
        let llm_card = sample_character(&app, "苏鸢");
        let user_card = sample_character(&app, "旅人");
        let roster = vec![
            RosterPickInput { character_id: user_card.id, is_user: true },
            RosterPickInput { character_id: llm_card.id, is_user: false },
        ];

        let mut opening = SessionOpeningInput {
            calendar: None,
            fic_day: None,
            fic_part: None,
            location: None,
            time_note: None,
        };
        // 时段不在六值内 → Conflict。
        let bad_part = SessionOpeningInput { fic_part: Some("半夜三更".into()), ..opening.clone() };
        assert!(matches!(
            create_session_impl(&app, roster.clone(), None, Some(&bad_part)),
            Err(IpcError::Conflict { .. })
        ));
        // 起始日 < 1 → Conflict。
        let bad_day = SessionOpeningInput { fic_day: Some(0), ..opening.clone() };
        assert!(matches!(
            create_session_impl(&app, roster.clone(), None, Some(&bad_day)),
            Err(IpcError::Conflict { .. })
        ));
        // 显式日历缺月长基准（days_per_month = 0）→ Conflict（对齐 has_skin）。
        opening.calendar = Some(CalendarConfigDto {
            name: Some("坏历".into()),
            months: vec!["霜月".into()],
            days_per_month: 0,
            day_names: Vec::new(),
            festivals: None,
        });
        assert!(matches!(
            create_session_impl(&app, roster, None, Some(&opening)),
            Err(IpcError::Conflict { .. })
        ));
        // 校验失败零落库（连降级锚行也没有）。
        assert!(list_sessions_impl(&app).unwrap().is_empty());
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- AI 起草历法（FR-014 二期）----

    /// wire 形态：camelCase + festivals 数字字符串键；与 domain 往返无损。
    #[test]
    fn calendar_config_dto_serializes_camel_case_with_numeric_festival_keys() {
        let domain = fiction_time::presets::fantasy();
        let dto = CalendarConfigDto::from(&domain);
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["name"], "旧都历");
        assert_eq!(json["daysPerMonth"], 30);
        assert_eq!(
            json["festivals"]["45"], "灯节",
            "节日键 = 数字字符串（BTreeMap<i64, String> 的 JSON 形态）"
        );
        assert_eq!(json["festivals"]["360"], "守夜");
        // domain → DTO → domain 往返无损。
        assert_eq!(fiction_time::CalendarConfig::from(&dto), domain);
        // 空节日表 → wire null（None = 无节日的规范形态，与反向 From 对称）。
        let mut bare = domain.clone();
        bare.festivals.clear();
        assert!(
            serde_json::to_value(CalendarConfigDto::from(&bare)).unwrap()["festivals"].is_null()
        );
    }

    /// 命令语义：provider 未配置 → Config 分型（明确文案）；空白描述 → Conflict
    /// （参数错误先于任何网络调用，与 services/calendar_draft 同文案）。
    #[tokio::test]
    async fn draft_calendar_command_rejects_blank_and_unconfigured_provider() {
        let (app, dir) = temp_state("draft");
        // signal 必须活过整个调用（watch 语义），通道在测试体内创建。
        let (_signal, cancel) = crate::infra::llm::cancel_channel();
        let err = draft_calendar_impl(&app, "旧都世界观", &cancel).await.unwrap_err();
        assert!(matches!(err, IpcError::Config { .. }));
        assert!(err.to_string().contains("未配置全局默认模型"), "实际：{err}");

        // 配置全局默认 provider（base_url 指向黑洞：空白描述不应触网）。
        let mut config = crate::infra::config::Config::new_with_defaults();
        config.providers = vec![crate::infra::config::ProviderConfig {
            id: "p1".into(),
            name: "测试".into(),
            base_url: "http://127.0.0.1:9/v1".into(),
            api_key: "k".into(),
            models: vec!["m".into()],
            model: None,
        }];
        config.active_provider_id = Some("p1".into());
        config.active_model = Some("m".into());
        app.config.save(&config).unwrap();

        let err = draft_calendar_impl(&app, "   ", &cancel).await.unwrap_err();
        match err {
            IpcError::Conflict { message } => {
                assert_eq!(message, "描述内容为空：请先填写世界观描述");
            }
            other => panic!("空白描述应报 Conflict，实际 {other:?}"),
        }
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 全链路（mock LLM 服务）：config.json 全局默认模型 → 起草 → DTO wire 形态
    /// （camelCase + festivals 数字字符串键）。
    #[tokio::test]
    async fn draft_calendar_command_returns_dto_through_mock_llm() {
        let (app, dir) = temp_state("draft_ok");
        let content = r#"```json
{"name":"白蜡历","months":["白蜡月","烬月"],"daysPerMonth":30,
 "dayNames":["晨露日"],"festivals":{"45":"灯节"}}
```"#
        .to_string();
        let server = crate::infra::llm::mock::MockServer::start(move |_req, stream| {
            let _ = crate::infra::llm::mock::json_body(stream, &content);
        });
        let mut config = crate::infra::config::Config::new_with_defaults();
        config.providers = vec![crate::infra::config::ProviderConfig {
            id: "p1".into(),
            name: "测试".into(),
            base_url: server.url(),
            api_key: "k".into(),
            models: vec!["m".into()],
            model: None,
        }];
        config.active_provider_id = Some("p1".into());
        config.active_model = Some("m".into());
        app.config.save(&config).unwrap();

        let dto = {
            let (_signal, cancel) = crate::infra::llm::cancel_channel();
            draft_calendar_impl(&app, "旧都世界观", &cancel).await.unwrap()
        };
        assert_eq!(dto.name.as_deref(), Some("白蜡历"));
        assert_eq!(dto.days_per_month, 30);
        assert_eq!(dto.months, vec!["白蜡月".to_string(), "烬月".to_string()]);
        assert_eq!(dto.festivals.as_ref().unwrap()[&45], "灯节");
        // DTO 可无损转回 domain（前端保存走 update_character 的领域校验地基）。
        assert!(fiction_time::validate(&fiction_time::CalendarConfig::from(&dto)));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn message_commands_derive_character_and_reject_missing_session() {
        let (app, dir) = temp_state("messages");
        let user_card = sample_character(&app, "旅人");
        let llm_card = sample_character(&app, "林深");
        let session = app
            .storage
            .create_session(&NewSession {
                roster: vec![
                    RosterPick { character_id: llm_card.id, is_user: false },
                    RosterPick { character_id: user_card.id, is_user: true },
                ],
                title: String::new(),
                opening: None,
            })
            .unwrap();
        // roster 首位 = LLM 位 → 其实例 id = 1（说话人真值换挂）。
        let llm_instance = app
            .storage
            .list_instances(session.id)
            .unwrap()
            .into_iter()
            .find(|i| !i.is_user)
            .unwrap()
            .id;
        app.storage
            .insert_message(&NewMessage::new(session.id, models::MessageRole::User, "在吗？"))
            .unwrap();
        app.storage
            .insert_message(&NewMessage {
                session_id: session.id,
                role: models::MessageRole::Assistant,
                content: "在。".into(),
                reasoning: Some("低语".into()),
                think_ms: Some(1200),
                tokens: None,
                interrupt_flag: None,
                instance_id: Some(llm_instance),
            })
            .unwrap();

        let listed = list_messages_impl(&app, session.id).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed[0].character_id.is_none(), "用户消息 speaker 为 null");
        // 语义变化（多角色换挂）：speaker = messages.instance_id 实例真值（不再由
        // 命令层从 sessions.character_id 推导假值）。
        assert_eq!(listed[1].character_id, Some(llm_instance), "assistant speaker = 说话人实例");
        assert_eq!(listed[1].think_ms, Some(1200));

        assert!(matches!(
            list_messages_impl(&app, 12345),
            Err(IpcError::NotFound { .. })
        ));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 场景与人物状态列表（FR-011 / FR-012 读路径）----

    #[test]
    fn scene_and_state_list_commands_check_session_and_order() {
        let (app, dir) = temp_state("scenes_states");
        let user_card = sample_character(&app, "旅人");
        let llm_card = sample_character(&app, "苏鸢");
        let session = app
            .storage
            .create_session(&NewSession {
                roster: vec![
                    RosterPick { character_id: llm_card.id, is_user: false },
                    RosterPick { character_id: user_card.id, is_user: true },
                ],
                title: String::new(),
                opening: None,
            })
            .unwrap();

        // 开场锚行无条件存在（FR-014 §7-6）：场景列表按 idx 升序返回在世行；
        // present = 全部实例 id（多角色换挂，roster 两位）。
        let listed = list_scenes_impl(&app, session.id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].idx, 0);
        assert_eq!(listed[0].present, vec![1, 2]);

        // 再落两行（idx 单调自增），列表按叙事顺序返回、字段逐一映射。
        app.storage
            .insert_scene(&models::NewScene {
                session_id: session.id,
                location: Some("灯市".into()),
                time_note: None,
                fic_day: Some(45),
                fic_part: Some("夜".into()),
                date_label: Some("白蜡月·晨露日·夜（灯节）".into()),
                summary: None,
                recap: None,
                present: vec![1, 2],
            })
            .unwrap();
        app.storage
            .insert_scene(&models::NewScene {
                session_id: session.id,
                location: None,
                time_note: Some("次日清晨".into()),
                fic_day: Some(46),
                fic_part: Some("清晨".into()),
                date_label: None,
                summary: Some("码头启程".into()),
                recap: None,
                present: Vec::new(),
            })
            .unwrap();
        let listed = list_scenes_impl(&app, session.id).unwrap();
        assert_eq!(listed.iter().map(|s| s.idx).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert_eq!(listed[1].location.as_deref(), Some("灯市"));
        assert_eq!(listed[1].date_label.as_deref(), Some("白蜡月·晨露日·夜（灯节）"));
        assert_eq!(listed[2].summary.as_deref(), Some("码头启程"));
        assert!(listed[2].present.is_empty(), "空在场数组原样透传");

        // 人物状态：空会话返回空数组；upsert 后按 id 升序，scope wire 映射正确。
        assert!(list_character_states_impl(&app, session.id).unwrap().is_empty());
        let first = app
            .storage
            .upsert_character_state(&models::NewCharacterState {
                instance_id: 1,
                scope: models::CharacterStateScope::State,
                key: "情绪".into(),
                value: "强撑镇定".into(),
                expiry: Some("scene_end".into()),
                source_scene: Some(listed[1].id),
            })
            .unwrap();
        app.storage
            .upsert_character_state(&models::NewCharacterState {
                instance_id: 1,
                scope: models::CharacterStateScope::Relation,
                key: "对织灯人的态度".into(),
                value: "戒备渐消".into(),
                expiry: None,
                source_scene: None,
            })
            .unwrap();
        let states = list_character_states_impl(&app, session.id).unwrap();
        assert_eq!(states.len(), 2);
        assert_eq!(states[0].id, first.id);
        assert_eq!(states[0].scope, CharacterStateScope::State);
        assert_eq!(states[0].source_scene, Some(listed[1].id));
        assert_eq!(states[1].scope, CharacterStateScope::Relation);

        // 软删状态不进读路径（ADR-009 墓碑过滤属存储层职责，读端不重复实现）。
        app.storage.soft_delete_character_state(states[1].id).unwrap();
        assert_eq!(list_character_states_impl(&app, session.id).unwrap().len(), 1);

        // 不存在 / 已软删会话 → NotFound（与 list_messages_impl 同语义，非空列表）。
        delete_session_impl(&app, session.id).unwrap();
        assert!(matches!(
            list_scenes_impl(&app, session.id),
            Err(IpcError::NotFound { .. })
        ));
        assert!(matches!(
            list_character_states_impl(&app, session.id),
            Err(IpcError::NotFound { .. })
        ));
        assert!(matches!(
            list_scenes_impl(&app, 999_999),
            Err(IpcError::NotFound { .. })
        ));
        assert!(matches!(
            list_character_states_impl(&app, 999_999),
            Err(IpcError::NotFound { .. })
        ));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn llm_call_dto_serializes_camel_case() {
        let dto = LlmCallDto::from(models::LlmCall {
            id: 12,
            session_id: Some(3),
            kind: models::LlmCallKind::Dialogue,
            model: "test-model".into(),
            started_at: 1_000,
            duration_ms: 250,
            prompt_json: r#"[{"role":"user","content":"你好"}]"#.into(),
            response_text: Some("在。".into()),
            reasoning_text: Some("想想".into()),
            tool_calls_json: Some(r#"[{"name":"search_history","arguments":"{}"}]"#.into()),
            prompt_tokens: Some(11),
            completion_tokens: None,
            status: models::LlmCallStatus::Ok,
            error_text: None,
        });
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["id"], 12);
        assert_eq!(json["sessionId"], 3);
        assert_eq!(json["kind"], "dialogue");
        assert_eq!(json["startedAt"], 1_000, "wire camelCase");
        assert_eq!(json["durationMs"], 250);
        assert_eq!(json["promptJson"], r#"[{"role":"user","content":"你好"}]"#, "string 透传");
        assert_eq!(json["responseText"], "在。");
        assert_eq!(json["toolCallsJson"], r#"[{"name":"search_history","arguments":"{}"}]"#);
        assert_eq!(json["promptTokens"], 11);
        assert!(json["completionTokens"].is_null());
        assert_eq!(json["status"], "ok");
        assert!(json["errorText"].is_null());
    }

    /// LLM 调用轨迹读路径（透明化功能）：先会话在世校验（NotFound 同构），
    /// 空会话返回空数组；正常返回 id 倒序且 limit 生效。
    #[test]
    fn list_llm_calls_checks_session_orders_desc_and_caps() {
        let (app, dir) = temp_state("llm_calls");
        let user_card = sample_character(&app, "旅人");
        let character = sample_character(&app, "苏鸢");
        let session = app
            .storage
            .create_session(&NewSession {
                roster: vec![
                    RosterPick { character_id: user_card.id, is_user: true },
                    RosterPick { character_id: character.id, is_user: false },
                ],
                title: String::new(),
                opening: None,
            })
            .unwrap();
        // 空会话：在世但无轨迹 → 空数组（非 NotFound）。
        assert!(list_llm_calls_impl(&app, session.id, None).unwrap().is_empty());

        for i in 0..3 {
            app.storage
                .insert_llm_call(&models::NewLlmCall {
                    session_id: Some(session.id),
                    kind: models::LlmCallKind::Explorer,
                    model: "test-model".into(),
                    started_at: i,
                    duration_ms: 10,
                    prompt_json: "[]".into(),
                    response_text: None,
                    reasoning_text: None,
                    tool_calls_json: None,
                    prompt_tokens: None,
                    completion_tokens: None,
                    status: models::LlmCallStatus::Ok,
                    error_text: None,
                })
                .unwrap();
        }

        // limit 生效：截取最新 2 条（id 倒序头两行）。
        let listed = list_llm_calls_impl(&app, session.id, Some(2)).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed[0].id > listed[1].id, "最新在前");
        assert_eq!(listed[0].kind, LlmCallKindDto::Explorer);

        // 缺省 limit 走 DEFAULT_LLM_CALL_LIST_LIMIT（3 条全出）。
        assert_eq!(list_llm_calls_impl(&app, session.id, None).unwrap().len(), 3);

        // 不存在 / 已软删会话 → NotFound（与 list_messages_impl 同语义）。
        delete_session_impl(&app, session.id).unwrap();
        assert!(matches!(
            list_llm_calls_impl(&app, session.id, None),
            Err(IpcError::NotFound { .. })
        ));
        assert!(matches!(
            list_llm_calls_impl(&app, 999_999, None),
            Err(IpcError::NotFound { .. })
        ));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generation_commands_wire_send_cancel_and_regenerate() {
        let (app, dir) = temp_state("generation");
        let user_card = sample_character(&app, "旅人");
        let llm_card = sample_character(&app, "苏鸢");
        let session = app
            .storage
            .create_session(&NewSession {
                roster: vec![
                    RosterPick { character_id: llm_card.id, is_user: false },
                    RosterPick { character_id: user_card.id, is_user: true },
                ],
                title: String::new(),
                opening: None,
            })
            .unwrap();

        // Provider 未配置 → 类型化 Config 错误；用户条与注册表零副作用。
        let err = send_message_impl(&app, noop_sink(), &noop_spawner(), session.id, "你好".into())
            .unwrap_err();
        assert!(matches!(err, IpcError::Config { .. }));
        assert!(app.storage.list_messages(session.id).unwrap().is_empty());

        // 配置全局默认 Provider（两级配置的底层，FR-009；双层级 provider→models）。
        let mut config = crate::infra::config::Config::new_with_defaults();
        config.providers = vec![crate::infra::config::ProviderConfig {
            id: "p1".into(),
            name: "测试".into(),
            base_url: "http://127.0.0.1:9/v1".into(),
            api_key: "k".into(),
            models: vec!["m".into()],
            model: None,
        }];
        config.active_provider_id = Some("p1".into());
        config.active_model = Some("m".into());
        app.config.save(&config).unwrap();

        // 发送：用户条立即落库返回（SEQ-001），生成任务交 spawner（测试 no-op 不驱动）。
        let user = send_message_impl(&app, noop_sink(), &noop_spawner(), session.id, "你好".into())
            .unwrap();
        assert_eq!(user.role, MessageRole::User);
        assert!(user.character_id.is_none(), "用户消息 speaker 为 null");
        assert_eq!(app.storage.list_messages(session.id).unwrap().len(), 1);
        // FR-007：标题缺省取首条用户消息截断。
        assert_eq!(app.storage.get_session(session.id).unwrap().title, "你好");

        // 注册表已占用：同会话重复发送 / 重新生成被拒（FR-007 / FR-008）。
        assert!(matches!(
            send_message_impl(&app, noop_sink(), &noop_spawner(), session.id, "第二条".into()),
            Err(IpcError::Conflict { .. })
        ));
        assert!(matches!(
            regenerate_last_impl(&app, noop_sink(), &noop_spawner(), session.id),
            Err(IpcError::Conflict { .. })
        ));
        // 取消活跃生成：返回 true；随后无活跃生成时取消为幂等 no-op（false）。
        assert!(cancel_generation_impl(&app, session.id).unwrap());
        assert!(!cancel_generation_impl(&app, session.id).unwrap());

        // 边界校验：空内容 Conflict、不存在会话 NotFound、无 assistant 条不可重新生成。
        assert!(matches!(
            send_message_impl(&app, noop_sink(), &noop_spawner(), session.id, "   ".into()),
            Err(IpcError::Conflict { .. })
        ));
        assert!(matches!(
            send_message_impl(&app, noop_sink(), &noop_spawner(), 999_999, "你好".into()),
            Err(IpcError::NotFound { .. })
        ));
        assert!(matches!(
            regenerate_last_impl(&app, noop_sink(), &noop_spawner(), 999_999),
            Err(IpcError::NotFound { .. })
        ));
        assert!(matches!(
            regenerate_last_impl(&app, noop_sink(), &noop_spawner(), session.id),
            Err(IpcError::Conflict { .. })
        ));

        // 有 assistant 条后重新生成：返回旧条（前端据以从界面移除），注册表占用；
        // speaker = 实例真值（消息自带 instance_id，机械适配）。
        app.storage
            .insert_message(&NewMessage {
                instance_id: Some(1),
                ..NewMessage::new(session.id, models::MessageRole::Assistant, "旧回复")
            })
            .unwrap();
        let old = regenerate_last_impl(&app, noop_sink(), &noop_spawner(), session.id).unwrap();
        assert_eq!(old.role, MessageRole::Assistant);
        assert_eq!(old.content, "旧回复");
        assert_eq!(old.character_id, Some(1), "speaker = 说话人实例 id");
        assert!(cancel_generation_impl(&app, session.id).unwrap());
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn character_summary_serializes_camel_case_with_persona_and_model_config() {
        // TASK-008：摘要扩 persona / model_config（编辑预填），wire 保持 camelCase。
        // FR-014：calendarConfig 随摘要透传（开局向导「跟随角色卡」显示历法名）。
        let summary = CharacterSummary {
            id: 5,
            name: "苏鸢".into(),
            avatar: None,
            persona: "雨夜电话亭的守夜人".into(),
            gender: None,
            age: None,
            render_style: "typewriter".into(),
            model_config: Some(r#"{"providerId":"p1","model":"m1"}"#.into()),
            accent_color: Some("#5e2347".into()),
            calendar_config: Some(r#"{"name":"旧都历","days_per_month":30}"#.into()),
            updated_at: 42,
            session_count: 2,
        };
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["persona"], "雨夜电话亭的守夜人");
        assert_eq!(json["modelConfig"], r#"{"providerId":"p1","model":"m1"}"#);
        assert_eq!(json["accentColor"], "#5e2347", "强调色 camelCase wire");
        assert_eq!(json["calendarConfig"], r#"{"name":"旧都历","days_per_month":30}"#,
            "日历 JSON 原样透传（存储 snake_case 由 Rust 产出）");
        assert!(json["avatar"].is_null(), "avatar 可空透传");
        // model_config = None（跟随全局）时 wire 为 null。
        let follower = CharacterSummary { model_config: None, ..summary };
        assert!(serde_json::to_value(&follower).unwrap()["modelConfig"].is_null());
    }

    #[test]
    fn character_crud_with_avatar_and_session_count() {
        let (app, dir) = temp_state("characters");

        let input = CharacterInput {
            name: "苏鸢".into(),
            avatar: Some("data:image/png;base64,AAA".into()),
            persona: "雨夜电话亭的守夜人".into(),
            gender: Some("女".into()),
            age: Some("24".into()),
            render_style: "typewriter".into(),
            model_config: Some(r#"{"providerId":"p1","model":"m1"}"#.into()),
            accent_color: None,
            voice_config: None,
        };
        let created = create_character_impl(&app, input.clone()).unwrap();
        assert_eq!(created.avatar.as_deref(), Some("data:image/png;base64,AAA"));
        assert_eq!(created.session_count, 0);
        // 扩字段（TASK-008）随创建回执 / 列表原样返回，编辑表单据此预填。
        assert_eq!(created.persona, "雨夜电话亭的守夜人");
        assert_eq!(
            created.model_config.as_deref(),
            Some(r#"{"providerId":"p1","model":"m1"}"#)
        );

        // 会话计数汇总（关系侧；多角色换挂后经实例溯源统计——created 卡作两个
        // 会话的 LLM 位，各实例化一次）。
        let user_card = sample_character(&app, "旅人");
        let roster = |llm: i64| {
            vec![
                RosterPick { character_id: user_card.id, is_user: true },
                RosterPick { character_id: llm, is_user: false },
            ]
        };
        app.storage
            .create_session(&NewSession {
                roster: roster(created.id),
                title: String::new(),
                opening: None,
            })
            .unwrap();
        app.storage
            .create_session(&NewSession {
                roster: roster(created.id),
                title: String::new(),
                opening: None,
            })
            .unwrap();
        let other = create_character_impl(
            &app,
            CharacterInput { name: "林深".into(), ..input.clone() },
        )
        .unwrap();
        let listed = list_characters_impl(&app).unwrap();
        let suy = listed.iter().find(|c| c.id == created.id).unwrap();
        assert_eq!(suy.session_count, 2);
        assert_eq!(suy.persona, "雨夜电话亭的守夜人");
        assert_eq!(suy.model_config.as_deref(), Some(r#"{"providerId":"p1","model":"m1"}"#));
        let lin = listed.iter().find(|c| c.id == other.id).unwrap();
        assert_eq!(lin.session_count, 0);

        // 整卡覆盖更新（含清除 avatar；model_config 置回 None = 跟随全局）。
        update_character_impl(
            &app,
            created.id,
            UpdateCharacterInput {
                avatar: None,
                model_config: None,
                ..upd_input("苏鸢（改）", &input)
            },
        )
        .unwrap();
        let after = list_characters_impl(&app).unwrap();
        let updated = after.iter().find(|c| c.id == created.id).unwrap();
        assert_eq!(updated.name, "苏鸢（改）");
        assert!(updated.avatar.is_none(), "avatar 传 None 即清除");
        assert!(updated.model_config.is_none(), "model_config 传 None 即跟随全局");
        assert_eq!(updated.persona, "雨夜电话亭的守夜人");

        // 软删 + NotFound 语义。
        delete_character_impl(&app, other.id).unwrap();
        let listed = list_characters_impl(&app).unwrap();
        assert!(listed.iter().all(|c| c.id != other.id));
        assert!(matches!(
            update_character_impl(&app, other.id, upd_input("苏鸢", &input)),
            Err(IpcError::NotFound { .. })
        ));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 历法样例 DTO（含节日，覆盖月换算 / 日名取模 / 时段缀 / 节日命中全部分支）。
    fn sample_calendar_dto() -> CalendarConfigDto {
        CalendarConfigDto {
            name: Some("星槎历".into()),
            months: vec!["潮生月".into(), "风信月".into()],
            days_per_month: 12,
            day_names: vec!["潮日".into(), "汐日".into(), "星日".into()],
            festivals: Some(std::collections::BTreeMap::from([(2, "归潮祭".to_string())])),
        }
    }

    #[test]
    fn update_character_persists_calendar_and_feeds_date_label() {
        let (app, dir) = temp_state("char_calendar");
        let created = create_character_impl(
            &app,
            CharacterInput {
                name: "苏鸢".into(),
                ..sample_bare_input()
            },
        )
        .unwrap();
        // 建卡后历法为空（FR-014 向导建卡不带历法，回写走 create_session 链路）。
        assert_eq!(app.storage.get_character(created.id).unwrap().calendar_config, None);

        // 编辑器整卡提交携带历法（Task-17 契约）→ 落库 + 读回一致（含 festivals 往返）。
        let mut input = upd_input("苏鸢", &sample_bare_input());
        input.calendar_config = Some(sample_calendar_dto());
        update_character_impl(&app, created.id, input).unwrap();

        let stored = app.storage.get_character(created.id).unwrap();
        let raw = stored.calendar_config.clone().expect("历法必须落库");
        let cal = fiction_time::parse(Some(raw.as_str()));
        assert_eq!(cal.name.as_deref(), Some("星槎历"));
        assert_eq!(cal.months, vec!["潮生月".to_string(), "风信月".to_string()]);
        assert_eq!(cal.days_per_month, 12);
        assert_eq!(cal.festivals.get(&2).map(String::as_str), Some("归潮祭"),
            "festivals 数字键往返（存储 JSON 键为字符串数字）");
        assert!(raw.contains(r#""festivals":{"2":"归潮祭"}"#),
            "存储 JSON 为 domain snake_case 形态：{raw}");

        // 端到端活链路自证：读回的历法能被 date_label 消费出带月名 / 日名 / 节日的 label
        // （day=2 → 月序 0「潮生月」、日名取模「汐日」、命中年内第 2 天节日）。
        assert_eq!(
            fiction_time::date_label(&cal, 2, "黄昏"),
            "潮生月·汐日·黄昏（归潮祭）"
        );
        // 建会话快照（FR-013）拿到同一份历法——编辑器保存对后续会话生效
        //（多角色裁量：快照取用户位卡，故 created 卡置于用户位）。
        let llm_card = sample_character(&app, "阿烬");
        let session = app
            .storage
            .create_session(&NewSession {
                roster: vec![
                    RosterPick { character_id: created.id, is_user: true },
                    RosterPick { character_id: llm_card.id, is_user: false },
                ],
                title: String::new(),
                opening: None,
            })
            .unwrap();
        assert_eq!(session.calendar_config.as_deref(), Some(raw.as_str()));

        // wire 读回端：get 返回的 JSON 与 CalendarConfigDto 反向转换对称（festivals 非空不塌缩）。
        let redto = CalendarConfigDto::from(&cal);
        assert_eq!(redto.festivals.as_ref().map(|f| f.get(&2).map(String::as_str)),
            Some(Some("归潮祭")));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_character_none_or_missing_key_clears_calendar() {
        let (app, dir) = temp_state("char_calendar_clear");
        let created = create_character_impl(
            &app,
            CharacterInput { name: "苏鸢".into(), ..sample_bare_input() },
        )
        .unwrap();
        let mut with_cal = upd_input("苏鸢", &sample_bare_input());
        with_cal.calendar_config = Some(sample_calendar_dto());
        update_character_impl(&app, created.id, with_cal).unwrap();
        assert!(app.storage.get_character(created.id).unwrap().calendar_config.is_some());

        // calendarConfig: null → 清除（整卡覆盖语义，回退内置默认历）。
        let clear = upd_input("苏鸢", &sample_bare_input());
        assert!(clear.calendar_config.is_none());
        update_character_impl(&app, created.id, clear).unwrap();
        assert_eq!(app.storage.get_character(created.id).unwrap().calendar_config, None);

        // wire 缺键同语义：反序列化得 None（serde Option 缺省），更新后同样清除。
        let missing_key: UpdateCharacterInput = serde_json::from_value(serde_json::json!({
            "name": "苏鸢", "avatar": null, "persona": "守夜人", "gender": null,
            "age": null, "renderStyle": "typewriter", "modelConfig": null,
            "accentColor": null, "voiceConfig": null
        }))
        .unwrap();
        assert!(missing_key.calendar_config.is_none(), "wire 缺 calendarConfig 键 = None = 清除");
        update_character_impl(&app, created.id, missing_key).unwrap();
        assert_eq!(app.storage.get_character(created.id).unwrap().calendar_config, None);
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_character_rejects_invalid_calendar() {
        let (app, dir) = temp_state("char_calendar_invalid");
        let created = create_character_impl(
            &app,
            CharacterInput { name: "苏鸢".into(), ..sample_bare_input() },
        )
        .unwrap();
        let mut bad = upd_input("苏鸢", &sample_bare_input());
        bad.calendar_config = Some(CalendarConfigDto {
            days_per_month: 0, // 非法：每月天数须 > 0
            ..sample_calendar_dto()
        });
        let before = app.storage.get_character(created.id).unwrap().calendar_config.clone();
        assert!(matches!(
            update_character_impl(&app, created.id, bad),
            Err(IpcError::Conflict { .. })
        ));
        // 校验失败不得半写：历法保持原值。
        assert_eq!(app.storage.get_character(created.id).unwrap().calendar_config, before);
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 全空槽位的 create 负载（可空字段恒 None，历法不入 create 入参）。
    fn sample_bare_input() -> CharacterInput {
        CharacterInput {
            name: String::new(),
            avatar: None,
            persona: String::new(),
            gender: None,
            age: None,
            render_style: "typewriter".into(),
            model_config: None,
            accent_color: None,
            voice_config: None,
        }
    }

    #[test]
    fn update_character_input_serializes_camel_case() {
        let mut input = upd_input("苏鸢", &sample_bare_input());
        input.avatar = Some("data:image/png;base64,AAA".into());
        input.calendar_config = Some(sample_calendar_dto());
        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(json["name"], "苏鸢");
        assert_eq!(json["renderStyle"], "typewriter", "wire camelCase");
        assert_eq!(json["calendarConfig"]["name"], "星槎历");
        assert_eq!(json["calendarConfig"]["daysPerMonth"], 12);
        assert_eq!(json["calendarConfig"]["festivals"]["2"], "归潮祭",
            "节日表 wire 形态：数字字符串键");
        assert_eq!(json["calendarConfig"]["dayNames"][0], "潮日");

        // 全键反序列化往返；DTO ↔ domain 往返无损（前端保存的领域校验地基）。
        let back: UpdateCharacterInput = serde_json::from_value(json).unwrap();
        assert_eq!(back, input);
        assert!(fiction_time::validate(&fiction_time::CalendarConfig::from(
            back.calendar_config.as_ref().unwrap()
        )));
    }

    #[test]
    fn config_commands_load_save_and_validate() {
        let (app, dir) = temp_state("config");

        let defaults = get_config_impl(&app).unwrap();
        assert_eq!(defaults.rhythm_ms_per_char, 45, "无文件 → 全默认（FR-009）");

        let mut next = defaults.clone();
        next.ui_theme = "dark".into();
        next.rhythm_ms_per_char = 120;
        save_config_impl(&app, next).unwrap();
        assert_eq!(get_config_impl(&app).unwrap().ui_theme, "dark");
        assert_eq!(get_config_impl(&app).unwrap().rhythm_ms_per_char, 120);

        // 越界值被 infra 校验拒绝（FR-009：10–160），以可序列化 Config 错误返回。
        let bad = ConfigDto {
            rhythm_ms_per_char: 999,
            ..get_config_impl(&app).unwrap()
        };
        assert!(matches!(save_config_impl(&app, bad), Err(IpcError::Config { .. })));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 角色卡导出/导入（Task-04；对话框段不经 Tauri 运行时，测数据段）----

    #[test]
    fn export_character_data_yields_default_name_and_card_json() {
        let (app, dir) = temp_state("export");
        let created = create_character_impl(
            &app,
            CharacterInput {
                name: "苏鸢".into(),
                avatar: None,
                persona: "雨夜电话亭的守夜人".into(),
                gender: Some("女".into()),
                age: None,
                render_style: "typewriter".into(),
                model_config: None,
                accent_color: None,
                voice_config: None,
            },
        )
        .unwrap();

        let (file_name, json) = export_character_data(&app, created.id).unwrap();
        assert_eq!(file_name, "苏鸢.json", "默认文件名 = <角色名>.json");
        let value: serde_json::Value = serde_json::from_str(&json).expect("导出段是合法 JSON 文本");
        assert_eq!(value["format"], "chronoveil-character");
        assert_eq!(value["version"], 1);
        assert_eq!(value["character"]["name"], "苏鸢");

        // 目标不存在 / 已软删 → NotFound。
        assert!(matches!(
            export_character_data(&app, 999_999),
            Err(IpcError::NotFound { .. })
        ));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_character_creates_new_card_through_create_path() {
        let (app, dir) = temp_state("import");
        let text = r#"{
          "format": "chronoveil-character",
          "version": 1,
          "character": {
            "name": "苏鸢", "avatar": null, "persona": "雨夜电话亭的守夜人",
            "gender": "女", "age": "24", "renderStyle": "typewriter",
            "modelConfig": null, "accentColor": null, "voiceConfig": null
          }
        }"#;
        let imported = import_character_data(&app, text).unwrap();
        assert_eq!(imported.name, "苏鸢");
        assert_eq!(imported.persona, "雨夜电话亭的守夜人");
        assert_eq!(imported.render_style, "typewriter");
        assert_eq!(imported.session_count, 0);

        // 走 create 既有路径：新 id、允许重名（不与既有卡合并）。
        let again = import_character_data(&app, text).unwrap();
        assert_ne!(imported.id, again.id);
        let listed = list_characters_impl(&app).unwrap();
        assert_eq!(listed.len(), 2);

        // 校验失败 → Conflict（携带服务层的人类可读信息），且不落库。
        for bad in [
            r#"{"format":"other","version":1,"character":{"name":"x"}}"#,
            r#"{"format":"chronoveil-character","version":2,"character":{"name":"x"}}"#,
            r#"{"format":"chronoveil-character","version":1,"character":{"name":"  "}}"#,
            "{ not json",
        ] {
            match import_character_data(&app, bad) {
                Err(IpcError::Conflict { message }) => assert!(!message.is_empty()),
                other => panic!("坏卡文件应报 Conflict，实际 {other:?}"),
            }
        }
        assert_eq!(list_characters_impl(&app).unwrap().len(), 2, "校验失败零落库");
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_import_roundtrip_preserves_card_fields() {
        let (app, dir) = temp_state("roundtrip");
        let created = create_character_impl(
            &app,
            CharacterInput {
                name: "林深".into(),
                avatar: Some("data:image/png;base64,AAA".into()),
                persona: "旧书店老板".into(),
                gender: None,
                age: Some("31".into()),
                render_style: "ink".into(),
                model_config: Some(r#"{"providerId":"p1","model":"m1"}"#.into()),
                accent_color: Some("#123456".into()),
                voice_config: None,
            },
        )
        .unwrap();

        let (_, json) = export_character_data(&app, created.id).unwrap();
        let imported = import_character_data(&app, &json).unwrap();
        // 卡内九字段逐一保真；id / updated_at / session_count 属新卡事实，不保真。
        assert_eq!(imported.name, "林深");
        assert_eq!(imported.avatar.as_deref(), Some("data:image/png;base64,AAA"));
        assert_eq!(imported.persona, "旧书店老板");
        assert_eq!(imported.age.as_deref(), Some("31"));
        assert_eq!(imported.render_style, "ink");
        assert_eq!(imported.model_config.as_deref(), Some(r#"{"providerId":"p1","model":"m1"}"#));
        assert_eq!(imported.accent_color.as_deref(), Some("#123456"));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- bindings 生成（类型同源，ADR-010）----

    #[test]
    fn export_ts_bindings() {
        // cargo test 时再生成 src/api/generated/bindings.ts：与 Rust 命令/事件面同步，
        // 漂移会在 git diff 中暴露。前端构建只消费该文件，不运行 Rust。
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/api/generated/bindings.ts");
        builder()
            .export(
                specta_typescript::Typescript::new()
                    .bigint(specta_typescript::BigIntExportBehavior::Number)
                    .header("// @ts-nocheck\n"),
                &out,
            )
            .expect("导出 TS bindings 失败");
        let content = std::fs::read_to_string(&out).unwrap();
        for cmd in [
            "listSessions", "createSession", "deleteSession", "draftCalendar", "listMessages",
            "listScenes", "listCharacterStates",
            "sendMessage", "cancelGeneration", "regenerateLast",
            "listCharacters", "createCharacter", "updateCharacter", "deleteCharacter",
            "exportCharacter", "importCharacter",
            "getConfig", "saveConfig",
        ] {
            assert!(content.contains(cmd), "bindings 缺少命令 {cmd}");
        }
        assert!(content.contains("streamEvent"), "bindings 缺少 stream-event 事件");
        // INT-001 负载字段在生成的类型里逐一可见。
        for field in ["session_id", "message_id", "think_ms", "interrupted", "reset"] {
            assert!(content.contains(field), "bindings 缺少事件负载字段 {field}");
        }
    }
}
