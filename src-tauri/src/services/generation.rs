//! 生成闭环编排（CMP-002 编排半 / TASK-006 / FR-001 / FR-007 / FR-008 / SEQ-001）。
//!
//! 职责：prompt 装配（[`super::prompt`]）→ LLM 流式（infra::llm 网关）→ 事件发射 →
//! **终态落库**（ADR-001：done / error / cancel 都写库，半条带中断标记）；取消（瞬时）；
//! 重新生成与断流重试共用的「整条替换」（FR-008：软删旧条 + 新条从零演出）。
//! 不负责：渲染决策（前端渲染引擎）、Tauri 通道（经 `EventSink` 抽象注入，禁 tauri，ADR-010）。
//!
//! 时序保证（SEQ-001 / INT-001）：终态事件（done / error）在落库**之后**才放行到前端
//! ——前端收到终态即重拉消息列表，必须已能看到落库行。实现为 [`GenerationSink`] 的
//! 「终态闸门」：网关发出的终态事件先扣住，落库完成后统一放行。
//!
//! 取消语义（SEQ-001 失败分支）：取消不由网关发事件（TASK-002 内定），编排方在取消
//! 终态落库后补发一次 `error`（reason=[`CANCEL_REASON`]，interrupted 视半条有无），
//! 前端据此收尾重拉。
//!
//! message_id 约定：assistant 消息按 ADR-001 只在终态落库，生成期间无库中主键——
//! 事件路由使用**临时负数 id**（[`GenerationRegistry`] 递减分配，不与自增主键冲突），
//! 前端以它归属流式气泡；终态后以重拉列表替换为真实行。
//!
//! 多路并发（FR-007 / ADR-007）：注册表按 session_id 互斥——同会话同时只允许一路生成
//! （重复触发返回冲突），跨会话并发互不干扰；切走不取消（取消只能显式经命令触发）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Deserialize;

use crate::domain::chat::TerminalState;
use crate::domain::error::StorageError;
use crate::domain::models::{Character, MessageRole, NewMessage};
use crate::domain::ports::StoragePort;
use crate::infra::config::{Config as FileConfig, ProviderConfig};
use crate::infra::llm::{
    cancel_channel, CancelHandle, CancelSignal, EventSink, LlmClient, LlmConfig, LlmEvent,
    MessageIds, StreamOutcome,
};

/// 取消终态经 error 事件上报时的 reason 稳定取值（前端据此区分「用户取消」与真失败）。
pub const CANCEL_REASON: &str = "cancelled";

/// 会话标题缺省截断长度（FR-007：标题取首条用户消息截断；长度设计未定 → 取 20 字 + 省略号）。
pub const TITLE_MAX_CHARS: usize = 20;

/// 会话标题缺省值（FR-007）：首条用户消息截断；截断时补省略号。
pub fn default_title(content: &str) -> String {
    let trimmed = content.trim();
    let mut out: String = trimmed.chars().take(TITLE_MAX_CHARS).collect();
    if trimmed.chars().count() > TITLE_MAX_CHARS {
        out.push('…');
    }
    out
}

// ---------------------------------------------------------------------------
// 生成注册表：同会话互斥 + 取消信号 + 临时 message_id 分配（FR-007 / ADR-007）
// ---------------------------------------------------------------------------

/// 同会话已有进行中的生成（重复发送 / 重复重新生成被拒，FR-008「生成期间按钮不可重复触发」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionBusy(pub i64);

impl std::fmt::Display for SessionBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "会话 #{} 已有进行中的生成", self.0)
    }
}

impl std::error::Error for SessionBusy {}

/// 一次生成的凭据：临时 message_id + 取消句柄。生成任务持有至终态。
pub struct GenerationTicket {
    pub session_id: i64,
    /// 临时负数 id（事件路由键；终态落库后由前端重拉真实行替代）。
    pub message_id: i64,
    cancel_handle: CancelHandle,
}

impl GenerationTicket {
    pub fn cancel_handle(&self) -> &CancelHandle {
        &self.cancel_handle
    }
}

/// 活跃生成注册表：`session_id → 取消信号`。跨会话并发、同会话互斥（ADR-007）。
#[derive(Default)]
pub struct GenerationRegistry {
    active: Mutex<HashMap<i64, CancelSignal>>,
    /// 临时 message_id：从 -1 递减，绝不与 messages 自增主键（正数）冲突。
    next_message_id: AtomicI64,
}

impl GenerationRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记一路生成；同会话已有活跃生成时返回 [`SessionBusy`]。
    pub fn begin(&self, session_id: i64) -> Result<GenerationTicket, SessionBusy> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| SessionBusy(session_id))?; // 锁中毒 = 进程级故障，按占用拒新路
        if active.contains_key(&session_id) {
            return Err(SessionBusy(session_id));
        }
        let (signal, handle) = cancel_channel();
        let message_id = self.next_message_id.fetch_sub(1, Ordering::SeqCst) - 1;
        active.insert(session_id, signal);
        Ok(GenerationTicket { session_id, message_id, cancel_handle: handle })
    }

    /// 取消该会话的进行中生成；返回是否真正取消（无活跃生成 = 幂等 no-op，false）。
    pub fn cancel(&self, session_id: i64) -> bool {
        let signal = self
            .active
            .lock()
            .ok()
            .and_then(|mut active| active.remove(&session_id));
        match signal {
            Some(signal) => {
                signal.cancel();
                true
            }
            None => false,
        }
    }

    /// 终态收尾：摘除登记（done / error / cancel 任一终态后调用）。
    pub fn finish(&self, session_id: i64) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(&session_id);
        }
    }

    pub fn is_active(&self, session_id: i64) -> bool {
        self.active
            .lock()
            .map(|active| active.contains_key(&session_id))
            .unwrap_or(false)
    }
}

