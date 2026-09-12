//! 导演服务（CMP-004）：结算编排（ADR-005 线性阻塞，重试直到成功才推进）、开局包（FR-014）。
//!
//! 本切片实现 FR-011 结算链路，分两半：
//! - **纯函数半**（子模块 `verdict`，外置自本文件上半，500 行规范）：场景线触发判定
//!   （与渲染引擎逐字对齐）、导演裁决的 serde 类型与字段级容错（normalize）——全部可离线单测；
//! - **编排半**（本文件）：[`resolve_director_llm`] → prompt 装配 → [`run_settlement`]
//!   （complete_json → normalize → commit_settlement，退避重试 + 可打断）。
//!
//! ADR-005 线性阻塞的落地：结算由生成闭环在「assistant 落库之后、done 放行之前」调用
//! （done 事件被终态闸门扣住），「结算成功才推进下一拍」由构造保证；重试期间 done 一直
//! 扣着，前端流式态自然停留在等待（与正文生成同等对待）。取消 / 失败路径不结算
//! （半条不是完整叙事，BR-006 的触发主体不存在）。

mod verdict;

pub use verdict::{
    contains_scene_line, DirectorVerdict, normalize, SettlementVerdict, StateOp, StateUpsert,
};

use crate::domain::error::StorageError;
use crate::domain::fiction_time;
use crate::domain::models::{
    CharacterInstance, CharacterState, LlmCallKind, Message, NewCharacterState, NewScene, Scene,
    Session,
};
// 外置测试（director/tests.rs）经 `use super::*` 以此指认 scope 枚举；本体已不直接
// 使用（CharacterStateScope 属 verdict.rs），故 cfg(test) 限定，避免非测试构建的
// unused import 警告。
#[cfg(test)]
use crate::domain::models::CharacterStateScope;
use crate::domain::ports::{AttachRange, SettlementWrite};
use crate::infra::config::Config as FileConfig;
use crate::infra::llm::{CallTrace, ChatMessage, ChatRole, LlmClient, LlmConfig};
use crate::services::generation::{GenerationDeps, GenerationTicket};

// ---------------------------------------------------------------------------
// 编排半：模型解析 → prompt 装配 → 结算循环（ADR-005 重试直到成功，可打断）
// ---------------------------------------------------------------------------

/// 结算重试退避（§2：500ms 起 ×2 指数、封顶 8s，对齐 `RetryPolicy::default` 节奏；
/// 循环责任在调用方，`complete_json` 单次尝试自持 read_timeout 兜底不永久挂起）。
const BACKOFF_INITIAL_MS: u64 = 500;
const BACKOFF_MAX_MS: u64 = 8_000;
/// 连续失败日志节流（§7-6：一期只做日志，每满 3 次连续失败 error 一条）。
const LOG_EVERY_N_FAILURES: u32 = 3;
/// 叙事窗口：触发消息全文 + 其前 K 条（§2 建议 K=6）。
const NARRATIVE_WINDOW_MESSAGES: usize = 6;
/// 叙事窗口总长字符上限（§2 建议 ~6000 字，token 预算意识；超长从最旧侧截）。
const NARRATIVE_MAX_CHARS: usize = 6_000;

/// 导演调用解析（INT-003）：模型名经 `effective_director_model`（空 = 跟随主模型），
/// base_url / api_key 取 active_provider。**不复用** `resolve_effective_llm`——那是
/// Character.model_config 覆写语义，导演调用不做角色级覆写（§7-5）。到结算时点
/// 主模型必然已配置成功（否则 send_message 早失败），错误分支仅防御。
pub fn resolve_director_llm(config: &FileConfig) -> Result<LlmClient, String> {
    let provider = config
        .active_provider()
        .ok_or_else(|| "未配置全局默认模型：请在设置页选择服务并添加模型".to_string())?;
    let model = config
        .effective_director_model()
        .ok_or_else(|| "无可用模型：导演结算跟随主模型，请在设置页完成模型配置".to_string())?;
    if provider.base_url.trim().is_empty() {
        return Err("LLM base_url 不能为空：请检查 Provider 配置".into());
    }
    LlmClient::new(LlmConfig {
        base_url: provider.base_url.clone(),
        api_key: provider.api_key.clone(),
        model: model.to_string(),
        ..LlmConfig::default()
    })
    .map_err(|error| error.to_string())
}

