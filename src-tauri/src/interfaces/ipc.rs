//! Tauri 命令层（ADR-010 interfaces 层；TASK-005）。
//!
//! 命令面（验收 4）：会话列表/创建/软删、消息列表、发送消息、取消生成、重新生成最后一条、
//! 角色 CRUD（含 avatar）、config.json 读取/保存。
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

use crate::domain::models;
use crate::domain::ports::StoragePort;
use crate::infra::config::Config as FileConfig;
use crate::infra::config::ProviderConfig as FileProvider;
use crate::infra::llm::{EventSink, LlmClient};
use crate::services::generation::{self, GenerationDeps, PendingGeneration};
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

/// 会话摘要（FR-007：列表按 updated_at 倒序）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: i64,
    pub character_id: i64,
    pub title: String,
    pub updated_at: i64,
}

impl From<models::Session> for SessionSummary {
    fn from(s: models::Session) -> Self {
        Self {
            id: s.id,
            character_id: s.character_id,
            title: s.title,
            updated_at: s.updated_at,
        }
    }
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
    /// 出场动画风格（18 种之一，FR-005）。
    pub render_style: String,
    /// 开场白 markdown-lite。
    pub greeting: String,
    /// 每角色模型覆写 JSON（camelCase 键，`resolve_effective_llm` 消费）；
    /// None = 跟随全局默认。
    pub model_config: Option<String>,
    /// 强调色 #RRGGBB，可空；None = 跟随海报派生色（前端 accentColorOf）。
    pub accent_color: Option<String>,
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
        render_style: c.render_style,
        greeting: c.greeting,
        model_config: c.model_config,
        accent_color: c.accent_color,
        updated_at: c.updated_at,
        session_count: 0,
    }
}

/// 聊天消息（前端 ChatMessage；characterId 由命令层派生：
/// assistant → 所属会话的角色，user → null——messages 表不冗余存说话人）。
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

/// 新建 / 更新角色卡入参（FR-006；整卡覆盖语义见 UpdateCharacter）。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CharacterInput {
    pub name: String,
    /// None = 不带头像 / 更新时清除头像。
    pub avatar: Option<String>,
    pub persona: String,
    pub greeting: String,
    pub render_style: String,
    pub model_config: Option<String>,
    /// 强调色 #RRGGBB，可空；None = 跟随海报派生色。
    pub accent_color: Option<String>,
    /// TTS 预留缝（CON-003），前端恒传 null。
    pub voice_config: Option<String>,
}

/// 单套 LLM Provider（FR-009；OpenAI 兼容）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDto {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// 应用配置（FR-009 / ADR-012；wire 形态 camelCase，落盘文件仍为 infra 的 snake_case 键）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDto {
    pub providers: Vec<ProviderDto>,
    /// 全局默认模型指向的 provider id；null = 未选择。
    pub active_provider_id: Option<String>,
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
                    model: p.model.clone(),
                })
                .collect(),
            active_provider_id: c.active_provider_id.clone(),
            rhythm_ms_per_char: c.rhythm_ms_per_char,
            punct_pause_enabled: c.punct_pause_enabled,
            anim_duration_base: c.anim_duration_base,
            ui_language: c.ui_language.clone(),
            ui_theme: c.ui_theme.clone(),
            director_model: c.director_model.clone(),
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
                    model: p.model,
                })
                .collect(),
            active_provider_id: d.active_provider_id,
            rhythm_ms_per_char: d.rhythm_ms_per_char,
            punct_pause_enabled: d.punct_pause_enabled,
            anim_duration_base: d.anim_duration_base,
            ui_language: d.ui_language,
            ui_theme: d.ui_theme,
            director_model: d.director_model,
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
            list_messages,
            send_message,
            cancel_generation,
            regenerate_last,
            list_characters,
            create_character,
            update_character,
            delete_character,
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

// ---- 会话（FR-007）----