// ---------------------------------------------------------------------------
// 两级模型配置（INT-002 / DOM-001 / 验收 4）：全局默认 Provider ← Character.model_config 覆写
// ---------------------------------------------------------------------------

/// Character.model_config 的 JSON 形态（camelCase 键，全部可选；未知键忽略）。
/// `providerId` 切到 config.providers 中的另一套；其余键直接覆写对应字段。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfigOverride {
    provider_id: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
}

/// 解析生效的 LLM 连接配置：全局默认（active_provider_id 指向者）为底，
/// Character.model_config 逐字段覆写（两级配置，INT-002 / 验收 4）。
/// 未配置 Provider、字段为空或 model_config 非法 JSON → 人类可读错误（快速失败）。
pub fn resolve_effective_llm(
    config: &FileConfig,
    character: &Character,
) -> Result<LlmConfig, String> {
    let provider: &ProviderConfig = config
        .active_provider()
        .ok_or_else(|| "未配置全局默认模型：请在设置页选择 Provider".to_string())?;
    let mut base_url = provider.base_url.clone();
    let mut api_key = provider.api_key.clone();
    let mut model = provider.model.clone();

    if let Some(raw) = character.model_config.as_deref() {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let over: ModelConfigOverride = serde_json::from_str(trimmed)
                .map_err(|e| format!("角色 model_config 解析失败：{e}"))?;
            if let Some(id) = over.provider_id.as_deref().filter(|s| !s.trim().is_empty()) {
                let switched = config
                    .providers
                    .iter()
                    .find(|p| p.id == id)
                    .ok_or_else(|| format!("角色 model_config 指向不存在的 provider：{id}"))?;
                base_url = switched.base_url.clone();
                api_key = switched.api_key.clone();
                model = switched.model.clone();
            }
            if let Some(v) = over.base_url {
                base_url = v;
            }
            if let Some(v) = over.api_key {
                api_key = v;
            }
            if let Some(v) = over.model {
                model = v;
            }
        }
    }

    if base_url.trim().is_empty() {
        return Err("LLM base_url 不能为空：请检查 Provider 配置".into());
    }
    if model.trim().is_empty() {
        return Err("LLM model 不能为空：请检查 Provider 配置".into());
    }
    Ok(LlmConfig { base_url, api_key, model, ..LlmConfig::default() })
}

// ---------------------------------------------------------------------------
// 事件计量 + 终态闸门（FR-003 计量 / SEQ-001 终态落库先行、事件放行在后）
// ---------------------------------------------------------------------------

/// 包装网关事件流：
/// - 计量「用户感知思考时长」（FR-003：think_ms 存用户感知等待，不是机器等待）——
///   首条 reasoning 增量 → 首条正文增量（无正文则到取值时刻）；
/// - 终态闸门：done / error 事件扣住不放，编排方落库后 [`GenerationSink::release`] 放行。
struct GenerationSink {
    inner: Arc<dyn EventSink>,
    state: Mutex<SinkState>,
}

#[derive(Default)]
struct SinkState {
    first_reasoning_at: Option<Instant>,
    first_body_at: Option<Instant>,
    held_terminal: Option<LlmEvent>,
    released: bool,
}

impl GenerationSink {
    fn new(inner: Arc<dyn EventSink>) -> Self {
        Self { inner, state: Mutex::new(SinkState::default()) }
    }

    /// 用户感知思考时长（毫秒）；无思考（从未出现 reasoning）→ None。
    fn think_ms(&self) -> Option<i64> {
        let state = self.state.lock().ok()?;
        let start = state.first_reasoning_at?;
        let end = state.first_body_at.unwrap_or_else(Instant::now);
        Some(end.duration_since(start).as_millis().min(i64::MAX as u128) as i64)
    }

    /// 落库完成：放行扣住的终态事件（无则静默，如取消路径）。
    fn release(&self) {
        let held = {
            let mut state = self.state.lock().expect("生成事件状态锁中毒");
            state.released = true;
            state.held_terminal.take()
        };
        if let Some(event) = held {
            self.inner.emit(event);
        }
    }

    /// 以指定事件替换扣住的终态再放行（取消补发 error / 落库失败把 done 换成 error）。
    fn release_with(&self, event: LlmEvent) {
        {
            let mut state = self.state.lock().expect("生成事件状态锁中毒");
            state.released = true;
            state.held_terminal = Some(event);
        }
        self.release();
    }
}