/// prompt 装配的纯输入（编排时从库收集；system + 单条 user，§2）。
pub(crate) struct SettlementInput<'a> {
    /// 在场名单（v1 恒为 `[会话角色]`，§7-7）。
    pub roster: &'a [(i64, String)],
    pub latest_scene: Option<&'a Scene>,
    pub states: &'a [CharacterState],
    pub calendar: &'a fiction_time::CalendarConfig,
    /// 已装配限长的叙事原文（`[user]/[assistant]` 前缀）。
    pub narrative: &'a str,
}

/// 装配结算 prompt：system（导演指令）+ 单条 user（分段标注 payload）。
pub(crate) fn assemble_prompt(input: &SettlementInput<'_>) -> Vec<ChatMessage> {
    vec![
        ChatMessage::new(ChatRole::System, system_prompt()),
        ChatMessage::new(ChatRole::User, user_payload(input)),
    ]
}

/// 导演 system 指令（§2）：角色定位 + 四件事清单 + 硬规则（BR-002 / BR-003）+ 只输出 JSON。
fn system_prompt() -> &'static str {
    "你是叙事后台的「结算导演」：隐藏的大脑，不是叙事者——不向玩家输出剧情文本，\
只对刚出现场景线（---）的叙事段做结构化裁决，只输出一个 JSON 对象，不输出任何其他文字。

