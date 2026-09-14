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

mod registry;

pub use registry::{GenerationRegistry, GenerationTicket, SessionBusy};

use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Deserialize;

use crate::domain::chat::TerminalState;
use crate::domain::error::StorageError;
use crate::domain::llm_call::LlmCallKind;
use crate::domain::models::{Character, Message, MessageRole, NewMessage};
use crate::domain::ports::StoragePort;
use crate::infra::config::{Config as FileConfig, ProviderConfig};
use crate::infra::llm::{
    CallTrace, EventSink, LlmClient, LlmConfig, LlmEvent, MessageIds, StreamOutcome,
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
    // 协议随 provider 走（2026-09-14 三协议）：provider 级属性，请求分派与响应
    // 解析都依赖它，切 provider 时整体跟随。
    let mut api = provider.api;

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
                // 协议跟随所选 provider（切服务即切 API 形态）。
                api = switched.api;
                // 切服务但未指名模型 → 取该服务第一个模型（active_model 是全局
                // 默认指向，不跟角色切服务走）。
                model = switched
                    .models
                    .first()
                    .cloned()
                    .ok_or_else(|| format!("服务「{id}」没有任何模型：请在设置页添加"))?;
            }
            // 旧键 baseUrl/apiKey 覆写不携带协议：协议是 provider 级属性，不在
            // 角色覆写键清单里（沿用所选 provider 的 api），否则会出现「别家的
            // base_url + 本家协议」的畸形组合。
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
    Ok(LlmConfig { base_url, api_key, model, api, ..LlmConfig::default() })
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
mod tests;