fn list_sessions_impl(app: &AppState) -> Result<Vec<SessionSummary>, IpcError> {
    Ok(app
        .storage
        .list_sessions()?
        .into_iter()
        .map(SessionSummary::from)
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionSummary>, IpcError> {
    list_sessions_impl(&state)
}

fn create_session_impl(
    app: &AppState,
    character_id: i64,
    title: Option<String>,
) -> Result<SessionSummary, IpcError> {
    // 先显式查角色：比外键冲突给出更精确的 NotFound（ADR-009 语义）。
    app.storage.get_character(character_id)?;
    let session = app.storage.create_session(&models::NewSession {
        character_id,
        title: title.unwrap_or_default(),
    })?;
    Ok(SessionSummary::from(session))
}

#[tauri::command]
#[specta::specta]
pub fn create_session(
    state: State<'_, AppState>,
    character_id: i64,
    title: Option<String>,
) -> Result<SessionSummary, IpcError> {
    create_session_impl(&state, character_id, title)
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
    let session = app.storage.get_session(session_id)?;
    let character_id = session.character_id;
    Ok(app
        .storage
        .list_messages(session_id)?
        .into_iter()
        .map(|m| {
            let speaker = match m.role {
                models::MessageRole::Assistant => Some(character_id),
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

// ---- 生成（TASK-006 闭环接线：FR-001 / FR-007 / FR-008 / SEQ-001）----

/// 命令层生成任务驱动：交给 Tauri 异步运行时（fire-and-forget；终态经事件通道回传）。
fn tauri_spawner() -> GenerationSpawner {
    Arc::new(|pending: PendingGeneration| {
        tauri::async_runtime::spawn(pending.run());
    })
}

fn generation_deps(app: &AppState, sink: Arc<dyn EventSink>, llm: LlmClient) -> GenerationDeps {
    GenerationDeps { storage: app.storage.clone(), sink, llm: Arc::new(llm) }
}

/// 两级模型配置解析（INT-002 / 验收 4）：config.json 全局默认 ← Character.model_config 覆写。
fn resolve_llm(app: &AppState, session: &models::Session) -> Result<LlmClient, IpcError> {
    let character = app.storage.get_character(session.character_id)?;
    let config = app.config.load()?;
    let llm_config = generation::resolve_effective_llm(&config, &character)
        .map_err(|message| IpcError::Config { message })?;
    LlmClient::new(llm_config).map_err(|e| IpcError::Config { message: e.to_string() })
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
    let llm = resolve_llm(app, &session)?;
    // 同会话互斥（FR-007 多路并发为跨会话并发；同会话重复触发拒绝，FR-008）。
    let ticket = app
        .generation
        .begin(session_id)
        .map_err(|_| IpcError::Conflict { message: "该会话已有进行中的生成".into() })?;
    // 用户条先落库（FR-001 / SEQ-001：RS->RS 落库用户消息）。
    let user_message = match app.storage.insert_message(&models::NewMessage::new(
        session_id,
        models::MessageRole::User,
        trimmed.clone(),
    )) {
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
    let llm = resolve_llm(app, &session)?;
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
    // 返回被替换的旧条：前端据此将其从界面移除（旧条软删发生在终态落库时，FR-008）。
    Ok(to_chat_message(old, Some(session.character_id)))
}

#[tauri::command]
#[specta::specta]
pub fn regenerate_last(state: State<'_, AppState>, session_id: i64) -> Result<ChatMessage, IpcError> {
    regenerate_last_impl(&state, state.sink(), &tauri_spawner(), session_id)
}

// ---- 角色 CRUD（FR-006，含 avatar）----

fn list_characters_impl(app: &AppState) -> Result<Vec<CharacterSummary>, IpcError> {
    let sessions = app.storage.list_sessions()?;
    let mut counts: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    for s in sessions {
        *counts.entry(s.character_id).or_insert(0) += 1;
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
        greeting: input.greeting,
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
    input: CharacterInput,
) -> Result<(), IpcError> {
    // 整卡覆盖（FR-006：编辑表单全量提交）；目标不存在 / 已软删报 NotFound。
    app.storage.update_character(
        id,
        &models::UpdateCharacter {
            name: input.name,
            avatar: input.avatar,
            persona: input.persona,
            greeting: input.greeting,
            render_style: input.render_style,
            model_config: input.model_config,
            accent_color: input.accent_color,
            voice_config: input.voice_config,
        },
    )?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn update_character(
    state: State<'_, AppState>,
    id: i64,
    input: CharacterInput,
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
    use crate::domain::models::{NewCharacter, NewMessage, NewSession};
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
        let json = serde_json::to_value(SessionSummary {
            id: 3,
            character_id: 7,
            title: "雨夜来电".into(),
            updated_at: 1234,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "id": 3, "characterId": 7, "title": "雨夜来电", "updatedAt": 1234 })
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
                deleted_at: None,
            },
            None,
        );
        let json = serde_json::to_value(&msg).unwrap();
        assert!(json["characterId"].is_null(), "用户消息 characterId 必须为 null");
        assert_eq!(json["interrupted"], false);
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
                model: "m1".into(),
            }],
            active_provider_id: Some("p1".into()),
            rhythm_ms_per_char: 90,
            punct_pause_enabled: false,
            anim_duration_base: 300,
            ui_language: "zh".into(),
            ui_theme: "dark".into(),
            director_model: None,
        };
        let wire = serde_json::to_value(&dto).unwrap();
        assert_eq!(wire["activeProviderId"], "p1", "wire camelCase");
        assert_eq!(wire["providers"][0]["baseUrl"], "https://example.invalid/v1");
        assert_eq!(wire["rhythmMsPerChar"], 90);

        let file: FileConfig = dto.clone().into();
        let back: ConfigDto = (&file).into();
        assert_eq!(dto, back, "DTO ↔ 落盘结构往返无损");
        assert_eq!(file.rhythm_ms_per_char, 90);
    }

    // ---- 命令实现（不经 Tauri 运行时，直接走 AppState）----

    #[test]
    fn session_commands_cover_list_create_softdelete() {
        let (app, dir) = temp_state("sessions");
        let character = sample_character(&app, "苏鸢");

        let created = create_session_impl(&app, character.id, None).unwrap();
        assert_eq!(created.title, "", "缺省标题为空串（首条用户消息后回填属 TASK-006）");
        assert_eq!(created.character_id, character.id);

        create_session_impl(&app, character.id, Some("旧书店".into())).unwrap();
        let listed = list_sessions_impl(&app).unwrap();
        assert_eq!(listed.len(), 2);

        delete_session_impl(&app, created.id).unwrap();
        assert!(list_sessions_impl(&app).unwrap().len() == 1, "软删后列表不再可见");
        // 重复删除同一目标：已软删等价不可见 → NotFound。
        assert!(matches!(
            delete_session_impl(&app, created.id),
            Err(IpcError::NotFound { .. })
        ));
        // 指向不存在角色 → NotFound（而非裸外键冲突）。
        assert!(matches!(
            create_session_impl(&app, 999_999, None),
            Err(IpcError::NotFound { .. })
        ));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn message_commands_derive_character_and_reject_missing_session() {
        let (app, dir) = temp_state("messages");
        let character = sample_character(&app, "林深");
        let session = app
            .storage
            .create_session(&NewSession { character_id: character.id, title: String::new() })
            .unwrap();
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
            })
            .unwrap();

        let listed = list_messages_impl(&app, session.id).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed[0].character_id.is_none(), "用户消息 speaker 为 null");
        assert_eq!(listed[1].character_id, Some(character.id), "assistant 派生为会话角色");
        assert_eq!(listed[1].think_ms, Some(1200));

        assert!(matches!(
            list_messages_impl(&app, 12345),
            Err(IpcError::NotFound { .. })
        ));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generation_commands_wire_send_cancel_and_regenerate() {
        let (app, dir) = temp_state("generation");
        let character = sample_character(&app, "苏鸢");
        let session = app
            .storage
            .create_session(&NewSession { character_id: character.id, title: String::new() })
            .unwrap();

        // Provider 未配置 → 类型化 Config 错误；用户条与注册表零副作用。
        let err = send_message_impl(&app, noop_sink(), &noop_spawner(), session.id, "你好".into())
            .unwrap_err();
        assert!(matches!(err, IpcError::Config { .. }));
        assert!(app.storage.list_messages(session.id).unwrap().is_empty());

        // 配置全局默认 Provider（两级配置的底层，FR-009）。
        let mut config = crate::infra::config::Config::new_with_defaults();
        config.providers = vec![crate::infra::config::ProviderConfig {
            id: "p1".into(),
            name: "测试".into(),
            base_url: "http://127.0.0.1:9/v1".into(),
            api_key: "k".into(),
            model: "m".into(),
        }];
        config.active_provider_id = Some("p1".into());
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

        // 有 assistant 条后重新生成：返回旧条（前端据以从界面移除），注册表占用。
        app.storage
            .insert_message(&NewMessage::new(session.id, models::MessageRole::Assistant, "旧回复"))
            .unwrap();
        let old = regenerate_last_impl(&app, noop_sink(), &noop_spawner(), session.id).unwrap();
        assert_eq!(old.role, MessageRole::Assistant);
        assert_eq!(old.content, "旧回复");
        assert_eq!(old.character_id, Some(character.id));
        assert!(cancel_generation_impl(&app, session.id).unwrap());
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn character_summary_serializes_camel_case_with_persona_and_model_config() {
        // TASK-008：摘要扩 persona / model_config（编辑预填），wire 保持 camelCase。
        let summary = CharacterSummary {
            id: 5,
            name: "苏鸢".into(),
            avatar: None,
            persona: "雨夜电话亭的守夜人".into(),
            render_style: "typewriter".into(),
            greeting: "雨点敲着窗棂。".into(),
            model_config: Some(r#"{"providerId":"p1","model":"m1"}"#.into()),
            accent_color: Some("#5e2347".into()),
            updated_at: 42,
            session_count: 2,
        };
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["persona"], "雨夜电话亭的守夜人");
        assert_eq!(json["modelConfig"], r#"{"providerId":"p1","model":"m1"}"#);
        assert_eq!(json["accentColor"], "#5e2347", "强调色 camelCase wire");
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
            greeting: "雨点敲着窗棂。".into(),
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

        // 会话计数汇总（关系侧）。
        app.storage
            .create_session(&NewSession { character_id: created.id, title: String::new() })
            .unwrap();
        app.storage
            .create_session(&NewSession { character_id: created.id, title: String::new() })
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
            CharacterInput {
                avatar: None,
                name: "苏鸢（改）".into(),
                model_config: None,
                ..input.clone()
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
            update_character_impl(&app, other.id, input),
            Err(IpcError::NotFound { .. })
        ));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
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
            "listSessions", "createSession", "deleteSession", "listMessages",
            "sendMessage", "cancelGeneration", "regenerateLast",
            "listCharacters", "createCharacter", "updateCharacter", "deleteCharacter",
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