impl EventSink for GenerationSink {
    fn emit(&self, event: LlmEvent) {
        let mut state = self.state.lock().expect("生成事件状态锁中毒");
        match &event {
            LlmEvent::Reasoning { .. } => {
                state.first_reasoning_at.get_or_insert_with(Instant::now);
            }
            LlmEvent::Token { reset, .. } => {
                if *reset {
                    // 重发尝试首事件：正文重新累积，思考终点随之重置
                    state.first_body_at = None;
                } else {
                    state.first_body_at.get_or_insert_with(Instant::now);
                }
            }
            LlmEvent::Done { .. } | LlmEvent::Error { .. } => {
                if !state.released {
                    state.held_terminal = Some(event);
                    return;
                }
            }
        }
        drop(state);
        self.inner.emit(event);
    }
}

// ---------------------------------------------------------------------------
// 编排入口（interfaces 层经 tauri::async_runtime::spawn 驱动；本层不知 tauri）
// ---------------------------------------------------------------------------

/// 一次生成任务的依赖包（组合根装配，ADR-010：services 只见端口抽象）。
pub struct GenerationDeps {
    pub storage: Arc<dyn StoragePort + Send + Sync>,
    pub sink: Arc<dyn EventSink>,
    pub llm: Arc<LlmClient>,
}

/// 已登记、待驱动的一次生成。命令层构造后交给异步运行时 spawn。
pub struct PendingGeneration {
    pub deps: GenerationDeps,
    pub registry: Arc<GenerationRegistry>,
    pub ticket: GenerationTicket,
    /// true = 重新生成 / 断流重试语义：上下文剔除被替换的最后一条 assistant
    /// （OQ-006 / FR-008「以相同上文重新生成」），终态经「整条替换」落库
    /// （软删旧条 + 插新条，落库时序与崩溃安全不变）。
    pub regenerate: bool,
}

impl PendingGeneration {
    pub async fn run(self) {
        run_generation(self).await;
    }
}

async fn run_generation(pending: PendingGeneration) {
    let PendingGeneration { deps, registry, ticket, regenerate } = pending;
    let session_id = ticket.session_id;
    let message_id = ticket.message_id;

    let outcome = generate_once(&deps, &ticket, regenerate).await;
    registry.finish(session_id);
    if let Err(storage_error) = outcome {
        // 上下文读取失败（会话/角色被删等）：以 error 终态告知前端，本次生成作废。
        deps.sink.emit(LlmEvent::Error {
            session_id,
            message_id,
            reason: format!("生成上下文读取失败：{storage_error}"),
            interrupted: false,
        });
    }
}

/// 生成主体：装配 → 流式 → 终态落库。返回 Err 仅表示**落库前置**的读取失败；
/// 流式与落库阶段的失败已就地转为事件 + 落库处理（empty 失败不落库空行，UC-001 只保已到内容）。
async fn generate_once(
    deps: &GenerationDeps,
    ticket: &GenerationTicket,
    regenerate: bool,
) -> Result<(), StorageError> {
    let session_id = ticket.session_id;
    let message_id = ticket.message_id;

    let session = deps.storage.get_session(session_id)?;
    let character = deps.storage.get_character(session.character_id)?;
    let history = deps.storage.list_messages(session_id)?;
    // OQ-006 / FR-008「以相同上文重新发起生成」+ SEQ-001「重发 = 整条重来」：
    // 重新生成（含断流重试的整条替换语义）时，被替换的最后一条 assistant（旧整条
    // 或中断半条）不得进 prompt 上下文——按 id 剔除后再装配，使请求以 user 条结尾，
    // 模型不是对旧答案的续写。旧条本体保留在库中（「成功后替换」落库时序不变，
    // 崩溃安全），只是不参与本次装配。
    let history: Vec<_> = if regenerate {
        let replaced = deps.storage.latest_assistant_message(session_id)?;
        history
            .into_iter()
            .filter(|m| replaced.as_ref().map_or(true, |old| m.id != old.id))
            .collect()
    } else {
        history
    };
    let messages = super::prompt::assemble(&character, &history);

    let sink = Arc::new(GenerationSink::new(deps.sink.clone()));
    let ids = MessageIds { session_id, message_id };
    let outcome = deps.llm.chat_stream(&messages, ids, sink.clone(), ticket.cancel_handle()).await;

    match outcome {
        Ok(StreamOutcome::Completed { content, reasoning, think_ms }) => {
            // FR-003：think_ms 以「用户感知等待」为准（首条 reasoning → 首条正文），
            // 网关墙钟值仅作无计量时的兜底。
            let think_ms = sink.think_ms().or_else(|| think_ms.map(|ms| ms as i64));
            let new = NewMessage {
                session_id,
                role: MessageRole::Assistant,
                content,
                reasoning,
                think_ms,
                tokens: None,
                interrupt_flag: TerminalState::Done.interrupt_flag().map(str::to_string),
            };
            match persist_terminal(deps, regenerate, &new) {
                Ok(_) => sink.release(),
                Err(e) => sink.release_with(LlmEvent::Error {
                    session_id,
                    message_id,
                    reason: format!("回复落库失败：{e}"),
                    interrupted: true,
                }),
            }
        }
        Ok(StreamOutcome::Cancelled { partial_content, partial_reasoning }) => {
            // 取消（SEQ-001 失败分支）：半条（如有）按 cancel 终态落库，补发 error 事件收尾。
            let interrupted = !partial_content.is_empty() || partial_reasoning.is_some();
            if interrupted {
                let new = NewMessage {
                    session_id,
                    role: MessageRole::Assistant,
                    content: partial_content,
                    reasoning: partial_reasoning,
                    think_ms: sink.think_ms(),
                    tokens: None,
                    interrupt_flag: TerminalState::Cancelled.interrupt_flag().map(str::to_string),
                };
                if let Err(e) = persist_terminal(deps, regenerate, &new) {
                    eprintln!("[generation] 取消半条落库失败：{e}");
                }
            }
            sink.release_with(LlmEvent::Error {
                session_id,
                message_id,
                reason: CANCEL_REASON.to_string(),
                interrupted,
            });
        }
        Err(failure) => {
            // 最终失败（网关已发 error，被闸门扣住）：半条（如有）按 error 终态落库后放行。
            let has_partial =
                !failure.partial_content.is_empty() || failure.partial_reasoning.is_some();
            if has_partial {
                let new = NewMessage {
                    session_id,
                    role: MessageRole::Assistant,
                    content: failure.partial_content,
                    reasoning: failure.partial_reasoning,
                    think_ms: sink.think_ms(),
                    tokens: None,
                    interrupt_flag: TerminalState::Error.interrupt_flag().map(str::to_string),
                };
                if let Err(e) = persist_terminal(deps, regenerate, &new) {
                    eprintln!("[generation] 失败半条落库失败：{e}");
                }
            }
            sink.release();
        }
    }
    Ok(())
}