你的职责（四件事）：
1. 新场景定稿：给出边界之后新场景的 location（地点）与 time_note（叙事时间原文，如「次日清晨」）。
2. 收束段两档摘要：对 --- 之前刚收束的整段剧情同时产出两档——summary 用一句远景概括（供久远回看），recap 用两三句加厚回顾（保留关键对话与转折，供刚滑出叙事窗口时回顾）。两档内容一致但详略不同，不是重复同一句。
3. 状态清算：维护 states。状态归属用【在场名单】中的**实例 id**（同一角色卡在不同会话是不同实例）指认：增改状态用 {\"instance_id\":…,\"scope\":\"state|relation\",\"key\":…,\"value\":…,\"expiry\":…}；清除状态用 {\"instance_id\":…,\"clear\":\"键名\"}。硬规则：value 用叙事语言、绝不用数字；在册总条数保持 10 条以内，超出时合并或清除最陈旧的；expiry 三义取其一：scene_end（下次场景收束失效）/ event:事件名 / manual（仅手动清除）。
4. 时间换算：给出 fic_day（第几天，整数）与 fic_part（六值之一：清晨/上午/午后/黄昏/夜/深夜）。模糊时间（「次日」「片刻后」）取最小合理值，并把准确的叙事时间写进 time_note。虚时只被叙事推进，绝不倒流：fic_day 不得小于当前账本位。

输出格式（缺失字段用 null）：
{\"location\":\"…\",\"time_note\":\"…\",\"fic_day\":2,\"fic_part\":\"夜\",\"summary\":\"…\",\"recap\":\"…\",\"present\":[实例id],\"states\":[{\"instance_id\":1,\"scope\":\"state\",\"key\":\"情绪\",\"value\":\"释然\",\"expiry\":\"scene_end\"}]}"
}

/// user payload（§2 五段）：上一场快照 / 当前状态集 / 在场名单 / 日历提示 / 本回合叙事。
fn user_payload(input: &SettlementInput<'_>) -> String {
    let mut sections: Vec<String> = Vec::new();

    // 1) 上一场快照（无则开场段）；recap（Task-03 加厚回顾）有则附在摘要之后。
    sections.push(match input.latest_scene {
        Some(scene) => {
            let recap_line = scene
                .recap
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(|text| format!("\n上一场回顾：{text}"))
                .unwrap_or_default();
            format!(
                "【上一场快照】\n地点：{}\n时间：{}（第 {} 天 · {}）\n上一场摘要：{}{recap_line}",
                scene.location.as_deref().unwrap_or("（未记录）"),
                scene.date_label.as_deref().unwrap_or("（未记录）"),
                scene.fic_day.map(|day| day.to_string()).unwrap_or_else(|| "?".into()),
                scene.fic_part.as_deref().unwrap_or("?"),
                scene.summary.as_deref().unwrap_or("（无）"),
            )
        }
        None => "【上一场快照】\n本段是开场后第一段，没有上一场。".to_string(),
    });

    // 2) 当前状态集（全量给足，精简指令在 system；格式 [id] scope key = value (expiry)）。
    let states = if input.states.is_empty() {
        "（空）".to_string()
    } else {
        input
            .states
            .iter()
            .map(|state| {
                format!(
                    "[{}] {} {} = {} ({})",
                    state.instance_id,
                    state.scope.as_str(),
                    state.key,
                    state.value,
                    state.expiry.as_deref().unwrap_or("-"),
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    sections.push(format!("【当前状态集】\n{states}"));

    // 3) 在场名单（§7-7 多角色化：全部会话实例；名单即「实例 id ↔ 实例名」映射，
    //    模型用它指认 states 归属，Q5/D9「对XX」关系歧义由 key 文本承载）。
    let roster = input
        .roster
        .iter()
        .map(|(id, name)| format!("[{id}] {name}"))
        .collect::<Vec<_>>()
        .join("\n");
    sections.push(format!("【在场名单】\n{roster}"));

    // 4) 日历提示：历法名 / 节日摘要 + 当前账本位。
    let calendar = &input.calendar;
    let mut calendar_lines: Vec<String> = Vec::new();
    if let Some(name) = &calendar.name {
        calendar_lines.push(format!("历法：{name}"));
    }
    if !calendar.festivals.is_empty() {
        let festivals = calendar
            .festivals
            .iter()
            .map(|(day, name)| format!("第{day}日 {name}"))
            .collect::<Vec<_>>()
            .join("；");
        calendar_lines.push(format!("节日：{festivals}"));
    }
    if calendar_lines.is_empty() {
        calendar_lines.push("（默认历，无命名皮肤）".to_string());
    }
    let ledger = match input.latest_scene {
        Some(scene) => format!(
            "第 {} 天 · {}",
            scene.fic_day.map(|day| day.to_string()).unwrap_or_else(|| "1".into()),
            scene.fic_part.as_deref().unwrap_or("清晨"),
        ),
        None => "第 1 天".to_string(),
    };
    calendar_lines.push(format!("当前账本位：{ledger}"));
    sections.push(format!("【日历】\n{}", calendar_lines.join("\n")));

    // 5) 本回合叙事原文（触发消息全文 + 其前 K 条，超长已从最旧侧截）。
    sections.push(format!("【本回合叙事】\n{}", input.narrative));

    sections.join("\n\n")
}

/// 叙事窗口（§2）：最后 K+1 条（触发消息 + 其前 K 条）加 `[user]/[assistant]` 前缀，
/// 总长超 [`NARRATIVE_MAX_CHARS`] 从最旧侧整条丢弃。
pub(crate) fn narrative_window(history: &[Message], max_chars: usize) -> String {
    let window_start = history.len().saturating_sub(NARRATIVE_WINDOW_MESSAGES + 1);
    let mut lines: Vec<String> = history[window_start..]
        .iter()
        .map(|message| format!("[{}] {}", message.role.as_str(), message.content))
        .collect();
    while lines.len() > 1 && lines.join("\n\n").chars().count() > max_chars {
        lines.remove(0);
    }
    lines.join("\n\n")
}

/// 上一结算边界消息 id（§3 归属起点）：触发消息之前最近一条含场景线的消息
/// （上一道 `---` 所在行），没有 → 0（从头归属）。已归属的历史消息因此不会被重挂。
pub(crate) fn boundary_message_id(history: &[Message], upto_id: i64) -> i64 {
    history
        .iter()
        .rev()
        .filter(|message| message.id < upto_id)
        .find(|message| contains_scene_line(&message.content))
        .map(|message| message.id)
        .unwrap_or(0)
}

/// 归一后的裁决 → 单事务写入包：边界快照场景行 + 上一行回写 + 消息归属 + 状态清算。
fn build_write(
    session_id: i64,
    verdict: &SettlementVerdict,
    latest: Option<&Scene>,
    states: &[CharacterState],
    boundary_id: i64,
    trigger_id: i64,
    calendar: &fiction_time::CalendarConfig,
) -> SettlementWrite {
    let close_scene_id = latest.map(|scene| scene.id);
    let date_label = verdict
        .fic_day
        .map(|day| fiction_time::date_label(calendar, day, verdict.fic_part.as_deref().unwrap_or("")));
    let scene = NewScene {
        session_id,
        location: verdict.location.clone(),
        time_note: verdict.time_note.clone(),
        fic_day: verdict.fic_day,
        fic_part: verdict.fic_part.clone(),
        date_label,
        // 边界快照只属于被收束的场景（2026-09-12 裁决修订）：新行是「进行中场景」的
        // header，summary / recap 恒 None——不携带上一场的裁决文本。行上两档的唯一来源
        // = 它自己被收束时的 close_* 回写；模型未产出（None）时字段缺失自然省略，
        // 不会像旧预填方案那样把上一场的文本冻结在行上（陈旧 recap/summary 错位），
        // 结算 prompt 读到的 latest recap 也不再可能是上一场的残留。
        summary: None,
        recap: None,
        present: verdict.present.clone(),
    };
    let attach = close_scene_id.map(|scene_id| AttachRange {
        scene_id,
        after_message_id: boundary_id,
        upto_message_id: trigger_id,
    });
    let state_upserts = verdict
        .upserts
        .iter()
        .map(|upsert| NewCharacterState {
            instance_id: upsert.instance_id,
            scope: upsert.scope,
            key: upsert.key.clone(),
            value: upsert.value.clone(),
            expiry: upsert.expiry.clone(),
            source_scene: close_scene_id,
        })
        .collect();
    // clear 语义键 → 在世状态行 id；键已不存在（重复清除 / 从未上账）→ 幂等跳过。
    let state_clears = verdict
        .clears
        .iter()
        .filter_map(|(instance_id, key)| {
            states
                .iter()
                .find(|state| state.instance_id == *instance_id && state.key == *key)
                .map(|state| state.id)
        })
        .collect();
    SettlementWrite {
        scene,
        close_scene_id,
        // 边界快照（§7-1）：裁决两档只回写上一行，使上一行与其归属消息自洽；
        // 无上一行（开场即结算）时两者皆 None，裁决文本不落任何行。
        close_summary: verdict.summary.clone().filter(|_| close_scene_id.is_some()),
        // Task-03 桥场加厚：recap 随 summary 同路径回写上一行；None → COALESCE 不动
        // 既有值（预填废除后，行上不再存在需要被 COALESCE「保住」的外来残留）。
        close_recap: verdict.recap.clone().filter(|_| close_scene_id.is_some()),
        attach,
        state_upserts,
        state_clears,
    }
}

/// 结算输入的库侧收集结果：会话 / 实例阵容 / 消息史 / 状态集 / 最后场景。
type GatheredInput = (Session, Vec<CharacterInstance>, Vec<Message>, Vec<CharacterState>, Option<Scene>);

fn gather_input(deps: &GenerationDeps, session_id: i64) -> Result<GatheredInput, StorageError> {
    let session = deps.storage.get_session(session_id)?;
    let instances = deps.storage.list_instances(session_id)?;
    let history = deps.storage.list_messages(session_id)?;
    let states = deps.storage.list_character_states(session_id)?;
    let latest = deps.storage.latest_scene(session_id)?;
    Ok((session, instances, history, states, latest))
}

/// 一次结算编排（FR-011 / ADR-005）：由生成闭环在 assistant 落库成功后、done 放行前调用。
///
/// - `director_llm` 未配置（None）→ 静默跳过（INT-003：导演是可选能力）；
/// - 结构级失败（JSON / serde / 落库）→ 退避重试直到成功（无硬上限，输入不变幂等），
///   每轮间隔与退避等待可被取消打断；
/// - 被取消 / 库读取失败 → 本轮放弃，欠账处理见 §7-2：留缺口、下次 `---` 触发时因输入
///   携带全量状态集与叙事窗口而部分自愈（v1 已知并接受，代码即记录）；
/// - 成功即单事务落库（未成功的结算无副作用，INT-003）。
pub async fn run_settlement(deps: &GenerationDeps, ticket: &GenerationTicket, trigger: &Message) {
    let Some(llm) = deps.director_llm.clone() else {
        return;
    };
    // BR-006 触发判定：assistant 正文命中场景线（--- / === / ——，整行）才结算；
    // 取消 / 失败路径根本不会进入本函数（半条不是完整叙事，触发主体不存在）。
    if !contains_scene_line(&trigger.content) {
        return;
    }
    let session_id = ticket.session_id;
    let Ok((session, instances, history, states, latest)) = gather_input(deps, session_id) else {
        log::warn!("会话 #{session_id} 结算输入读取失败，本轮放弃（欠账由下次结算自愈）");
        return;
    };
    let calendar = fiction_time::parse(session.calendar_config.as_deref());
    // §7-7 多角色化：在场名单 = 全部会话实例，roster 序 = 实例创建序（id ASC，
    // 与开场锚行 present 同序；list_instances 的用户位在前的展示序只属 UI 侧）。
    // 裁决的 present 恒回填名单（迁移 0009 起在场语义 = 实例）。
    let mut ordered = instances;
    ordered.sort_by_key(|i| i.id);
    let roster: Vec<(i64, String)> =
        ordered.iter().map(|i| (i.id, i.name.clone())).collect();
    let roster_ids: Vec<i64> = roster.iter().map(|(id, _)| *id).collect();
    // §7-4：单条消息多道 `---` 只结算一次（取最后一道）——触发消息即边界，
    // 归属起点取上一道场景线所在消息。
    let boundary_id = boundary_message_id(&history, trigger.id);
    let narrative = narrative_window(&history, NARRATIVE_MAX_CHARS);
    let prompt = assemble_prompt(&SettlementInput {
        roster: &roster,
        latest_scene: latest.as_ref(),
        states: &states,
        calendar: &calendar,
        narrative: &narrative,
    });

    let mut backoff_ms = BACKOFF_INITIAL_MS;
    let mut failures: u32 = 0;
    // 调用轨迹接线（透明化功能）：结算裁决的每次 complete_json（含修正重试的每次
    // 尝试）在网关内各记一条 director 轨迹（每次 HTTP 请求 = 一条）。
    let trace = CallTrace { session_id: Some(session_id), kind: LlmCallKind::Director };
    loop {
        if ticket.cancel_handle().is_cancelled() {
            log::warn!("会话 #{session_id} 结算被用户打断，本轮放弃（欠账由下次结算自愈）");
            return;
        }
        match llm.complete_json::<DirectorVerdict>(&prompt, Some(&trace)).await {
            Ok(raw) => {
                let verdict = normalize(&raw, &roster_ids, latest.as_ref());
                let write = build_write(
                    session_id,
                    &verdict,
                    latest.as_ref(),
                    &states,
                    boundary_id,
                    trigger.id,
                    &calendar,
                );
                match deps.storage.commit_settlement(&write) {
                    Ok(_) => return,
                    Err(error) => note_failure(&error, &mut failures, backoff_ms),
                }
            }
            Err(error) => note_failure(&error, &mut failures, backoff_ms),
        }
        // 退避等待（tokio 未开 time feature：spawn_blocking 阻塞睡眠兜底，同 llm.rs backoff）；
        // 等待期间可被取消打断（ADR-005「用户可打断退出等待」，done 随后放行、正文无损）。
        let ms = backoff_ms;
        let waited = tokio::task::spawn_blocking(move || {
            std::thread::sleep(std::time::Duration::from_millis(ms));
        });
        tokio::select! {
            _ = waited => {}
            _ = ticket.cancel_handle().wait() => {
                log::warn!("会话 #{session_id} 结算重试等待中被取消，本轮放弃（欠账由下次结算自愈）");
                return;
            }
        }
        backoff_ms = backoff_ms.saturating_mul(2).min(BACKOFF_MAX_MS);
    }
}

/// §7-6：重试不设上限、无降级路径，一期只做日志——每满 3 次连续失败 error 一条
/// （错误后果级：结算持续失败不可自愈时只能靠人看日志介入）。
fn note_failure(error: impl std::fmt::Display, failures: &mut u32, backoff_ms: u64) {
    *failures += 1;
    if *failures % LOG_EVERY_N_FAILURES == 0 {
        log::error!(
            "结算已连续失败 {failures} 次（ADR-005 重试直到成功，当前退避 {backoff_ms}ms）：{error}"
        );
    }
}


#[cfg(test)]
mod tests;
