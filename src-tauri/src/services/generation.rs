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
use crate::domain::models::{Character, LlmCallKind, Message, MessageRole, NewMessage};
use crate::domain::ports::StoragePort;
use crate::infra::config::{Config as FileConfig, ProviderConfig};
use crate::infra::llm::{
    cancel_channel, CallTrace, CancelHandle, CancelSignal, EventSink, LlmClient, LlmConfig,
    LlmEvent, MessageIds, StreamOutcome,
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

    /// 查询会话是否已有进行中的生成。预留：生产侧同会话互斥由 [`GenerationRegistry::begin`]
    /// 返回 [`SessionBusy`] 保证，本查询目前仅测试断言消费（命令层前置探测 / 诊断接线预留）。
    #[allow(dead_code)]
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
/// `providerId` 切到 config.providers 中的另一套（双层级 2026-09-09：模型取该
/// 服务的 active/first）；其余键直接覆写对应字段（旧数据里的 baseUrl/apiKey
/// 键继续生效；UI 已不再产出这两个键）。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfigOverride {
    provider_id: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
}

/// 解析生效的 LLM 连接配置：全局默认 (provider, model) 二元组（双层级
/// 2026-09-09，见 Config::active_selection）为底，Character.model_config 逐字段
/// 覆写（两级配置，INT-002 / 验收 4）。多角色裁量：覆写源 = 调用方选定的模板卡
/// （命令层取「主持实例」的卡，见 ipc::resolve_llm）；None = 无卡可覆写（动态造人
/// 主持 / 畸形阵容），跟随全局默认。未配置 Provider/模型、字段为空或
/// model_config 非法 JSON → 人类可读错误（快速失败）。
pub fn resolve_effective_llm(
    config: &FileConfig,
    character: Option<&Character>,
) -> Result<LlmConfig, String> {
    let (provider, active_model): (&ProviderConfig, &str) = config
        .active_selection()
        .ok_or_else(|| "未配置全局默认模型：请在设置页选择服务并添加模型".to_string())?;
    let mut base_url = provider.base_url.clone();
    let mut api_key = provider.api_key.clone();
    let mut model = active_model.to_string();

    if let Some(raw) = character.and_then(|c| c.model_config.as_deref()) {
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
                // 切服务但未指名模型 → 取该服务第一个模型（active_model 是全局
                // 默认指向，不跟角色切服务走）。
                model = switched
                    .models
                    .first()
                    .cloned()
                    .ok_or_else(|| format!("服务「{id}」没有任何模型：请在设置页添加"))?;
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
            // 幕后活动事件（Task-06）：不参与思考计量、不受终态闸门，直通。生产上
            // 本包装收不到它（活动事件由探索器直接发往原始 sink），此分支仅为
            // LlmEvent 新变体的类型完备。
            LlmEvent::Activity { .. } => {}
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
    /// 结算专用导演客户端（FR-011 / INT-003）：模型经 `resolve_director_llm` 解析
    /// （跟随主模型、不做角色级覆写，§7-5），命令层在 PendingGeneration 构造时解析；
    /// None = 未配置 → 生成闭环跳过结算（导演是可选能力，不阻塞正文生成）。
    pub director_llm: Option<Arc<LlmClient>>,
    /// 近景场景数（近景窗口可选化）：config.json `near_scenes`（1–6，缺省
    /// ADR-004 的 2），命令层构造 deps 时取当次值穿入——config 不进 services
    /// 编排本体，装配所需的单值经依赖包传递（与 director_llm 同一穿透方式），
    /// generate_once → prompt::AssembleInputs 消费。
    pub near_scenes: usize,
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
    // 多角色阵容（方案 §3 第 1 步）：装配人设 / 消息归属 / 探索器指认都以实例为准。
    // 会话必然带阵容（create_session 单事务实例化，恰一用户位 + ≥1 LLM 位），
    // 空阵容 = 数据损坏，按读取失败上报而非静默续跑。
    let instances = deps.storage.list_instances(session_id)?;
    if instances.is_empty() {
        return Err(StorageError::Backend(format!("会话 #{session_id} 没有角色实例")));
    }
    let host = host_instance(&instances);
    let history = deps.storage.list_messages(session_id)?;
    // ADR-004 场景对齐装配的输入半：场景行供远景编年史 + 近景切分参照（无行为空，
    // 旧数据会话自动退化为纯字符预算窗口）。
    let scenes = deps.storage.list_scenes(session_id)?;
    // Task-02 常驻核心注入的读取半：人物状态（FR-012，挂实例）+ 会话日历快照
    // （FR-013，建会话时从用户位卡复制）。日历解析在此完成，装配本体保持纯函数
    // ——坏 JSON 由 parse 降级默认历（皮肤坏了退默认不阻塞主对话，与结算同语义）。
    let states = deps.storage.list_character_states(session_id)?;
    let calendar = crate::domain::fiction_time::parse(session.calendar_config.as_deref());
    // OQ-006 / FR-008「以相同上文重新发起生成」+ SEQ-001「重发 = 整条重来」：
    // 重新生成（含断流重试的整条替换语义）时，被替换的最后一条 assistant（旧整条
    // 或中断半条）不得进 prompt 上下文——按 id 剔除后再装配，使请求以 user 条结尾，
    // 模型不是对旧答案的续写。旧条本体保留在库中（「成功后替换」落库时序不变，
    // 崩溃安全），只是不参与本次装配。
    let history: Vec<_> = if regenerate {
        let replaced = deps.storage.latest_assistant_message(session_id)?;
        history
            .into_iter()
            .filter(|m| replaced.as_ref().is_none_or(|old| m.id != old.id))
            .collect()
    } else {
        history
    };
    // Task-05 记忆探索（切片 C）：主对话装配前，由带工具的一次 LLM 调用自主决定是否
    // 检索历史、查什么、查多深，产出卷宗注入 system【相关回忆】段。探索器是锦上添花
    // ——任何失败（网络 / 协议 / 取消）都在 explore 内降级为 None，主对话照常生成，
    // 不阻塞（留痕 warn 日志）。regenerate 路径同样执行：卷宗不落库、无法跨次复用，
    // 重跑一档探索成本可接受（硬约束：失败降级，见 explorer.rs）。
    // Task-06 活动事件：探索的幕后步骤经**原始 deps.sink** 即时透出（不走本函数下方
    // 构造的 GenerationSink——终态闸门只扣 token / reasoning / done / error，活动
    // 事件不受闸门）；路由键复用本次生成的临时负数 message_id，前端归属同一流式气泡。
    // 抽针 = 过滤后历史的最后一条 user（无 user 消息 = 无从判断指涉，跳过探索）。
    let dossier = match history.iter().rev().find(|m| m.role == MessageRole::User) {
        Some(latest_user) => {
            super::explorer::explore(
                deps.storage.as_ref(),
                deps.llm.as_ref(),
                deps.sink.as_ref(),
                MessageIds { session_id, message_id },
                &latest_user.content,
                &instances,
                ticket.cancel_handle(),
            )
            .await
        }
        None => None,
    };
    let messages = super::prompt::assemble(&super::prompt::AssembleInputs {
        instances: &instances,
        scenes: &scenes,
        history: &history,
        calendar: &calendar,
        states: &states,
        dossier: dossier.as_deref(),
        near_scenes: deps.near_scenes,
    });

    let sink = Arc::new(GenerationSink::new(deps.sink.clone()));
    let ids = MessageIds { session_id, message_id };
    // 调用轨迹接线（透明化功能）：主对话流式按 dialogue 类别落轨迹；断流重发的
    // 每次尝试在网关内各记一条（每次 HTTP 请求 = 一条）。
    let trace = CallTrace { session_id: Some(session_id), kind: LlmCallKind::Dialogue };
    let outcome = deps
        .llm
        .chat_stream(&messages, ids, sink.clone(), ticket.cancel_handle(), Some(&trace))
        .await;

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
                instance_id: Some(host.id),
            };
            match persist_terminal(deps, regenerate, &new) {
                Ok(inserted) => {
                    // FR-011 / ADR-005 线性阻塞：结算插在落库与 done 放行之间——done 事件
                    // 仍被终态闸门扣住，结算成功（或放弃）后才 release，前端看到终态时
                    // scenes / character_state 已在库（重试期间流式态自然停留在等待）。
                    // regenerate=true 同样参与结算（替换后的新整条才是叙事事实，§1）；
                    // §7-3 已知限制：重新生成撞上已结算边界时，旧边界触发的场景行 / 消息
                    // 归属不回滚（v1 无 soft_delete_scene 端口，接受并在此记录）。
                    super::director::run_settlement(deps, ticket, &inserted).await;
                    sink.release();
                }
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
                    instance_id: Some(host.id),
                };
                if let Err(e) = persist_terminal(deps, regenerate, &new) {
                    log::error!("取消半条落库失败：{e}");
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
                    instance_id: Some(host.id),
                };
                if let Err(e) = persist_terminal(deps, regenerate, &new) {
                    log::error!("失败半条落库失败：{e}");
                }
            }
            sink.release();
        }
    }
    Ok(())
}