/// 终态落库：普通发送为插入；重新生成 / 断流重试为「整条替换」（软删旧条 + 插新条，FR-008）。
/// 「库中同一逻辑位置任一时刻只有一条记录」（SEQ-001）由存储层单事务保证。
fn persist_terminal(deps: &GenerationDeps, regenerate: bool, new: &NewMessage) -> Result<(), StorageError> {
    if regenerate {
        deps.storage.replace_last_assistant_message(new).map(|_| ())
    } else {
        deps.storage.insert_message(new).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::{NewCharacter, NewSession};
    use crate::infra::config::ProviderConfig;
    use crate::infra::llm::mock::{delta_json, status_head, MockServer, sse_data, sse_head};
    use crate::infra::storage::test_support::temp_storage;
    use crate::infra::storage::Storage;
    use std::io::Write;

    // ---- 纯函数：标题截断（FR-007）----

    #[test]
    fn default_title_truncates_first_user_message() {
        assert_eq!(default_title("  你好，雨夜  "), "你好，雨夜");
        let long = "很长的一句话".repeat(10);
        let title = default_title(&long);
        assert_eq!(title.chars().count(), TITLE_MAX_CHARS + 1, "20 字 + 省略号");
        assert!(title.ends_with('…'));
        assert_eq!(default_title(""), "");
    }

    // ---- 纯函数：两级模型配置（INT-002 / 验收 4）----

    fn test_config() -> FileConfig {
        FileConfig {
            providers: vec![
                ProviderConfig {
                    id: "p1".into(),
                    name: "主".into(),
                    base_url: "https://main.example/v1".into(),
                    api_key: "k1".into(),
                    model: "m1".into(),
                },
                ProviderConfig {
                    id: "p2".into(),
                    name: "备".into(),
                    base_url: "https://backup.example/v1".into(),
                    api_key: "k2".into(),
                    model: "m2".into(),
                },
            ],
            active_provider_id: Some("p1".into()),
            ..FileConfig::new_with_defaults()
        }
    }

    fn character_with(model_config: Option<String>) -> Character {
        Character {
            id: 1,
            name: "苏鸢".into(),
            avatar: None,
            persona: String::new(),
            greeting: String::new(),
            render_style: "fade".into(),
            model_config,
            voice_config: None,
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
        }
    }

    #[test]
    fn resolve_llm_uses_global_default_without_override() {
        let cfg = resolve_effective_llm(&test_config(), &character_with(None)).unwrap();
        assert_eq!(cfg.base_url, "https://main.example/v1");
        assert_eq!(cfg.model, "m1");
        assert_eq!(cfg.api_key, "k1");
    }

    #[test]
    fn resolve_llm_applies_character_override_two_levels() {
        // 字段级覆写（第一级：全局默认打底）
        let over = character_with(Some(r#"{"model":"custom-model","apiKey":"kk"}"#.into()));
        let cfg = resolve_effective_llm(&test_config(), &over).unwrap();
        assert_eq!(cfg.model, "custom-model");
        assert_eq!(cfg.api_key, "kk");
        assert_eq!(cfg.base_url, "https://main.example/v1", "未覆写字段沿用全局默认");

        // providerId 切换整套 Provider
        let switched = character_with(Some(r#"{"providerId":"p2"}"#.into()));
        let cfg = resolve_effective_llm(&test_config(), &switched).unwrap();
        assert_eq!(cfg.base_url, "https://backup.example/v1");
        assert_eq!(cfg.model, "m2");

        // 直接覆写压过 providerId 切换
        let mixed = character_with(Some(r#"{"providerId":"p2","model":"m3"}"#.into()));
        let cfg = resolve_effective_llm(&test_config(), &mixed).unwrap();
        assert_eq!(cfg.base_url, "https://backup.example/v1");
        assert_eq!(cfg.model, "m3");

        // 未知键忽略；空串不覆写
        let lenient = character_with(Some(r#"{"temperature":0.7,"providerId":""}"#.into()));
        assert!(resolve_effective_llm(&test_config(), &lenient).is_ok());
    }

    #[test]
    fn resolve_llm_fails_fast_on_bad_config() {
        let err =
            resolve_effective_llm(&test_config(), &character_with(Some("{bad".into()))).unwrap_err();
        assert!(err.contains("model_config"), "{err}");

        let none = FileConfig::new_with_defaults();
        let err = resolve_effective_llm(&none, &character_with(None)).unwrap_err();
        assert!(err.contains("未配置"), "{err}");

        let mut blank = test_config();
        blank.providers[0].model = String::new();
        let err = resolve_effective_llm(&blank, &character_with(None)).unwrap_err();
        assert!(err.contains("model"), "{err}");

        let mut missing = test_config();
        missing.active_provider_id = Some("ghost".into());
        let err = resolve_effective_llm(&missing, &character_with(None)).unwrap_err();
        assert!(err.contains("未配置"), "悬空 active id 视为未选择：{err}");

        let err = resolve_effective_llm(
            &test_config(),
            &character_with(Some(r#"{"providerId":"ghost"}"#.into())),
        )
        .unwrap_err();
        assert!(err.contains("不存在"), "{err}");
    }

    // ---- 注册表：同会话互斥 + 取消 + 收尾（FR-007 / ADR-007 / FR-008）----

    #[test]
    fn registry_is_per_session_mutex_and_cancel() {
        let registry = GenerationRegistry::new();

        let t1 = registry.begin(1).unwrap();
        assert!(t1.message_id < 0, "临时 message_id 为负数，不与库主键冲突");
        assert!(matches!(registry.begin(1), Err(SessionBusy(1))), "同会话互斥");
        let t2 = registry.begin(2).unwrap();
        assert_ne!(t1.message_id, t2.message_id, "跨会话并发各持一路（ADR-007）");

        assert!(!registry.cancel(999), "无活跃生成为幂等 no-op");
        assert!(registry.cancel(1));
        assert!(!registry.is_active(1));
        assert!(!registry.cancel(1), "取消只生效一次");

        registry.finish(2);
        assert!(!registry.is_active(2));
    }

    // ---- 事件闸门 + 思考计量（FR-003 / SEQ-001）----

    struct Recorder(std::sync::Mutex<Vec<LlmEvent>>);
    impl EventSink for Recorder {
        fn emit(&self, event: LlmEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    #[test]
    fn sink_meters_think_and_holds_terminal_until_release() {
        let recorder = Arc::new(Recorder(std::sync::Mutex::new(Vec::new())));
        let sink = GenerationSink::new(recorder.clone());

        sink.emit(LlmEvent::Reasoning { session_id: 1, message_id: -1, text: "想".into(), reset: false });
        sink.emit(LlmEvent::Token { session_id: 1, message_id: -1, text: "答".into(), reset: false });
        sink.emit(LlmEvent::Done { session_id: 1, message_id: -1, think_ms: Some(7) });

        // 终态被扣住：done 尚未到前端
        assert_eq!(recorder.0.lock().unwrap().len(), 2);
        let think = sink.think_ms().unwrap();
        assert!(think < 5_000, "计量为墙钟短时长，实际 {think}");

        sink.release();
        let events = recorder.0.lock().unwrap().clone();
        assert_eq!(events.len(), 3, "release 后 done 放行");
        assert!(matches!(events.last(), Some(LlmEvent::Done { .. })));
    }

    #[test]
    fn sink_release_with_replaces_held_terminal() {
        let recorder = Arc::new(Recorder(std::sync::Mutex::new(Vec::new())));
        let sink = GenerationSink::new(recorder.clone());
        sink.emit(LlmEvent::Done { session_id: 1, message_id: -1, think_ms: None });
        sink.release_with(LlmEvent::Error {
            session_id: 1,
            message_id: -1,
            reason: "落库失败".into(),
            interrupted: true,
        });
        let events = recorder.0.lock().unwrap().clone();
        assert!(matches!(
            events.last(),
            Some(LlmEvent::Error { reason, .. }) if reason == "落库失败"
        ));
        assert!(sink.think_ms().is_none(), "无 reasoning → think_ms None");
    }

    // ---- 闭环集成（mock HTTP 网关，验收 1/2/3 路径）----

    fn client(url: &str) -> LlmClient {
        LlmClient::new(LlmConfig {
            base_url: url.to_owned(),
            api_key: "test".into(),
            model: "test-model".into(),
            connect_timeout_ms: 2_000,
            read_timeout_ms: 2_000,
            retry: crate::infra::llm::RetryPolicy {
                max_retries: 0,
                initial_backoff_ms: 0,
                backoff_multiplier: 1,
                max_backoff_ms: 0,
            },
        })
        .unwrap()
    }

    /// 事件记录器：同时记录「事件发出时刻」库中在世 assistant 条数，
    /// 验证 SEQ-001 的「终态落库先行，事件放行在后」。
    struct EventLog {
        events: std::sync::Mutex<Vec<(LlmEvent, usize)>>,
        storage: Arc<Storage>,
        session_id: i64,
    }

    impl EventSink for EventLog {
        fn emit(&self, event: LlmEvent) {
            let rows = self
                .storage
                .list_messages(self.session_id)
                .unwrap()
                .into_iter()
                .filter(|m| m.role == MessageRole::Assistant)
                .count();
            self.events.lock().unwrap().push((event, rows));
        }
    }

    fn setup(storage: &Storage) -> i64 {
        let character = storage
            .create_character(&NewCharacter {
                name: "苏鸢".into(),
                persona: "守夜人".into(),
                greeting: "雨点敲窗。".into(),
                ..Default::default()
            })
            .unwrap();
        storage
            .create_session(&NewSession { character_id: character.id, title: String::new() })
            .unwrap()
            .id
    }

    fn deps_for(storage: &Arc<Storage>, log: Arc<EventLog>, url: &str) -> GenerationDeps {
        GenerationDeps { storage: storage.clone(), sink: log, llm: Arc::new(client(url)) }
    }

    fn log_for(storage: &Arc<Storage>, session_id: i64) -> Arc<EventLog> {
        Arc::new(EventLog {
            events: std::sync::Mutex::new(Vec::new()),
            storage: storage.clone(),
            session_id,
        })
    }

    #[tokio::test]
    async fn send_flow_persists_done_after_row_lands() {
        let (raw, _dir) = temp_storage("gen_send");
        let storage = Arc::new(raw);
        let session_id = setup(&storage);
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::User, "在吗？"))
            .unwrap();

        let server = MockServer::start(|_req, stream| {
            let _ = sse_head(stream);
            for payload in [
                delta_json(None, Some("斟酌语气")),
                delta_json(Some("在"), None),
                delta_json(Some("。"), None),
            ] {
                let _ = stream.write_all(sse_data(&payload).as_bytes());
            }
            let _ = stream.write_all(sse_data("[DONE]").as_bytes());
        });

        let log = log_for(&storage, session_id);
        let registry = Arc::new(GenerationRegistry::new());
        let ticket = registry.begin(session_id).unwrap();
        let deps = deps_for(&storage, log.clone(), &server.url());

        PendingGeneration { deps, registry: registry.clone(), ticket, regenerate: false }
            .run()
            .await;

        // 终态落库（ADR-001）：整条含 reasoning 与 think_ms，无中断标记
        let rows = storage.list_messages(session_id).unwrap();
        assert_eq!(rows.len(), 2, "用户条 + assistant 条");
        let assistant = rows.last().unwrap();
        assert_eq!(assistant.content, "在。");
        assert_eq!(assistant.reasoning.as_deref(), Some("斟酌语气"));
        assert_eq!(assistant.interrupt_flag, None, "done 终态无中断标记");
        assert!(assistant.think_ms.is_some(), "思考计量（或网关兜底）落库");

        // 事件序列：reasoning/token 直通，done 最后且发出时行已在库（SEQ-001 时序）
        let events = log.events.lock().unwrap().clone();
        let kinds: Vec<&str> = events
            .iter()
            .map(|(e, _)| match e {
                LlmEvent::Token { .. } => "token",
                LlmEvent::Reasoning { .. } => "reasoning",
                LlmEvent::Done { .. } => "done",
                LlmEvent::Error { .. } => "error",
            })
            .collect();
        assert_eq!(kinds, vec!["reasoning", "token", "token", "done"]);
        assert_eq!(events.last().unwrap().1, 1, "done 放行前 assistant 行已落库");
        assert!(!registry.is_active(session_id), "终态后注册表摘除");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_persists_half_with_interrupt_flag_and_emits_error() {
        let (raw, _dir) = temp_storage("gen_cancel");
        let storage = Arc::new(raw);
        let session_id = setup(&storage);
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::User, "讲个故事"))
            .unwrap();

        // 流写出半条后挂住不结束（连接保持打开），等客户端取消。
        let server = MockServer::start(|_req, stream| {
            let _ = sse_head(stream);
            let _ = stream.write_all(sse_data(&delta_json(Some("很久很久"), None)).as_bytes());
            let _ = std::io::Write::flush(stream);
            loop {
                std::thread::sleep(std::time::Duration::from_secs(3600));
            }
        });

        let log = log_for(&storage, session_id);
        let registry = Arc::new(GenerationRegistry::new());
        let ticket = registry.begin(session_id).unwrap();
        let deps = deps_for(&storage, log.clone(), &server.url());

        let task = tokio::spawn(
            PendingGeneration { deps, registry: registry.clone(), ticket, regenerate: false }
                .run(),
        );

        // 等半条事件到达再取消（取消瞬时，FR-001 / NFR-004）
        wait_for(|| {
            log.events
                .lock()
                .unwrap()
                .iter()
                .any(|(e, _)| matches!(e, LlmEvent::Token { .. }))
        });
        assert!(registry.cancel(session_id));
        task.await.unwrap();

        // ADR-001：取消半条以 interrupt_flag 落库保留
        let rows = storage.list_messages(session_id).unwrap();
        assert_eq!(rows.len(), 2, "取消半条保留");
        let assistant = rows.last().unwrap();
        assert_eq!(assistant.content, "很久很久");
        assert_eq!(
            assistant.interrupt_flag.as_deref(),
            Some(crate::domain::chat::INTERRUPT_CANCEL)
        );

        // SEQ-001：取消经 error(interrupted=true) 事件收尾，reason 为稳定取消标记
        let events = log.events.lock().unwrap().clone();
        assert!(matches!(
            events.last(),
            Some((LlmEvent::Error { reason, interrupted: true, .. }, _)) if reason == CANCEL_REASON
        ));
        assert!(!registry.is_active(session_id));
    }

    #[tokio::test]
    async fn regenerate_replaces_last_assistant_row() {
        let (raw, _dir) = temp_storage("gen_regen");
        let storage = Arc::new(raw);
        let session_id = setup(&storage);
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::User, "讲个故事"))
            .unwrap();
        let old = storage
            .insert_message(&NewMessage::new(session_id, MessageRole::Assistant, "旧版本"))
            .unwrap();

        let server = MockServer::start(|_req, stream| {
            let _ = sse_head(stream);
            let _ = stream.write_all(sse_data(&delta_json(Some("新版本从头讲"), None)).as_bytes());
            let _ = stream.write_all(sse_data("[DONE]").as_bytes());
        });

        let log = log_for(&storage, session_id);
        let registry = Arc::new(GenerationRegistry::new());
        let ticket = registry.begin(session_id).unwrap();
        let deps = deps_for(&storage, log.clone(), &server.url());

        PendingGeneration { deps, registry, ticket, regenerate: true }.run().await;

        // FR-008：旧条软删（从列表消失）、新条从零生成并落库；新条非复用旧行
        let rows = storage.list_messages(session_id).unwrap();
        assert_eq!(rows.len(), 2, "user + 新 assistant（旧条已隐藏）");
        let new = rows.last().unwrap();
        assert_ne!(new.id, old.id, "新条为新插入行");
        assert_eq!(new.content, "新版本从头讲");
        assert_eq!(new.interrupt_flag, None);
        assert_eq!(
            storage.latest_assistant_message(session_id).unwrap().map(|m| m.id),
            Some(new.id)
        );

        let events = log.events.lock().unwrap().clone();
        assert!(
            matches!(events.last(), Some((LlmEvent::Done { .. }, 1))),
            "done 放行前旧条已被替换为恰好 1 条在世 assistant"
        );
    }

    /// OQ-006 / FR-008 断言辅助：捕获网关收到的请求体（messages 转成 (role, content) 列表）。
    type CapturedRequests = Arc<std::sync::Mutex<Vec<serde_json::Value>>>;

    fn capture_server(captured: CapturedRequests, script: impl Fn(&mut std::net::TcpStream) + Send + Sync + 'static) -> MockServer {
        MockServer::start(move |req, stream| {
            captured.lock().unwrap().push(req.json());
            script(stream);
        })
    }

    fn request_messages(captured: &CapturedRequests) -> Vec<(String, String)> {
        captured.lock().unwrap()[0]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                (
                    m["role"].as_str().unwrap().to_owned(),
                    m["content"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }

    /// OQ-006（FR-008「以相同上文重新发起生成」）：重新生成的请求上下文**不含**
    /// 被替换的旧整条 assistant 回复——以 user 条结尾，模型不是对旧答案的续写；
    /// 旧条本体在生成期间保留在库（崩溃安全），只是不进 prompt。
    #[tokio::test]
    async fn regenerate_request_excludes_replaced_whole_row() {
        let (raw, _dir) = temp_storage("gen_regen_ctx");
        let storage = Arc::new(raw);
        let session_id = setup(&storage);
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::User, "讲个故事"))
            .unwrap();
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::Assistant, "旧版本回复"))
            .unwrap();

        let captured: CapturedRequests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let server = capture_server(captured.clone(), |stream| {
            let _ = sse_head(stream);
            let _ = stream.write_all(sse_data(&delta_json(Some("新版本"), None)).as_bytes());
            let _ = stream.write_all(sse_data("[DONE]").as_bytes());
        });

        let registry = Arc::new(GenerationRegistry::new());
        let ticket = registry.begin(session_id).unwrap();
        let deps = deps_for(&storage, log_for(&storage, session_id), &server.url());

        PendingGeneration { deps, registry, ticket, regenerate: true }.run().await;

        let messages = request_messages(&captured);
        assert_eq!(messages.last().unwrap().0, "user", "请求以最后一条 user 条结尾");
        assert!(
            !messages.iter().any(|(_, content)| content == "旧版本回复"),
            "被替换的旧整条不得进上下文，实际请求：{messages:?}"
        );
        // 相同上文仍在：persona(system) + greeting(assistant) + user 提问
        assert_eq!(messages.len(), 3, "system + greeting + user（旧 assistant 已剔除）");
        assert_eq!(messages[0].0, "system");
        assert_eq!(messages[2].1, "讲个故事");
    }

    /// OQ-006 同一半：被替换条是**中断半条**（上次生成失败/取消留下的 interrupt 条，
    /// 也是 latest_assistant_message）时同样不得进上下文。
    #[tokio::test]
    async fn regenerate_request_excludes_replaced_interrupt_half_row() {
        let (raw, _dir) = temp_storage("gen_regen_half");
        let storage = Arc::new(raw);
        let session_id = setup(&storage);
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::User, "继续讲"))
            .unwrap();
        storage
            .insert_message(&NewMessage {
                session_id,
                role: MessageRole::Assistant,
                content: "写到一半的旧半条".into(),
                reasoning: None,
                think_ms: None,
                tokens: None,
                interrupt_flag: Some(crate::domain::chat::INTERRUPT_CANCEL.into()),
            })
            .unwrap();

        let captured: CapturedRequests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let server = capture_server(captured.clone(), |stream| {
            let _ = sse_head(stream);
            let _ = stream.write_all(sse_data(&delta_json(Some("全新的开头"), None)).as_bytes());
            let _ = stream.write_all(sse_data("[DONE]").as_bytes());
        });

        let registry = Arc::new(GenerationRegistry::new());
        let ticket = registry.begin(session_id).unwrap();
        let deps = deps_for(&storage, log_for(&storage, session_id), &server.url());

        PendingGeneration { deps, registry, ticket, regenerate: true }.run().await;

        let messages = request_messages(&captured);
        assert_eq!(messages.last().unwrap().0, "user");
        assert!(
            !messages.iter().any(|(_, content)| content == "写到一半的旧半条"),
            "被替换的中断半条不得进上下文，实际请求：{messages:?}"
        );
        assert_eq!(messages.len(), 3, "system + greeting + user");
    }

    /// 对照：普通发送路径（regenerate=false）上下文仍完整携带既有 assistant 历史
    /// （剔除只发生在整条替换语义下，OQ-006 修复不误伤正常闭环）。
    #[tokio::test]
    async fn send_request_still_includes_assistant_history() {
        let (raw, _dir) = temp_storage("gen_send_ctx");
        let storage = Arc::new(raw);
        let session_id = setup(&storage);
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::User, "你好"))
            .unwrap();
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::Assistant, "在"))
            .unwrap();
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::User, "再讲点"))
            .unwrap();

        let captured: CapturedRequests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let server = capture_server(captured.clone(), |stream| {
            let _ = sse_head(stream);
            let _ = stream.write_all(sse_data(&delta_json(Some("好"), None)).as_bytes());
            let _ = stream.write_all(sse_data("[DONE]").as_bytes());
        });

        let registry = Arc::new(GenerationRegistry::new());
        let ticket = registry.begin(session_id).unwrap();
        let deps = deps_for(&storage, log_for(&storage, session_id), &server.url());

        PendingGeneration { deps, registry, ticket, regenerate: false }.run().await;

        let messages = request_messages(&captured);
        assert!(messages.iter().any(|(role, content)| role == "assistant" && content == "在"),
            "普通发送：既有 assistant 回复应留在上下文，实际请求：{messages:?}");
        assert_eq!(messages.last().unwrap().1, "再讲点");
    }

    #[tokio::test]
    async fn stream_failure_persists_half_and_forwards_error() {
        let (raw, _dir) = temp_storage("gen_fail");
        let storage = Arc::new(raw);
        let session_id = setup(&storage);
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::User, "你好"))
            .unwrap();

        // 断流：半条后直接关连接（EOF before [DONE]），重试 0 次 → 最终失败
        let server = MockServer::start(|_req, stream| {
            let _ = sse_head(stream);
            let _ = stream.write_all(sse_data(&delta_json(Some("半条"), None)).as_bytes());
            let _ = std::io::Write::flush(stream);
            // drop stream = 断流
        });

        let log = log_for(&storage, session_id);
        let registry = Arc::new(GenerationRegistry::new());
        let ticket = registry.begin(session_id).unwrap();
        let deps = deps_for(&storage, log.clone(), &server.url());

        PendingGeneration { deps, registry, ticket, regenerate: false }.run().await;

        let rows = storage.list_messages(session_id).unwrap();
        let assistant = rows.last().unwrap();
        assert_eq!(assistant.content, "半条", "断流半条按 error 终态落库（ADR-001）");
        assert_eq!(
            assistant.interrupt_flag.as_deref(),
            Some(crate::domain::chat::INTERRUPT_ERROR)
        );

        let events = log.events.lock().unwrap().clone();
        assert!(matches!(
            events.last(),
            Some((LlmEvent::Error { interrupted: true, .. }, 1))
        ));
    }

    #[tokio::test]
    async fn empty_failure_leaves_no_ghost_row() {
        let (raw, _dir) = temp_storage("gen_emptyfail");
        let storage = Arc::new(raw);
        let session_id = setup(&storage);
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::User, "你好"))
            .unwrap();

        // 立即 401：无任何内容产出 → 不落库空行（UC-001 最小保证只保「已到达的内容」）
        let server = MockServer::start(|_req, stream| {
            let _ = status_head(stream, 401, "Unauthorized");
        });

        let log = log_for(&storage, session_id);
        let registry = Arc::new(GenerationRegistry::new());
        let ticket = registry.begin(session_id).unwrap();
        let deps = deps_for(&storage, log.clone(), &server.url());

        PendingGeneration { deps, registry, ticket, regenerate: false }.run().await;

        let rows = storage.list_messages(session_id).unwrap();
        assert_eq!(rows.len(), 1, "无内容的失败不产生空气泡行");
        let events = log.events.lock().unwrap().clone();
        assert!(matches!(
            events.last(),
            Some((LlmEvent::Error { interrupted: false, .. }, 0))
        ));
    }

    // ---- 测试辅助 ----

    /// 轮询等待条件成立（多线程测试运行时上等待另一 worker 上的生成进度）。
    fn wait_for(mut cond: impl FnMut() -> bool) {
        for _ in 0..500 {
            if cond() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("等待条件超时");
    }
}