/// 主持实例（v1.5 归属语义，方案 §3 的最小选择）：本切片多 LLM 位按 roster 序
/// **单次生成**（逐拍独立调用属第 2 步后能力），单条 assistant 消息无法按句拆分
/// 归属多个实例——归属「主持实例」= 首个 LLM 位实例（id 最小）。无 LLM 位的畸形
/// 阵容（存储层已拒绝，防御分支）回退首个实例，不 panic。
/// 用户消息归属用户位实例（命令层插入时挂）。
pub fn host_instance(instances: &[crate::domain::models::CharacterInstance]) -> &crate::domain::models::CharacterInstance {
    instances
        .iter()
        .find(|i| !i.is_user)
        .unwrap_or(&instances[0])
}

/// 终态落库：普通发送为插入；重新生成 / 断流重试为「整条替换」（软删旧条 + 插新条，FR-008）。
/// 「库中同一逻辑位置任一时刻只有一条记录」（SEQ-001）由存储层单事务保证。
/// 返回落库行（结算需要触发消息的真实 id 作归属区间终点，FR-011）。
fn persist_terminal(deps: &GenerationDeps, regenerate: bool, new: &NewMessage) -> Result<Message, StorageError> {
    if regenerate {
        deps.storage.replace_last_assistant_message(new)
    } else {
        deps.storage.insert_message(new)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::{NewCharacter, NewSession, RosterPick};
    use crate::infra::config::ProviderConfig;
    use crate::infra::llm::mock::{delta_json, json_body, json_raw_body, status_head, MockServer, sse_data, sse_head};
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
                    models: vec!["m1a".into(), "m1b".into()],
                    model: None,
                },
                ProviderConfig {
                    id: "p2".into(),
                    name: "备".into(),
                    base_url: "https://backup.example/v1".into(),
                    api_key: "k2".into(),
                    models: vec!["m2a".into()],
                    model: None,
                },
            ],
            active_provider_id: Some("p1".into()),
            active_model: Some("m1b".into()),
            ..FileConfig::new_with_defaults()
        }
    }

    fn character_with(model_config: Option<String>) -> Character {
        Character {
            id: 1,
            name: "苏鸢".into(),
            avatar: None,
            persona: String::new(),
            gender: None,
            age: None,
            render_style: "fade".into(),
            model_config,
            accent_color: None,
            voice_config: None,
            calendar_config: None,
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
        }
    }

    #[test]
    fn resolve_llm_uses_global_default_without_override() {
        let cfg = resolve_effective_llm(&test_config(), Some(&character_with(None))).unwrap();
        assert_eq!(cfg.base_url, "https://main.example/v1");
        assert_eq!(cfg.model, "m1b", "active_model 选中者生效");
        assert_eq!(cfg.api_key, "k1");

        // active_model 未选 → 回落该服务第一个模型。
        let mut fallback = test_config();
        fallback.active_model = None;
        let cfg = resolve_effective_llm(&fallback, Some(&character_with(None))).unwrap();
        assert_eq!(cfg.model, "m1a");
    }

    #[test]
    fn resolve_llm_applies_character_override_two_levels() {
        // 字段级覆写（第一级：全局默认打底）
        let over = character_with(Some(r#"{"model":"custom-model","apiKey":"kk"}"#.into()));
        let cfg = resolve_effective_llm(&test_config(), Some(&over)).unwrap();
        assert_eq!(cfg.model, "custom-model");
        assert_eq!(cfg.api_key, "kk");
        assert_eq!(cfg.base_url, "https://main.example/v1", "未覆写字段沿用全局默认");

        // providerId 切换整套 Provider：模型取目标服务第一个模型
        let switched = character_with(Some(r#"{"providerId":"p2"}"#.into()));
        let cfg = resolve_effective_llm(&test_config(), Some(&switched)).unwrap();
        assert_eq!(cfg.base_url, "https://backup.example/v1");
        assert_eq!(cfg.model, "m2a");

        // 直接覆写压过 providerId 切换
        let mixed = character_with(Some(r#"{"providerId":"p2","model":"m3"}"#.into()));
        let cfg = resolve_effective_llm(&test_config(), Some(&mixed)).unwrap();
        assert_eq!(cfg.base_url, "https://backup.example/v1");
        assert_eq!(cfg.model, "m3");

        // 未知键忽略；空串不覆写
        let lenient = character_with(Some(r#"{"temperature":0.7,"providerId":""}"#.into()));
        assert!(resolve_effective_llm(&test_config(), Some(&lenient)).is_ok());
    }

    #[test]
    fn resolve_llm_fails_fast_on_bad_config() {
        let err = resolve_effective_llm(
            &test_config(),
            Some(&character_with(Some("{bad".into()))),
        )
        .unwrap_err();
        assert!(err.contains("model_config"), "{err}");

        let none = FileConfig::new_with_defaults();
        let err = resolve_effective_llm(&none, Some(&character_with(None))).unwrap_err();
        assert!(err.contains("未配置"), "{err}");

        // 目标服务没有任何模型 → 快速失败。
        let mut no_models = test_config();
        no_models.providers[0].models.clear();
        no_models.active_model = None;
        let err = resolve_effective_llm(&no_models, Some(&character_with(None))).unwrap_err();
        assert!(err.contains("未配置"), "无模型视为未配置：{err}");

        let mut missing = test_config();
        missing.active_provider_id = Some("ghost".into());
        let err = resolve_effective_llm(&missing, Some(&character_with(None))).unwrap_err();
        assert!(err.contains("未配置"), "悬空 active id 视为未选择：{err}");

        let err = resolve_effective_llm(
            &test_config(),
            Some(&character_with(Some(r#"{"providerId":"ghost"}"#.into()))),
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

    /// 终态收尾后槽位释放：同会话可立即再次 begin（生产回路：begin → run → finish → 下一轮）。
    #[test]
    fn registry_slot_freed_after_finish_allows_rebegin() {
        let registry = GenerationRegistry::new();
        let t1 = registry.begin(1).unwrap();
        registry.finish(1);
        assert!(!registry.is_active(1));

        let t2 = registry.begin(1).unwrap();
        assert_ne!(t1.message_id, t2.message_id, "再次 begin 分配新临时 id");
        assert!(registry.is_active(1));
    }

    /// 临时 message_id 严格递减取值、全局唯一（跨会话、跨轮次都不重复）。
    #[test]
    fn registry_message_ids_unique_and_decreasing() {
        let registry = GenerationRegistry::new();
        let mut last = 0;
        for sid in [1, 2, 1, 3, 2] {
            let t = registry.begin(sid).expect("上一轮已 finish，槽位应空闲");
            registry.finish(sid);
            assert!(t.message_id < last, "id 严格递减：{} 应小于 {last}", t.message_id);
            last = t.message_id;
        }
    }

    /// 未知会话的 finish / is_active 均为无害 no-op。
    #[test]
    fn registry_unknown_session_ops_are_noop() {
        let registry = GenerationRegistry::new();
        registry.finish(999);
        assert!(!registry.is_active(999));
    }

    /// 标题截断边界：恰好 20 字不补省略号；21 字截断补省略号；纯空白 trim 后为空。
    #[test]
    fn default_title_exact_boundary_no_ellipsis() {
        let exact: String = "夜".repeat(TITLE_MAX_CHARS);
        assert_eq!(default_title(&exact), exact, "恰好 20 字原样保留");
        let over: String = "夜".repeat(TITLE_MAX_CHARS + 1);
        assert_eq!(default_title(&over), format!("{exact}…"), "21 字截断补省略号");
        assert_eq!(default_title("   \n\t "), "", "纯空白 trim 后为空串");
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

    /// 事件记录器：同时记录「事件发出时刻」库中在世 assistant 条数与在世场景行数，
    /// 验证 SEQ-001 的「终态落库先行，事件放行在后」与 FR-011 的「done 放行前结算已在库」。
    struct EventLog {
        events: std::sync::Mutex<Vec<(LlmEvent, usize, usize)>>,
        storage: Arc<Storage>,
        session_id: i64,
    }

    impl EventSink for EventLog {
        fn emit(&self, event: LlmEvent) {
            let messages = self.storage.list_messages(self.session_id).unwrap();
            let rows = messages
                .iter()
                .filter(|m| m.role == MessageRole::Assistant)
                .count();
            let scenes = self.storage.list_scenes(self.session_id).unwrap().len();
            self.events.lock().unwrap().push((event, rows, scenes));
        }
    }

    /// 阵容夹具（roster 首位放 LLM 位卡 → 其实例 id = 1，用户位实例 id = 2，
    /// 便于既有断言沿用实例 1 指认状态归属）。
    fn setup(storage: &Storage) -> i64 {
        let llm_card = storage
            .create_character(&NewCharacter {
                name: "苏鸢".into(),
                persona: "守夜人".into(),
                ..Default::default()
            })
            .unwrap();
        let user_card = storage
            .create_character(&NewCharacter { name: "旅人".into(), ..Default::default() })
            .unwrap();
        storage
            .create_session(&NewSession {
                roster: vec![
                    RosterPick { character_id: llm_card.id, is_user: false },
                    RosterPick { character_id: user_card.id, is_user: true },
                ],
                title: String::new(),
                opening: None,
            })
            .unwrap()
            .id
    }

    fn deps_for(storage: &Arc<Storage>, log: Arc<EventLog>, url: &str) -> GenerationDeps {
        GenerationDeps {
            storage: storage.clone(),
            sink: log,
            llm: Arc::new(client(url)),
            director_llm: None,
            near_scenes: crate::domain::context::SETTLED_SCENES_IN_NEAR,
        }
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

        // 事件序列：reasoning/token 直通，done 最后且发出时行已在库（SEQ-001 时序）。
        // 首条 activity = 探索器 research_start（Task-06）：该测试的 mock 对非流式
        // tools 请求回 SSE（非 JSON）→ 探索协议失败降级，仅留下起始活动事件。
        let events = log.events.lock().unwrap().clone();
        let kinds: Vec<&str> = events
            .iter()
            .map(|(e, _, _)| match e {
                LlmEvent::Token { .. } => "token",
                LlmEvent::Reasoning { .. } => "reasoning",
                LlmEvent::Done { .. } => "done",
                LlmEvent::Error { .. } => "error",
                LlmEvent::Activity { .. } => "activity",
            })
            .collect();
        assert_eq!(kinds, vec!["activity", "reasoning", "token", "token", "done"]);
        assert_eq!(events.last().unwrap().1, 1, "done 放行前 assistant 行已落库");
        assert!(!registry.is_active(session_id), "终态后注册表摘除");
    }

    /// 消息归属（多角色换挂，方案 §3）：user 消息挂用户位实例、assistant 挂主持
    /// 实例（首个 LLM 位；v1.5 单次生成的最小归属语义）。
    #[tokio::test]
    async fn messages_carry_instance_attribution() {
        let (raw, _dir) = temp_storage("gen_attribution");
        let storage = Arc::new(raw);
        let session_id = setup(&storage);
        // roster 首位 = LLM 位 → 主持实例 id 1，用户位实例 id 2。
        let instances = storage.list_instances(session_id).unwrap();
        let host = instances.iter().find(|i| !i.is_user).unwrap().id;
        let user_instance = instances.iter().find(|i| i.is_user).unwrap().id;
        storage
            .insert_message(&NewMessage {
                instance_id: Some(user_instance),
                ..NewMessage::new(session_id, MessageRole::User, "在吗？")
            })
            .unwrap();

        let server = MockServer::start(|_req, stream| {
            let _ = sse_head(stream);
            let _ = stream.write_all(sse_data(&delta_json(Some("在"), None)).as_bytes());
            let _ = stream.write_all(sse_data("[DONE]").as_bytes());
        });

        let log = log_for(&storage, session_id);
        let registry = Arc::new(GenerationRegistry::new());
        let ticket = registry.begin(session_id).unwrap();
        let deps = deps_for(&storage, log.clone(), &server.url());
        PendingGeneration { deps, registry: registry.clone(), ticket, regenerate: false }
            .run()
            .await;

        let rows = storage.list_messages(session_id).unwrap();
        assert_eq!(rows[0].instance_id, Some(user_instance), "user 消息归属用户位实例");
        assert_eq!(rows[1].instance_id, Some(host), "assistant 归属主持实例（首个 LLM 位）");
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
        // Task-05 起探索器（非流式 tools 请求）先打到本 mock：立即 500 让其降级返回，
        // 不让顺序处理的 mock 线程挂在聊天脚本上（聊天连接才能被受理）。
        let server = MockServer::start(|req, stream| {
            if req.json().get("tools").is_some() {
                let _ = status_head(stream, 500, "Internal Server Error");
                return;
            }
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
                .any(|(e, _, _)| matches!(e, LlmEvent::Token { .. }))
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
            Some((LlmEvent::Error { reason, interrupted: true, .. }, _, _)) if reason == CANCEL_REASON
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
            matches!(events.last(), Some((LlmEvent::Done { .. }, 1, _))),
            "done 放行前旧条已被替换为恰好 1 条在世 assistant"
        );
    }

    /// OQ-006 / FR-008 断言辅助：捕获网关收到的请求体（messages 转成 (role, content) 列表）。
    /// Task-05 起探索器的非流式 tools 请求也打到同一 mock，主对话请求按 stream:true 挑选。
    type CapturedRequests = Arc<std::sync::Mutex<Vec<serde_json::Value>>>;

    fn capture_server(captured: CapturedRequests, script: impl Fn(&mut std::net::TcpStream) + Send + Sync + 'static) -> MockServer {
        MockServer::start(move |req, stream| {
            captured.lock().unwrap().push(req.json());
            script(stream);
        })
    }

    fn request_messages(captured: &CapturedRequests) -> Vec<(String, String)> {
        let chat = captured
            .lock()
            .unwrap()
            .iter()
            .find(|body| body["stream"] == serde_json::Value::Bool(true))
            .expect("应捕获到主对话流式请求")
            .clone();
        chat["messages"]
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
        // 相同上文仍在：persona(system) + user 提问
        assert_eq!(messages.len(), 2, "system + user（旧 assistant 已剔除）");
        assert_eq!(messages[0].0, "system");
        assert_eq!(messages[1].1, "讲个故事");
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
                instance_id: None,
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
        assert_eq!(messages.len(), 2, "system + user");
    }

    /// Task-02 常驻核心注入（FR-012 / BR-003）：重新生成的 system 仍含当前虚时行
    /// （锚行缓存「第1日·夜」）与人物状态快照；regenerate 剔除被替换条**不影响**
    /// 这两段注入（剔除只动 history，虚时取场景行、状态独立读取）。
    #[tokio::test]
    async fn regenerate_request_keeps_time_and_states_injection() {
        let (raw, _dir) = temp_storage("gen_regen_inject");
        let storage = Arc::new(raw);
        let session_id = setup(&storage);
        // 预置人物状态（FR-012）：导演结算之外手工 upsert，等价结算落库形态。
        // 状态挂 LLM 位实例（roster 首位 → 实例 id 1）。
        storage
            .upsert_character_state(&crate::domain::models::NewCharacterState {
                instance_id: 1,
                scope: crate::domain::models::CharacterStateScope::State,
                key: "情绪".into(),
                value: "释然".into(),
                expiry: Some("scene_end".into()),
                source_scene: None,
            })
            .unwrap();
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
        assert_eq!(messages.last().unwrap().0, "user", "剔除路径仍以 user 结尾");
        assert!(
            !messages.iter().any(|(_, content)| content == "旧版本回复"),
            "被替换旧条仍被剔除：{messages:?}"
        );
        let system = &messages[0];
        assert_eq!(system.0, "system");
        assert!(
            system.1.contains("当前时间：第1日·夜"),
            "system 含当前虚时行（锚行缓存，默认历）：{}",
            system.1
        );
        assert!(
            system.1.contains("【当前状态】\n- 情绪：释然"),
            "system 含人物状态快照：{}",
            system.1
        );
        assert!(
            !system.1.contains("scene_end"),
            "expiry 不进叙事快照：{}",
            system.1
        );
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
            Some((LlmEvent::Error { interrupted: true, .. }, 1, _))
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
            Some((LlmEvent::Error { interrupted: false, .. }, 0, _))
        ));
    }

    // ---- Task-05：记忆探索接线（失败降级不阻塞 + 卷宗注入五段 + regenerate 同探索）----

    /// 探索器挂掉（非流式 tools 请求持续 500）时主对话行为与 Task-02 后完全一致：
    /// 正常流式生成、终态落库、done 收尾，system 不含【相关回忆】段（硬约束：降级不阻塞）。
    #[tokio::test]
    async fn explorer_failure_does_not_block_main_generation() {
        let (raw, _dir) = temp_storage("gen_expfail");
        let storage = Arc::new(raw);
        let session_id = setup(&storage);
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::User, "上次说的那件事"))
            .unwrap();

        let captured: CapturedRequests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let cap = captured.clone();
        let server = MockServer::start(move |req, stream| {
            let body = req.json();
            cap.lock().unwrap().push(body.clone());
            // 探索器（非流式 tools 请求）持续 500；主对话（流式）正常 SSE。
            if body.get("tools").is_some() {
                let _ = status_head(stream, 500, "Internal Server Error");
                return;
            }
            let _ = sse_head(stream);
            let _ = stream.write_all(sse_data(&delta_json(Some("照常回复"), None)).as_bytes());
            let _ = stream.write_all(sse_data("[DONE]").as_bytes());
        });

        let log = log_for(&storage, session_id);
        let registry = Arc::new(GenerationRegistry::new());
        let ticket = registry.begin(session_id).unwrap();
        let deps = deps_for(&storage, log.clone(), &server.url());

        PendingGeneration { deps, registry: registry.clone(), ticket, regenerate: false }
            .run()
            .await;

        let rows = storage.list_messages(session_id).unwrap();
        assert_eq!(rows.len(), 2, "主对话照常生成落库：{:?}", rows.len());
        assert_eq!(rows.last().unwrap().content, "照常回复");
        let events = log.events.lock().unwrap().clone();
        assert!(
            matches!(events.last(), Some((LlmEvent::Done { .. }, 1, _))),
            "done 正常收尾，实际：{:?}",
            events.last()
        );
        assert!(!registry.is_active(session_id), "终态后注册表摘除");
        let system = &request_messages(&captured)[0];
        assert_eq!(system.0, "system");
        assert!(!system.1.contains("【相关回忆】"), "探索失败不注入卷宗段：{}", system.1);
    }

    /// 卷宗注入：探索器工具往返成功 → 主对话 system 五段形态（persona → 虚时 →
    /// 编年史 → 相关回忆 → 状态），卷宗正文原样进入第四段；探索回路确实发生了
    /// 工具执行与回填。
    #[tokio::test]
    async fn dossier_injected_between_chronicle_and_states() {
        let (raw, _dir) = temp_storage("gen_dossier");
        let storage = Arc::new(raw);
        let session_id = setup(&storage);
        storage
            .upsert_character_state(&crate::domain::models::NewCharacterState {
                instance_id: 1,
                scope: crate::domain::models::CharacterStateScope::State,
                key: "情绪".into(),
                value: "惦念".into(),
                expiry: None,
                source_scene: None,
            })
            .unwrap();
        storage
            .insert_message(&NewMessage::new(
                session_id,
                MessageRole::User,
                "我们曾在灯塔下约定轮流守灯。",
            ))
            .unwrap();
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::Assistant, "她说好。"))
            .unwrap();
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::User, "还记得灯塔的约定吗？"))
            .unwrap();
        // 第二行场景行（远景编年史非空的必要条件）：手工插一行已结算形态的行。
        storage
            .insert_scene(&crate::domain::models::NewScene {
                session_id,
                location: Some("灯塔".into()),
                time_note: None,
                fic_day: Some(2),
                fic_part: Some("夜".into()),
                date_label: None,
                summary: Some("灯塔下的约定".into()),
                recap: None,
                present: vec![1],
            })
            .unwrap();

        let explorer_rounds = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let rounds = explorer_rounds.clone();
        let captured: CapturedRequests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let cap = captured.clone();
        let server = MockServer::start(move |req, stream| {
            let body = req.json();
            cap.lock().unwrap().push(body.clone());
            if body.get("tools").is_some() {
                // 探索器两轮：先发起检索，再总结卷宗。
                if rounds.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    let _ = json_raw_body(
                        stream,
                        &serde_json::json!({
                            "choices": [{"message": {"role": "assistant", "content": null,
                                "tool_calls": [{"id": "call_1", "type": "function",
                                    "function": {"name": "search_history",
                                        "arguments": "{\"keyword\":\"灯塔\"}"}}]}}]
                        })
                        .to_string(),
                    );
                } else {
                    let _ = json_raw_body(
                        stream,
                        &serde_json::json!({
                            "choices": [{"message": {"role": "assistant",
                                "content": "场0：两人约定在灯塔下轮流守灯。"}}]
                        })
                        .to_string(),
                    );
                }
                return;
            }
            let _ = sse_head(stream);
            let _ = stream.write_all(sse_data(&delta_json(Some("她想起灯塔的约定。"), None)).as_bytes());
            let _ = stream.write_all(sse_data("[DONE]").as_bytes());
        });

        let log = log_for(&storage, session_id);
        let registry = Arc::new(GenerationRegistry::new());
        let ticket = registry.begin(session_id).unwrap();
        let deps = deps_for(&storage, log.clone(), &server.url());

        PendingGeneration { deps, registry, ticket, regenerate: false }.run().await;

        // 主对话请求：以最新 user 结尾，system 五段顺序单调递增，卷宗正文注入。
        let messages = request_messages(&captured);
        assert_eq!(messages.last().unwrap().1, "还记得灯塔的约定吗？", "主对话以最新 user 结尾");
        let system = &messages[0];
        assert_eq!(system.0, "system");
        let persona_at = system.1.find("守夜人").unwrap();
        let time_at = system.1.find("当前时间：第2日·夜").unwrap();
        let chronicle_at = system.1.find("【往事编年史】").unwrap();
        let memory_at = system.1.find("【相关回忆】").unwrap();
        let state_at = system.1.find("【当前状态】").unwrap();
        assert!(
            persona_at < time_at
                && time_at < chronicle_at
                && chronicle_at < memory_at
                && memory_at < state_at,
            "五段形态 persona → 虚时 → 编年史 → 相关回忆 → 状态：{}",
            system.1
        );
        assert!(
            system.1.contains("【相关回忆】\n场0：两人约定在灯塔下轮流守灯。"),
            "卷宗正文原样注入：{}",
            system.1
        );
        // 探索回路确实发生：两轮非流式 tools 请求，第二轮带 tool 结果回填。
        let requests = captured.lock().unwrap().clone();
        let explorer_reqs: Vec<serde_json::Value> =
            requests.iter().filter(|body| body.get("tools").is_some()).cloned().collect();
        assert_eq!(explorer_reqs.len(), 2, "探索器恰好两轮");
        let explorer_msgs = explorer_reqs[1]["messages"].as_array().unwrap().clone();
        assert_eq!(explorer_msgs[3]["role"], "tool", "工具结果回填：{explorer_msgs:?}");
        let tool_content = explorer_msgs[3]["content"].as_str().unwrap();
        assert!(tool_content.contains("灯塔"), "工具真实命中库中消息：{tool_content}");
        // 主链路照常：落库 + done 收尾。
        let rows = storage.list_messages(session_id).unwrap();
        assert_eq!(rows.last().unwrap().content, "她想起灯塔的约定。");
        let events = log.events.lock().unwrap().clone();
        assert!(
            matches!(events.last(), Some((LlmEvent::Done { .. }, 2, 2))),
            "done 收尾时 2 条在世 assistant、2 条场景行（无场景线零结算），实际：{:?}",
            events.last()
        );
    }

    /// regenerate 路径同样执行探索（卷宗不落库无法复用，重跑成本一档可接受）：
    /// 探索请求先于主对话请求发生，主对话 system 含卷宗段，整条替换语义不变。
    #[tokio::test]
    async fn regenerate_path_also_explores() {
        let (raw, _dir) = temp_storage("gen_regen_exp");
        let storage = Arc::new(raw);
        let session_id = setup(&storage);
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::User, "讲讲灯塔的旧事"))
            .unwrap();
        let old = storage
            .insert_message(&NewMessage::new(session_id, MessageRole::Assistant, "旧版本"))
            .unwrap();

        let explorer_rounds = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let rounds = explorer_rounds.clone();
        let captured: CapturedRequests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let cap = captured.clone();
        let server = MockServer::start(move |req, stream| {
            let body = req.json();
            cap.lock().unwrap().push(body.clone());
            if body.get("tools").is_some() {
                if rounds.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    let _ = json_raw_body(
                        stream,
                        &serde_json::json!({
                            "choices": [{"message": {"role": "assistant", "content": null,
                                "tool_calls": [{"id": "call_1", "type": "function",
                                    "function": {"name": "search_history",
                                        "arguments": "{\"keyword\":\"灯塔\"}"}}]}}]
                        })
                        .to_string(),
                    );
                } else {
                    let _ = json_raw_body(
                        stream,
                        &serde_json::json!({
                            "choices": [{"message": {"role": "assistant",
                                "content": "场0：灯塔旧事一条。"}}]
                        })
                        .to_string(),
                    );
                }
                return;
            }
            let _ = sse_head(stream);
            let _ = stream.write_all(sse_data(&delta_json(Some("新版本从头讲"), None)).as_bytes());
            let _ = stream.write_all(sse_data("[DONE]").as_bytes());
        });

        let log = log_for(&storage, session_id);
        let registry = Arc::new(GenerationRegistry::new());
        let ticket = registry.begin(session_id).unwrap();
        let deps = deps_for(&storage, log.clone(), &server.url());

        PendingGeneration { deps, registry, ticket, regenerate: true }.run().await;

        // 探索先于主对话发生（两条非流式 tools 请求 + 一条流式请求）。
        let requests = captured.lock().unwrap().clone();
        assert_eq!(requests.len(), 3, "探索两轮 + 主对话一轮：{requests:?}");
        assert!(
            requests[0].get("tools").is_some() && requests[1].get("tools").is_some(),
            "前两条为探索器请求"
        );
        assert_eq!(requests[2]["stream"], serde_json::Value::Bool(true), "主对话最后发生");
        let system = &request_messages(&captured)[0];
        assert!(
            system.1.contains("【相关回忆】\n场0：灯塔旧事一条。"),
            "regenerate 的主对话 system 含卷宗段：{}",
            system.1
        );
        // 替换语义不变（FR-008）。
        let rows = storage.list_messages(session_id).unwrap();
        assert_eq!(rows.len(), 2, "user + 新 assistant（旧条已隐藏）");
        let new = rows.last().unwrap();
        assert_ne!(new.id, old.id);
        assert_eq!(new.content, "新版本从头讲");
    }

    // ---- FR-011 结算接线（ADR-005：done 放行前 scenes / character_state 已在库）----

    /// assistant 正文含 `---` → 结算在 done 放行前完成：EventLog 在事件发出时刻采样，
    /// done 记录点上恰好 1 条在世场景行；裁决字段与状态清算逐项落库。
    #[tokio::test]
    async fn scene_line_settles_before_done_release() {
        let (raw, _dir) = temp_storage("gen_settle");
        let storage = Arc::new(raw);
        let session_id = setup(&storage);
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::User, "我们走进旧书店。"))
            .unwrap();

        // 主生成网关：assistant 正文带场景线（触发结算）。
        let chat = MockServer::start(|_req, stream| {
            let _ = sse_head(stream);
            let _ = stream.write_all(
                sse_data(&delta_json(Some("她抬头。\n\n---\n\n新的开始。"), None)).as_bytes(),
            );
            let _ = stream.write_all(sse_data("[DONE]").as_bytes());
        });
        // 结算网关：一次完整裁决（含状态 upsert）。
        let captured: CapturedRequests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let cap = captured.clone();
        let director_server = MockServer::start(move |_req, stream| {
            cap.lock().unwrap().push(_req.json());
            let _ = json_body(
                stream,
                r#"{"location":"旧书店 · 打烊后","time_note":"次日清晨","fic_day":2,"fic_part":"清晨","summary":"雨夜争执后无言告别","present":[1,2],"states":[{"instance_id":1,"scope":"state","key":"情绪","value":"释然","expiry":"scene_end"}]}"#,
            );
        });

        let log = log_for(&storage, session_id);
        let registry = Arc::new(GenerationRegistry::new());
        let ticket = registry.begin(session_id).unwrap();
        let deps = GenerationDeps {
            storage: storage.clone(),
            sink: log.clone(),
            llm: Arc::new(client(&chat.url())),
            director_llm: Some(Arc::new(client(&director_server.url()))),
            near_scenes: crate::domain::context::SETTLED_SCENES_IN_NEAR,
        };
        PendingGeneration { deps, registry: registry.clone(), ticket, regenerate: false }
            .run()
            .await;

        // done 放行时刻采样：1 条在世 assistant + 2 条在世场景行（开场锚行 FR-014 +
        // 结算新行；结算先于 done，ADR-005）。
        let events = log.events.lock().unwrap().clone();
        assert!(
            matches!(events.last(), Some((LlmEvent::Done { .. }, 1, 2))),
            "done 放行前 scenes 已落库，实际：{:?}",
            events.last()
        );
        // 场景行字段（边界快照 + date_label 派生）。
        let scenes = storage.list_scenes(session_id).unwrap();
        assert_eq!(scenes.len(), 2, "scenes[0] = 开场锚行（FR-014），scenes[1] = 结算新行");
        let settled = scenes.last().unwrap();
        assert_eq!(settled.location.as_deref(), Some("旧书店 · 打烊后"));
        assert_eq!(settled.time_note.as_deref(), Some("次日清晨"));
        assert_eq!(settled.fic_day, Some(2));
        assert_eq!(settled.fic_part.as_deref(), Some("清晨"));
        assert_eq!(settled.date_label.as_deref(), Some("第2日·清晨"));
        assert_eq!(settled.summary, None, "新行不再预填裁决 summary（2026-09-12 裁决修订）");
        assert_eq!(
            scenes[0].summary.as_deref(),
            Some("雨夜争执后无言告别"),
            "裁决 summary 回写上一行（此处上一行 = 开场锚行）"
        );
        assert_eq!(
            settled.present,
            vec![1, 2],
            "在场 = 全部实例 id（roster 两位；多角色换挂后语义为实例）"
        );
        // 状态清算落库。
        let states = storage.list_character_states(session_id).unwrap();
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].key, "情绪");
        assert_eq!(states[0].value, "释然");
        // 结算 prompt 携带叙事窗口（触发消息 + 前文）。
        let requests = captured.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        let user = requests[0]["messages"][1]["content"].as_str().unwrap();
        assert!(user.contains("[assistant] 她抬头。"), "叙事窗口含触发消息：{user}");
        assert!(user.contains("我们走进旧书店。"), "叙事窗口含触发前消息");
    }

    /// assistant 正文不含 `---` → 零结算：导演一次都不被调用，无场景行落库，
    /// done 正常放行（BR-006：场景线是唯一触发主体）。
    #[tokio::test]
    async fn no_scene_line_skips_settlement_entirely() {
        let (raw, _dir) = temp_storage("gen_nosettle");
        let storage = Arc::new(raw);
        let session_id = setup(&storage);
        storage
            .insert_message(&NewMessage::new(session_id, MessageRole::User, "继续讲。"))
            .unwrap();

        let chat = MockServer::start(|_req, stream| {
            let _ = sse_head(stream);
            let _ = stream.write_all(
                sse_data(&delta_json(Some("她点点头，没有说话。行内——破折号不算场景线。"), None))
                    .as_bytes(),
            );
            let _ = stream.write_all(sse_data("[DONE]").as_bytes());
        });
        let director_attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = director_attempts.clone();
        let director_server = MockServer::start(move |_req, stream| {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _ = json_body(stream, r#"{"summary":"不该发生的结算"}"#);
        });

        let log = log_for(&storage, session_id);
        let registry = Arc::new(GenerationRegistry::new());
        let ticket = registry.begin(session_id).unwrap();
        let deps = GenerationDeps {
            storage: storage.clone(),
            sink: log.clone(),
            llm: Arc::new(client(&chat.url())),
            director_llm: Some(Arc::new(client(&director_server.url()))),
            near_scenes: crate::domain::context::SETTLED_SCENES_IN_NEAR,
        };
        PendingGeneration { deps, registry, ticket, regenerate: false }.run().await;

        assert_eq!(
            director_attempts.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "无场景线不得调用导演"
        );
        // FR-014：账上只有建会话 seed 的开场锚行，本次零结算未追加任何行。
        let scenes = storage.list_scenes(session_id).unwrap();
        assert_eq!(scenes.len(), 1, "零结算：仅存开场锚行");
        assert_eq!(scenes[0].summary.as_deref(), None);
        assert_eq!(scenes[0].fic_day, Some(1));
        let events = log.events.lock().unwrap().clone();
        assert!(matches!(events.last(), Some((LlmEvent::Done { .. }, 1, 1))));
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
