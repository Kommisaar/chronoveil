//! 导演服务（CMP-004）：结算编排（ADR-005 线性阻塞，重试直到成功才推进）、开局包（FR-014）。
//!
//! 本切片实现 FR-011 结算链路，分两半：
//! - **纯函数半**（本文件上半）：场景线触发判定（与渲染引擎逐字对齐）、导演裁决的
//!   serde 类型与字段级容错（normalize）——全部可离线单测；
//! - **编排半**（文件下半）：[`resolve_director_llm`] → prompt 装配 → [`run_settlement`]
//!   （complete_json → normalize → commit_settlement，退避重试 + 可打断）。
//!
//! ADR-005 线性阻塞的落地：结算由生成闭环在「assistant 落库之后、done 放行之前」调用
//! （done 事件被终态闸门扣住），「结算成功才推进下一拍」由构造保证；重试期间 done 一直
//! 扣着，前端流式态自然停留在等待（与正文生成同等对待）。取消 / 失败路径不结算
//! （半条不是完整叙事，BR-006 的触发主体不存在）。

use serde::Deserialize;

use crate::domain::error::StorageError;
use crate::domain::fiction_time;
use crate::domain::models::{
    Character, CharacterState, CharacterStateScope, Message, NewCharacterState, NewScene, Scene,
    Session,
};
use crate::domain::ports::{AttachRange, SettlementWrite};
use crate::domain::state_expiry;
use crate::infra::config::Config as FileConfig;
use crate::infra::llm::{ChatMessage, ChatRole, LlmClient, LlmConfig};
use crate::services::generation::{GenerationDeps, GenerationTicket};

// ---------------------------------------------------------------------------
// 触发判定（§1：与渲染引擎逐字对齐，v1 一条消息一次结算）
// ---------------------------------------------------------------------------

/// 场景线整行判定（对齐渲染引擎 `src/engine/parser.ts:20` 的 SCENE_LINE_RE：
/// `/^\s*(-{3,}|={3,}|—{2,})\s*$/`）——**必须整行匹配**：行内破折号（如「他说——走了」）
/// 与两道以下的短线不是场景线。正文任一行命中即触发结算；单条消息多道 `---` 只结算
/// 一次、取最后一道边界（§7-4，v1 收窄）。
pub fn contains_scene_line(text: &str) -> bool {
    text.lines().any(is_scene_line)
}

/// 单行判定：去首尾空白后为单一划线字符的连续段（`-`/`=` ≥ 3 个，`—` ≥ 2 个）。
/// 与正则 `^\s*(...)\s*$` 等价——混入其他字符（含两类划线混排）即不匹配。
fn is_scene_line(line: &str) -> bool {
    let trimmed = line.trim();
    let Some(first) = trimmed.chars().next() else {
        return false; // 空行
    };
    let (min_run, uniform) = match first {
        '-' => (3, trimmed.chars().all(|c| c == '-')),
        '=' => (3, trimmed.chars().all(|c| c == '=')),
        '—' => (2, trimmed.chars().all(|c| c == '—')),
        _ => return false,
    };
    uniform && trimmed.chars().count() >= min_run
}

// ---------------------------------------------------------------------------
// 导演裁决类型（§2：LLM 输出 JSON schema，serde 内部类型非 wire DTO）
// ---------------------------------------------------------------------------

/// 导演裁决原始输出。键与 system 指令给出的示例一致（snake_case）；字段全部宽松缺省
/// ——缺键不报错，值域修正交给 [`normalize`]（字段级容错不重试）；
/// 结构级失败（serde 拒绝）才整次重试（INT-003：不做静默降级）。
///
/// `date_label` 不向模型索取——它是记账层之上的命名缓存（FR-013），由
/// [`fiction_time::date_label`] 从 (fic_day, calendar_config) 派生。
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct DirectorVerdict {
    pub location: Option<String>,
    pub time_note: Option<String>,
    pub fic_day: Option<i64>,
    pub fic_part: Option<String>,
    pub summary: Option<String>,
    /// 桥场加厚回顾（Task-03）：对收束的上一场景产出的两三句回顾，summary 保持一行；
    /// 缺失 / 空白 → None 不重试（字段级容错，同 summary）。
    pub recap: Option<String>,
    #[serde(default)]
    pub present: Vec<i64>,
    #[serde(default)]
    pub states: Vec<StateOp>,
}

/// 状态操作二态（INT-003）：upsert 写值 / clear 软删同名键。
/// untagged 按序匹配：含 scope/key/value 判 upsert；只含 character_id + clear 判清除。
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum StateOp {
    Upsert {
        character_id: i64,
        scope: String,
        key: String,
        value: String,
        #[serde(default)]
        expiry: Option<String>,
    },
    Clear {
        character_id: i64,
        /// 要清除的状态键名（wire 形态 `{"character_id": 1, "clear": "别扭"}`）。
        clear: String,
    },
}

/// 归一后的状态写入（字段级容错完成；session_id 由编排层补齐成 `NewCharacterState`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateUpsert {
    pub character_id: i64,
    pub scope: CharacterStateScope,
    pub key: String,
    pub value: String,
    pub expiry: Option<String>,
}

/// 归一后的裁决（[`normalize`] 产出）：值域已修正、roster 外引用已丢弃、
/// fic_day 已钳制、fic_part 已过六值校验、present 已按 v1 收窄。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SettlementVerdict {
    pub location: Option<String>,
    pub time_note: Option<String>,
    pub fic_day: Option<i64>,
    pub fic_part: Option<String>,
    pub summary: Option<String>,
    pub recap: Option<String>,
    pub present: Vec<i64>,
    pub upserts: Vec<StateUpsert>,
    /// (character_id, key)：编排层映射到在世状态行 id 后走 soft_delete。
    pub clears: Vec<(i64, String)>,
}

/// 字段级容错（§2，值域修正、不重试）：
/// - location / time_note / summary / recap：缺失或空白 → None（列可空）；
/// - fic_day：缺失 → 沿用 latest.fic_day（不推进）；小于账本位 → 钳到账本位（BR-003 单调）；
/// - fic_part：不在六值 → None；
/// - present / states 引用 roster 外 character_id、scope 非法 → 丢弃该条继续（配合
///   system 指令与 roster 输入，发生概率低，不值得整次重试烧一次调用）；
/// - expiry：非三义 → None（形态由结算层定，见 state_expiry；语义等价「无过期信息」）。
///
/// present 按 §7-7 v1 收窄：多角色 roster 数据模型未落地，在场恒为 roster
/// （即 `[session.character_id]`）；模型输出的 present 仅作 schema 占位，校验不扩展。
pub fn normalize(raw: &DirectorVerdict, roster: &[i64], latest: Option<&Scene>) -> SettlementVerdict {
    // 文本字段统一 trim；空白视为缺失。
    let clean = |value: &Option<String>| {
        value.as_deref().map(str::trim).filter(|text| !text.is_empty()).map(str::to_string)
    };
    let ledger_day = latest.and_then(|scene| scene.fic_day);
    let fic_day = match raw.fic_day {
        None => ledger_day,
        Some(day) => Some(fiction_time::clamp_day(day, ledger_day)),
    };
    let fic_part = raw
        .fic_part
        .as_deref()
        .map(str::trim)
        .filter(|part| fiction_time::is_valid_part(part))
        .map(str::to_string);

    let mut upserts = Vec::new();
    let mut clears = Vec::new();
    for op in &raw.states {
        match op {
            StateOp::Upsert { character_id, scope, key, value, expiry } => {
                if !roster.contains(character_id) {
                    continue;
                }
                // scope 非法（三态之外）→ 丢条；键值空白 → 同为模型噪声，丢条。
                let Ok(scope) = CharacterStateScope::from_db(scope.trim()) else {
                    continue;
                };
                let (key, value) = (key.trim(), value.trim());
                if key.is_empty() || value.is_empty() {
                    continue;
                }
                let expiry = expiry
                    .as_deref()
                    .map(str::trim)
                    .filter(|expiry| !expiry.is_empty() && state_expiry::is_valid(expiry))
                    .map(str::to_string);
                upserts.push(StateUpsert {
                    character_id: *character_id,
                    scope,
                    key: key.to_string(),
                    value: value.to_string(),
                    expiry,
                });
            }
            StateOp::Clear { character_id, clear } => {
                if !roster.contains(character_id) {
                    continue;
                }
                let key = clear.trim();
                if key.is_empty() {
                    continue;
                }
                clears.push((*character_id, key.to_string()));
            }
        }
    }

    SettlementVerdict {
        location: clean(&raw.location),
        time_note: clean(&raw.time_note),
        fic_day,
        fic_part,
        summary: clean(&raw.summary),
        recap: clean(&raw.recap),
        present: roster.to_vec(),
        upserts,
        clears,
    }
}

// ---------------------------------------------------------------------------
// 编排半：模型解析 → prompt 装配 → 结算循环（ADR-005 重试直到成功，可打断）
// ---------------------------------------------------------------------------

/// 结算重试退避（§2：500ms 起 ×2 指数、封顶 8s，对齐 `RetryPolicy::default` 节奏；
/// 循环责任在调用方，`complete_json` 单次尝试自持 read_timeout 兜底不永久挂起）。
const BACKOFF_INITIAL_MS: u64 = 500;
const BACKOFF_MAX_MS: u64 = 8_000;
/// 连续失败日志节流（§7-6：一期只做日志，每满 3 次连续失败 eprintln 一条）。
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
3. 状态清算：维护 states。增改状态用 {\"character_id\":…,\"scope\":\"state|relation\",\"key\":…,\"value\":…,\"expiry\":…}；清除状态用 {\"character_id\":…,\"clear\":\"键名\"}。硬规则：value 用叙事语言、绝不用数字；在册总条数保持 10 条以内，超出时合并或清除最陈旧的；expiry 三义取其一：scene_end（下次场景收束失效）/ event:事件名 / manual（仅手动清除）。
4. 时间换算：给出 fic_day（第几天，整数）与 fic_part（六值之一：清晨/上午/午后/黄昏/夜/深夜）。模糊时间（「次日」「片刻后」）取最小合理值，并把准确的叙事时间写进 time_note。虚时只被叙事推进，绝不倒流：fic_day 不得小于当前账本位。

输出格式（缺失字段用 null）：
{\"location\":\"…\",\"time_note\":\"…\",\"fic_day\":2,\"fic_part\":\"夜\",\"summary\":\"…\",\"recap\":\"…\",\"present\":[角色id],\"states\":[{\"character_id\":1,\"scope\":\"state\",\"key\":\"情绪\",\"value\":\"释然\",\"expiry\":\"scene_end\"}]}"
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
                    state.character_id,
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

    // 3) 在场名单（§7-7：v1 恒为会话角色）。
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
            character_id: upsert.character_id,
            session_id,
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
        .filter_map(|(character_id, key)| {
            states
                .iter()
                .find(|state| state.character_id == *character_id && state.key == *key)
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

/// 结算输入的库侧收集结果：会话 / 角色 / 消息史 / 状态集 / 最后场景。
type GatheredInput = (Session, Character, Vec<Message>, Vec<CharacterState>, Option<Scene>);

fn gather_input(deps: &GenerationDeps, session_id: i64) -> Result<GatheredInput, StorageError> {
    let session = deps.storage.get_session(session_id)?;
    let character = deps.storage.get_character(session.character_id)?;
    let history = deps.storage.list_messages(session_id)?;
    let states = deps.storage.list_character_states(session_id)?;
    let latest = deps.storage.latest_scene(session_id)?;
    Ok((session, character, history, states, latest))
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
    let Ok((session, character, history, states, latest)) = gather_input(deps, session_id) else {
        eprintln!("[director] 会话 #{session_id} 结算输入读取失败，本轮放弃（欠账由下次结算自愈）");
        return;
    };
    let calendar = fiction_time::parse(session.calendar_config.as_deref());
    // §7-7：v1 在场名单恒为 [会话角色]（多角色 roster 数据模型未落地）。
    let roster = vec![(character.id, character.name.clone())];
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
    loop {
        if ticket.cancel_handle().is_cancelled() {
            eprintln!("[director] 会话 #{session_id} 结算被用户打断，本轮放弃（欠账由下次结算自愈）");
            return;
        }
        match llm.complete_json::<DirectorVerdict>(&prompt).await {
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
                eprintln!("[director] 会话 #{session_id} 结算重试等待中被取消，本轮放弃（欠账由下次结算自愈）");
                return;
            }
        }
        backoff_ms = backoff_ms.saturating_mul(2).min(BACKOFF_MAX_MS);
    }
}

/// §7-6：重试不设上限、无降级路径，一期只做日志——每满 3 次连续失败 eprintln 一条
/// （风格同 generation.rs 的 eprintln 日志）。
fn note_failure(error: impl std::fmt::Display, failures: &mut u32, backoff_ms: u64) {
    *failures += 1;
    if *failures % LOG_EVERY_N_FAILURES == 0 {
        eprintln!(
            "[director] 结算已连续失败 {failures} 次（ADR-005 重试直到成功，当前退避 {backoff_ms}ms）：{error}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- 触发判定：与引擎正则逐字对齐 ----

    #[test]
    fn scene_line_matches_engine_regex_verbatim() {
        // 三种划线的最小与超长形态。
        for line in ["---", "----", "----------", "===", "=====", "——", "———"] {
            assert!(contains_scene_line(line), "「{line}」应为场景线");
        }
        // 首尾空白容忍（^\s* … \s*$）。
        for line in ["  ---  ", "\t===\t", " —— "] {
            assert!(contains_scene_line(line), "「{line}」应为场景线（空白容忍）");
        }
    }

    #[test]
    fn scene_line_rejects_non_line_matches() {
        for line in [
            "",              // 空行
            " ",             // 纯空白
            "--",            // 短线不足 3
            "==",            // 同上
            "—",             // 破折号不足 2
            "- - -",         // 夹空白不成连续段
            "--==",          // 划线混排
            "-x-",           // 杂字符
            "正文 ---",      // 行内破折号不是场景线（整行匹配）
            "--- 正文",
            "他说——走了",   // 叙事内破折号
            "‐‐‐",          // 其他 Unicode 划线（U+2010）不在值域
        ] {
            assert!(!contains_scene_line(line), "「{line}」不应为场景线");
        }
    }

    #[test]
    fn scene_line_detected_among_multiline_text() {
        let text = "她抬起头。\n\n---\n\n书店的门被推开。";
        assert!(contains_scene_line(text));
        assert!(contains_scene_line("第一段\r\n---\r\n尾段"), "容忍 CRLF 行尾");
        assert!(!contains_scene_line("没有场景线的普通正文。"));
    }

    // ---- 裁决反序列化：untagged 二态 + 宽松缺省 ----

    #[test]
    fn verdict_parses_memo_example_verbatim() {
        let raw: DirectorVerdict = serde_json::from_str(
            r#"{
              "location": "旧书店 · 打烊后",
              "time_note": "次日清晨",
              "fic_day": 2,
              "fic_part": "夜",
              "summary": "昨夜争执后两人无言告别",
              "present": [1],
              "states": [
                { "character_id": 1, "scope": "state", "key": "情绪", "value": "释然", "expiry": "scene_end" },
                { "character_id": 1, "clear": "别扭" }
              ]
            }"#,
        )
        .unwrap();
        assert_eq!(raw.location.as_deref(), Some("旧书店 · 打烊后"));
        assert_eq!(raw.states.len(), 2);
        assert!(matches!(raw.states[0], StateOp::Upsert { expiry: Some(ref e), .. } if e == "scene_end"));
        assert!(matches!(&raw.states[1], StateOp::Clear { clear, .. } if clear == "别扭"));
    }

    #[test]
    fn verdict_tolerates_missing_optional_fields() {
        let raw: DirectorVerdict = serde_json::from_str(r#"{"summary": "只有一句"}"#).unwrap();
        assert_eq!(raw.location, None);
        assert!(raw.present.is_empty());
        assert!(raw.states.is_empty());
    }

    #[test]
    fn verdict_rejects_structural_garbage() {
        // states 元素两种形态都不满足 → serde 拒绝 → 结构级失败（调用方整次重试）。
        assert!(serde_json::from_str::<DirectorVerdict>(r#"{"states": [{"character_id": 1}]}"#).is_err());
        // fic_day 类型不符 → 结构级失败。
        assert!(serde_json::from_str::<DirectorVerdict>(r#"{"fic_day": "第二天"}"#).is_err());
    }

    // ---- normalize：字段级容错 ----

    fn scene(fic_day: Option<i64>) -> Scene {
        Scene {
            id: 10,
            session_id: 1,
            idx: 0,
            location: Some("钟楼下".into()),
            time_note: None,
            fic_day,
            fic_part: Some("夜".into()),
            date_label: None,
            summary: Some("开场".into()),
            recap: None,
            present: vec![1],
            deleted_at: None,
        }
    }

    fn normalize_json(payload: &str, latest: Option<&Scene>) -> SettlementVerdict {
        let raw: DirectorVerdict = serde_json::from_str(payload).unwrap();
        normalize(&raw, &[1], latest)
    }

    #[test]
    fn normalize_passes_clean_verdict_through() {
        let verdict = normalize_json(
            r#"{
                "location": "旧书店",
                "time_note": "次日清晨",
                "fic_day": 2,
                "fic_part": "清晨",
                "summary": "争执后告别",
                "present": [1, 999],
                "states": [
                    {"character_id": 1, "scope": "state", "key": "情绪", "value": "释然", "expiry": "event:亮灯"},
                    {"character_id": 1, "scope": "relation", "key": "对店主", "value": "信任"},
                    {"character_id": 1, "clear": "别扭"}
                ]
            }"#,
            Some(&scene(Some(1))),
        );
        assert_eq!(verdict.location.as_deref(), Some("旧书店"));
        assert_eq!(verdict.fic_day, Some(2));
        assert_eq!(verdict.fic_part.as_deref(), Some("清晨"));
        assert_eq!(verdict.summary.as_deref(), Some("争执后告别"));
        assert_eq!(verdict.present, vec![1], "§7-7：v1 在场恒为 roster");
        assert_eq!(verdict.upserts.len(), 2);
        assert_eq!(verdict.upserts[0].scope, CharacterStateScope::State);
        assert_eq!(verdict.upserts[0].expiry.as_deref(), Some("event:亮灯"));
        assert_eq!(verdict.upserts[1].scope, CharacterStateScope::Relation);
        assert_eq!(verdict.upserts[1].expiry, None, "缺 expiry → None");
        assert_eq!(verdict.clears, vec![(1, "别扭".to_string())]);
    }

    #[test]
    fn normalize_repairs_field_level_noise() {
        let verdict = normalize_json(
            r#"{
                "location": "   ",
                "time_note": null,
                "fic_part": "半夜三更",
                "summary": "  带空白的摘要  ",
                "states": [
                    {"character_id": 1, "scope": "mood", "key": "情绪", "value": "释然"},
                    {"character_id": 1, "scope": "state", "key": "  ", "value": "释然"},
                    {"character_id": 1, "scope": "state", "key": "持有", "value": " "},
                    {"character_id": 1, "scope": "state", "key": "情绪", "value": "平静", "expiry": "明天"},
                    {"character_id": 1, "scope": "state", "key": "衣着", "value": "斗篷", "expiry": "  "}
                ]
            }"#,
            None,
        );
        assert_eq!(verdict.location, None, "空白文本字段 → None（列可空）");
        assert_eq!(verdict.time_note, None);
        assert_eq!(verdict.summary.as_deref(), Some("带空白的摘要"), "trim 后非空保留");
        assert_eq!(verdict.fic_part, None, "六值之外 → None（不重试）");
        // 丢条：scope 非法、键空白、值空白（无法修正）。
        // 值域修正保留条目：expiry 非三义 / 空白 → None（形态由结算层定，语义等价无过期信息）。
        assert_eq!(verdict.upserts.len(), 2, "实际：{:?}", verdict.upserts);
        assert_eq!(verdict.upserts[0].key, "情绪");
        assert_eq!(verdict.upserts[0].value, "平静");
        assert_eq!(verdict.upserts[0].expiry, None, "非三义 expiry 修正为 None");
        assert_eq!(verdict.upserts[1].key, "衣着");
        assert_eq!(verdict.upserts[1].expiry, None, "空白 expiry 修正为 None");
    }

    #[test]
    fn normalize_drops_references_outside_roster() {
        let verdict = normalize_json(
            r#"{
                "present": [999],
                "states": [
                    {"character_id": 999, "scope": "state", "key": "情绪", "value": "串场"},
                    {"character_id": 999, "clear": "别扭"},
                    {"character_id": 1, "scope": "state", "key": "情绪", "value": "守场"}
                ]
            }"#,
            None,
        );
        assert_eq!(verdict.present, vec![1], "在场恒为 roster（§7-7）");
        assert_eq!(verdict.upserts.len(), 1, "roster 外 upsert 丢条");
        assert_eq!(verdict.upserts[0].key, "情绪");
        assert!(verdict.clears.is_empty(), "roster 外 clear 丢条");
    }

    #[test]
    fn normalize_keeps_ledger_monotonic() {
        let latest = scene(Some(5));
        // 缺失 → 沿用账本位（不推进）。
        assert_eq!(normalize_json(r#"{"summary": "s"}"#, Some(&latest)).fic_day, Some(5));
        // 倒流 → 钳到账本位（BR-003）。
        let back = normalize_json(r#"{"fic_day": 3, "summary": "s"}"#, Some(&latest));
        assert_eq!(back.fic_day, Some(5));
        // 正常推进放行；无账本原样通过。
        assert_eq!(normalize_json(r#"{"fic_day": 6, "summary": "s"}"#, Some(&latest)).fic_day, Some(6));
        assert_eq!(normalize_json(r#"{"fic_day": 1, "summary": "s"}"#, None).fic_day, Some(1));
    }

    #[test]
    fn normalize_empty_states_is_noop() {
        let verdict = normalize_json(r#"{"location": "x"}"#, None);
        assert!(verdict.upserts.is_empty());
        assert!(verdict.clears.is_empty());
    }

    // ---- Task-03：recap 两档（有值 / 缺失→None / 空白→None） ----

    #[test]
    fn normalize_keeps_recap_when_present() {
        // verdict 反序列化：recap 键存在且非空 → 透传。
        let raw: DirectorVerdict = serde_json::from_str(
            r#"{"summary": "争执后告别", "recap": "争执从误口信开始。两人隔柜沉默。最后她留伞走进雨夜。"}"#,
        )
        .unwrap();
        assert_eq!(
            raw.recap.as_deref(),
            Some("争执从误口信开始。两人隔柜沉默。最后她留伞走进雨夜。")
        );
        // normalize：trim 后非空保留。
        let verdict = normalize(&raw, &[1], None);
        assert_eq!(verdict.summary.as_deref(), Some("争执后告别"));
        assert_eq!(
            verdict.recap.as_deref(),
            Some("争执从误口信开始。两人隔柜沉默。最后她留伞走进雨夜。")
        );
    }

    #[test]
    fn normalize_recap_missing_or_blank_is_none_without_retry() {
        // 键缺失 → None（serde 宽松缺省，不报错）。
        let missing = normalize_json(r#"{"summary": "只有一句"}"#, None);
        assert_eq!(missing.recap, None, "缺失 recap → None（不是错误）");
        // 空白 → None（字段级容错，同 summary）。
        let blank = normalize_json(r#"{"summary": "s", "recap": "   "}"#, None);
        assert_eq!(blank.recap, None, "空白 recap 修正为 None");
        assert_eq!(blank.summary.as_deref(), Some("s"), "summary 不受 recap 噪声影响");
    }

    /// Task-03 裁决修订（2026-09-12）：边界快照只属于被收束的场景——summary / recap
    /// 仅回写上一行（COALESCE），新行（进行中场景 header）两档恒 None；
    /// 开场即结算（无上一行）时 close_* 全 None，裁决两档不落任何行。
    #[test]
    fn build_write_backfills_previous_row_without_prefilling_new_row() {
        let calendar = fiction_time::CalendarConfig::default();
        let verdict = normalize_json(
            r#"{"location":"旧书店","fic_day":2,"fic_part":"清晨","summary":"钟楼下的对峙无果而终","recap":"对峙从一句口信误会开始。两人隔着巷口的灯沉默对望。最后谁也没先开口。"}"#,
            Some(&scene(Some(1))),
        );
        // 有上一行：close_summary / close_recap 回写上一行（scene() 夹具 id = 10），
        // 新行两档恒 None——预填已废除（消陈旧 recap/summary 错位）。
        let write = build_write(7, &verdict, Some(&scene(Some(1))), &[], 2, 5, &calendar);
        assert_eq!(write.scene.summary, None, "新行不再预填 summary");
        assert_eq!(write.scene.recap, None, "新行不再预填 recap");
        assert_eq!(write.close_scene_id, Some(10));
        assert_eq!(write.close_summary, verdict.summary);
        assert_eq!(write.close_recap, verdict.recap, "recap 随 summary 同路径回写上一行");
        // 开场即结算（无上一行）：close_* 全 None，两档裁决不落任何行。
        let first = build_write(7, &verdict, None, &[], 0, 5, &calendar);
        assert_eq!(first.close_scene_id, None);
        assert_eq!(first.close_summary, None);
        assert_eq!(first.close_recap, None);
        assert_eq!(first.scene.summary, None);
        assert_eq!(first.scene.recap, None);
    }

    // ---- 编排半：模型解析 / prompt 装配（纯函数） ----

    fn config_with_provider(models: &[&str], director: Option<&str>) -> FileConfig {
        FileConfig {
            providers: vec![crate::infra::config::ProviderConfig {
                id: "p1".into(),
                name: "主".into(),
                base_url: "https://main.example/v1".into(),
                api_key: "k1".into(),
                models: models.iter().map(|m| m.to_string()).collect(),
                model: None,
            }],
            active_provider_id: Some("p1".into()),
            active_model: Some("m1".into()),
            director_model: director.map(str::to_string),
            ..FileConfig::new_with_defaults()
        }
    }

    #[test]
    fn resolve_director_llm_follows_main_model_without_character_override() {
        // INT-003 / §7-5：director_model 空 = 跟随主模型；不做角色级覆写（本函数无角色入参）。
        let client = resolve_director_llm(&config_with_provider(&["m1", "m2"], None)).unwrap();
        assert_eq!(client.config().model, "m1");
        assert_eq!(client.config().base_url, "https://main.example/v1");

        let explicit =
            resolve_director_llm(&config_with_provider(&["m1"], Some("director-only"))).unwrap();
        assert_eq!(explicit.config().model, "director-only");
    }

    #[test]
    fn resolve_director_llm_fails_without_configuration() {
        let bare = FileConfig::new_with_defaults();
        let err = resolve_director_llm(&bare).unwrap_err();
        assert!(err.contains("未配置"), "{err}");

        // 悬空 active id：active_provider 为 None。
        let dangling = config_with_provider(&["m1"], None);
        let mut dangling = dangling;
        dangling.active_provider_id = Some("ghost".into());
        assert!(resolve_director_llm(&dangling).is_err());
    }

    #[test]
    fn narrative_window_takes_latest_k_and_trims_oldest() {
        let history: Vec<Message> = (0..10)
            .map(|i| {
                let role =
                    if i % 2 == 0 { crate::domain::models::MessageRole::User } else { crate::domain::models::MessageRole::Assistant };
                Message { id: i + 1, session_id: 1, role, content: format!("m{i}"), reasoning: None, think_ms: None, tokens: None, created_at: i, interrupt_flag: None, scene_id: None, deleted_at: None }
            })
            .collect();
        let window = narrative_window(&history, 6_000);
        assert!(window.contains("[user] m8"), "触发消息（最后一条）必须在内：{window}");
        assert!(window.contains("m3") && !window.contains("m2"), "触发 + 其前 6 条（K=6）");
        assert!(!window.contains("m0"));

        // 总长超限：从最旧侧整条丢弃，直至不超上限。
        let long = "字".repeat(2_500);
        let long_history: Vec<Message> = (0..5)
            .map(|i| Message {
                id: i + 1,
                session_id: 1,
                role: crate::domain::models::MessageRole::Assistant,
                content: long.clone(),
                reasoning: None,
                think_ms: None,
                tokens: None,
                created_at: i,
                interrupt_flag: None,
                scene_id: None,
                deleted_at: None,
            })
            .collect();
        let window = narrative_window(&long_history, 6_000);
        assert!(window.chars().count() <= 6_000, "超限后从最旧侧截");
    }

    #[test]
    fn boundary_message_id_finds_previous_scene_line() {
        let message = |id: i64, content: &str| Message {
            id,
            session_id: 1,
            role: crate::domain::models::MessageRole::Assistant,
            content: content.into(),
            reasoning: None,
            think_ms: None,
            tokens: None,
            created_at: id,
            interrupt_flag: None,
            scene_id: None,
            deleted_at: None,
        };
        let history = vec![
            message(1, "开场白"),
            message(2, "第一场结尾\n\n---\n\n新场开头"),
            message(3, "过渡段"),
            message(4, "触发消息\n---"),
        ];
        assert_eq!(boundary_message_id(&history, 4), 2, "取触发消息之前最近一道场景线");
        assert_eq!(boundary_message_id(&history, 2), 0, "边界之前无更早场景线 → 0（从头归属）");
        assert_eq!(
            boundary_message_id(&history, 99),
            4,
            "upto 大于所有消息时取最近一道场景线（含触发自身）"
        );
    }

    #[test]
    fn assemble_prompt_sections_are_labeled() {
        let roster = vec![(1, "苏鸢".to_string())];
        // Task-03：上一场快照带 recap 时附「上一场回顾」行。
        let mut latest = scene(Some(1));
        latest.recap = Some("巷口初遇。她提灯替我照了一段路。".into());
        let calendar = fiction_time::CalendarConfig {
            name: Some("白蜡历".into()),
            festivals: std::collections::BTreeMap::from([(7, "灯节".to_string())]),
            ..fiction_time::CalendarConfig::default()
        };
        let input = SettlementInput {
            roster: &roster,
            latest_scene: Some(&latest),
            states: &[],
            calendar: &calendar,
            narrative: "[user] 推门\n\n[assistant] 她抬头。\n\n---",
        };
        let messages = assemble_prompt(&input);
        assert_eq!(messages.len(), 2, "system + 单条 user");
        assert_eq!(messages[0].role, ChatRole::System);
        assert!(messages[0].content.contains("只输出一个 JSON"), "硬规则：只输出 JSON");
        assert!(messages[0].content.contains("scene_end"), "expiry 三义指令");
        assert!(
            messages[0].content.contains("recap") && messages[0].content.contains("两三句"),
            "Task-03：两档摘要指令（summary 一行 + recap 两三句）"
        );

        let user = &messages[1].content;
        assert!(user.starts_with("【上一场快照】"));
        assert!(user.contains("钟楼下"), "上一场地点");
        assert!(
            user.contains("\n上一场回顾：巷口初遇。她提灯替我照了一段路。"),
            "recap 附在上一场摘要之后（Task-03）：{user}"
        );
        assert!(user.contains("【当前状态集】\n（空）"));
        assert!(user.contains("[1] 苏鸢"), "在场名单");
        assert!(user.contains("白蜡历") && user.contains("第7日 灯节"), "日历提示");
        assert!(user.contains("当前账本位：第 1 天 · 夜"), "账本位取自 latest_scene");
        assert!(user.contains("[assistant] 她抬头。"), "叙事原文带角色前缀");
    }

    // ---- 编排集成（Mock HTTP 网关：成功 / Json 失败重试 / cancel 退出） ----

    use crate::domain::models::{NewCharacter, NewMessage, NewSession};
    use crate::domain::ports::StoragePort;
    use crate::infra::llm::mock::{json_body, MockServer};
    use crate::infra::llm::{EventSink, LlmEvent, RetryPolicy};
    use crate::infra::storage::test_support::temp_storage;
    use crate::infra::storage::Storage;
    use crate::services::generation::GenerationRegistry;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    struct NoopSink;
    impl EventSink for NoopSink {
        fn emit(&self, _event: LlmEvent) {}
    }

    fn director_client(url: &str) -> LlmClient {
        LlmClient::new(LlmConfig {
            base_url: url.to_owned(),
            api_key: "test".into(),
            model: "director-model".into(),
            connect_timeout_ms: 2_000,
            read_timeout_ms: 2_000,
            retry: RetryPolicy {
                max_retries: 0,
                initial_backoff_ms: 0,
                backoff_multiplier: 1,
                max_backoff_ms: 0,
            },
        })
        .unwrap()
    }

    /// 结算集成夹具：角色「苏鸢」+ 会话 + user / assistant（含 ---）两条消息，
    /// 返回 (storage, dir, session_id, char_id, trigger_id)。
    fn settlement_setup(tag: &str) -> (Arc<Storage>, PathBuf, i64, i64, i64) {
        let (raw, dir) = temp_storage(tag);
        let storage = Arc::new(raw);
        let char_id = storage
            .create_character(&NewCharacter { name: "苏鸢".into(), ..Default::default() })
            .unwrap()
            .id;
        let session_id = storage
            .create_session(&NewSession { character_id: char_id, title: String::new(), opening: None })
            .unwrap()
            .id;
        storage
            .insert_message(&NewMessage::new(
                session_id,
                crate::domain::models::MessageRole::User,
                "我们沿钟楼下的巷子往北走。",
            ))
            .unwrap();
        let trigger_id = storage
            .insert_message(&NewMessage::new(
                session_id,
                crate::domain::models::MessageRole::Assistant,
                "她停下脚步。\n\n---\n\n书店的门虚掩着。",
            ))
            .unwrap()
            .id;
        (storage, dir, session_id, char_id, trigger_id)
    }

    fn deps_with_director(
        storage: &Arc<Storage>,
        url: &str,
    ) -> GenerationDeps {
        let client = Arc::new(director_client(url));
        GenerationDeps {
            storage: storage.clone(),
            sink: Arc::new(NoopSink),
            llm: client.clone(),
            director_llm: Some(client),
        }
    }

    fn trigger_of(storage: &Storage, session_id: i64) -> Message {
        storage.list_messages(session_id).unwrap().into_iter().last().unwrap()
    }

    /// 成功路径：裁决单事务落库——边界快照新行 + 上一行回写 + 状态 upsert/清除；
    /// prompt payload 携带在场名单、账本位与叙事原文。
    #[tokio::test]
    async fn run_settlement_commits_verdict_in_one_shot() {
        let (storage, dir, session_id, char_id, _trigger_id) = settlement_setup("dir_ok");
        let previous = storage
            .insert_scene(&NewScene {
                session_id,
                location: Some("钟楼下".into()),
                time_note: None,
                fic_day: Some(1),
                fic_part: Some("夜".into()),
                date_label: Some("第1日·夜".into()),
                summary: Some("开场".into()),
                recap: None,
                present: vec![char_id],
            })
            .unwrap();
        let stale = storage
            .upsert_character_state(&NewCharacterState {
                character_id: char_id,
                session_id,
                scope: CharacterStateScope::State,
                key: "别扭".into(),
                value: "欲言又止".into(),
                expiry: None,
                source_scene: None,
            })
            .unwrap();

        let captured: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
        let cap = captured.clone();
        let server = MockServer::start(move |req, stream| {
            cap.lock().unwrap().push(req.json());
            let _ = json_body(
                stream,
                r#"{"location":"旧书店 · 打烊后","time_note":"次日清晨","fic_day":2,"fic_part":"清晨","summary":"钟楼下的对峙无果而终","recap":"对峙从一句口信误会开始。两人在钟楼下的巷口对望。最后她转身走进夜色。","present":[1],"states":[{"character_id":1,"scope":"state","key":"情绪","value":"释然","expiry":"scene_end"},{"character_id":1,"clear":"别扭"}]}"#,
            );
        });

        let registry = GenerationRegistry::new();
        let ticket = registry.begin(session_id).unwrap();
        let trigger = trigger_of(&storage, session_id);
        let deps = deps_with_director(&storage, &server.url());
        run_settlement(&deps, &ticket, &trigger).await;

        // 边界快照新行：idx 自增、四字段 + 派生 date_label + present；
        // summary / recap 恒 None（2026-09-12 裁决修订：新行不再预填裁决两档）。
        // （scenes[0] = 建会话 seed 的开场锚行，FR-014。）
        let scenes = storage.list_scenes(session_id).unwrap();
        assert_eq!(scenes.len(), 3, "开场锚行 + 上一行 + 结算新行");
        let newest = scenes.last().unwrap();
        assert_eq!(newest.idx, previous.idx + 1);
        assert_eq!(newest.location.as_deref(), Some("旧书店 · 打烊后"));
        assert_eq!(newest.time_note.as_deref(), Some("次日清晨"));
        assert_eq!(newest.fic_day, Some(2));
        assert_eq!(newest.fic_part.as_deref(), Some("清晨"));
        assert_eq!(newest.date_label.as_deref(), Some("第2日·清晨"), "date_label 由日历派生");
        assert_eq!(newest.summary, None, "新行不再预填 summary");
        assert_eq!(newest.present, vec![char_id], "§7-7：在场恒为会话角色");
        // 上一行 summary / recap 回写（边界快照：上一行与其归属消息自洽；Task-03 recap
        // 随 summary 同路径）。
        assert_eq!(scenes[1].summary.as_deref(), Some("钟楼下的对峙无果而终"));
        assert_eq!(
            scenes[1].recap.as_deref(),
            Some("对峙从一句口信误会开始。两人在钟楼下的巷口对望。最后她转身走进夜色。"),
            "recap 回写上一行"
        );
        assert_eq!(newest.recap, None, "新行不再预填 recap（消陈旧错位）");
        // 状态清算：upsert 新键（source_scene = 收束场景）、clear 旧键（软删）。
        let states = storage.list_character_states(session_id).unwrap();
        assert_eq!(states.len(), 1, "「别扭」已清除、「情绪」已 upsert");
        assert_eq!(states[0].key, "情绪");
        assert_eq!(states[0].value, "释然");
        assert_eq!(states[0].expiry.as_deref(), Some("scene_end"));
        assert_eq!(states[0].source_scene, Some(previous.id));
        assert!(storage.soft_delete_character_state(stale.id).is_err(), "清除支路已置墓碑");

        // prompt payload：单 system + 单 user，含名单 / 账本位 / 叙事窗口。
        let requests = captured.lock().unwrap().clone();
        assert_eq!(requests.len(), 1, "一次成功结算恰好一次调用");
        let messages = requests[0]["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        let user = messages[1]["content"].as_str().unwrap();
        assert!(user.contains("[1] 苏鸢"), "在场名单：{user}");
        assert!(user.contains("当前账本位：第 1 天 · 夜"), "账本位取自 latest_scene：{user}");
        assert!(user.contains("[user] 我们沿钟楼下的巷子往北走。"), "叙事窗口含触发前消息");
        assert!(user.contains("书店的门虚掩着"), "触发消息全文");
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Json 失败重试至成功（INT-003：解析失败按失败重试，不做静默降级）。
    #[tokio::test]
    async fn run_settlement_retries_bad_json_until_success() {
        let (storage, dir, session_id, _char_id, _trigger_id) = settlement_setup("dir_retry");
        let attempts = Arc::new(AtomicUsize::new(0));
        let counter = attempts.clone();
        let server = MockServer::start(move |_req, stream| {
            let nth = counter.fetch_add(1, Ordering::SeqCst);
            if nth == 0 {
                let _ = json_body(stream, "抱歉，我无法输出 JSON。");
            } else {
                let _ = json_body(
                    stream,
                    r#"{"fic_day":2,"fic_part":"夜","summary":"重试后的裁决","present":[1],"states":[]}"#,
                );
            }
        });

        let registry = GenerationRegistry::new();
        let ticket = registry.begin(session_id).unwrap();
        let trigger = trigger_of(&storage, session_id);
        let deps = deps_with_director(&storage, &server.url());
        run_settlement(&deps, &ticket, &trigger).await;

        assert!(attempts.load(Ordering::SeqCst) >= 2, "Json 失败后必须重试");
        let scenes = storage.list_scenes(session_id).unwrap();
        assert_eq!(
            scenes.len(),
            2,
            "重试成功后恰好结算一次（INT-003 幂等）；scenes[0] = 开场锚行（FR-014）"
        );
        assert_eq!(
            scenes[0].summary.as_deref(),
            Some("重试后的裁决"),
            "裁决回写上一行（此处上一行 = 开场锚行）"
        );
        assert_eq!(scenes[1].summary, None, "新行不再预填 summary");
        assert_eq!(scenes[1].recap, None, "裁决未给 recap → 新行两档缺席（不是错误、不重试）");
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 陈旧残留回归（2026-09-12 裁决修订）：行上 summary / recap 的唯一来源 =
    /// 它自己被收束时的回写，不因预填继承上一场的裁决文本。
    /// 结算 1 产出 recap R1 → 新行 X1 两档缺席；结算 2 无 recap → X1 只收到自己的
    /// summary、recap 保持缺席（旧预填方案会把 R1 冻结在 X1 上，桥场回顾错位到
    /// 上一场），R1 仍只留在锚行；结算 3 产出 recap R3 → X2 正确收到自己的两档。
    #[tokio::test]
    async fn run_settlement_does_not_freeze_previous_recap_on_new_row() {
        let (storage, dir, session_id, _char_id, _trigger_id) = settlement_setup("dir_stale");
        let attempts = Arc::new(AtomicUsize::new(0));
        let counter = attempts.clone();
        let server = MockServer::start(move |_req, stream| {
            let nth = counter.fetch_add(1, Ordering::SeqCst);
            let body = match nth {
                0 => r#"{"location":"巷口","fic_day":2,"summary":"钟楼下的对峙无果而终","recap":"对峙从一句口信误会开始。两人隔着巷口的灯沉默对望。最后谁也没先开口。"}"#,
                1 => r#"{"location":"书店","fic_day":3,"summary":"打烊后的整理与和解"}"#,
                _ => r#"{"location":"码头","fic_day":4,"summary":"雨夜码头的告别","recap":"告别从一封迟到的信开始。两人在雨里把话说尽。最后她先转身。"}"#,
            };
            let _ = json_body(stream, body);
        });

        let registry = GenerationRegistry::new();
        let deps = deps_with_director(&storage, &server.url());
        let mut trigger = trigger_of(&storage, session_id);
        for _ in 0..3 {
            let ticket = registry.begin(session_id).unwrap();
            run_settlement(&deps, &ticket, &trigger).await;
            registry.finish(session_id);
            trigger = storage
                .insert_message(&NewMessage::new(
                    session_id,
                    crate::domain::models::MessageRole::Assistant,
                    "场景推进。\n\n---\n\n下一场开头。",
                ))
                .unwrap();
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 3, "三次结算各一次成功调用");

        // 锚行（idx 0）收到结算 1 回写并保持；其后各行只携带自己被收束时的两档。
        let scenes = storage.list_scenes(session_id).unwrap();
        assert_eq!(scenes.len(), 4, "开场锚行 + 三次结算各一行");
        assert_eq!(scenes[0].summary.as_deref(), Some("钟楼下的对峙无果而终"));
        assert_eq!(
            scenes[0].recap.as_deref(),
            Some("对峙从一句口信误会开始。两人隔着巷口的灯沉默对望。最后谁也没先开口。"),
            "结算 1 的 recap 只留在它收束的锚行"
        );
        // X1：结算 2 只回写 summary；recap 保持缺席（无产出 = 字段缺失，不是继承上一场）。
        assert_eq!(scenes[1].summary.as_deref(), Some("打烊后的整理与和解"));
        assert_eq!(scenes[1].recap, None, "无产出 ≠ 上一场的陈旧 recap");
        // X2：结算 3 的两档正确落位。
        assert_eq!(scenes[2].summary.as_deref(), Some("雨夜码头的告别"));
        assert_eq!(
            scenes[2].recap.as_deref(),
            Some("告别从一封迟到的信开始。两人在雨里把话说尽。最后她先转身。"),
            "结算 3 的 recap 写进它收束的行"
        );
        // X3：进行中 header，两档缺席。
        assert_eq!(scenes[3].summary, None);
        assert_eq!(scenes[3].recap, None);
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// director 输入纯净性（2026-09-12 裁决修订）：预填废除后，下一次结算读到的
    /// latest 行（进行中 header）summary / recap 均缺席——「上一场快照」不再携带
    /// 上一场的陈旧回顾文本。
    #[tokio::test]
    async fn run_settlement_prompt_reads_unprefilled_latest_scene() {
        let (storage, dir, session_id, _char_id, _trigger_id) = settlement_setup("dir_pure");
        let captured: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
        let cap = captured.clone();
        let server = MockServer::start(move |req, stream| {
            cap.lock().unwrap().push(req.json());
            let _ = json_body(
                stream,
                r#"{"location":"巷口","fic_day":2,"summary":"钟楼下的对峙无果而终","recap":"对峙从一句口信误会开始。两人隔着巷口的灯沉默对望。最后谁也没先开口。"}"#,
            );
        });

        let registry = GenerationRegistry::new();
        let deps = deps_with_director(&storage, &server.url());
        // 结算 1：两档只回写锚行，新行 X1（进行中 header）两档缺席。
        let ticket = registry.begin(session_id).unwrap();
        run_settlement(&deps, &ticket, &trigger_of(&storage, session_id)).await;
        registry.finish(session_id);
        // 结算 2：latest = X1，无预填残留可读。
        let second = storage
            .insert_message(&NewMessage::new(
                session_id,
                crate::domain::models::MessageRole::Assistant,
                "第二场推进。\n\n---\n\n下一场开头。",
            ))
            .unwrap();
        let ticket = registry.begin(session_id).unwrap();
        run_settlement(&deps, &ticket, &second).await;

        let requests = captured.lock().unwrap().clone();
        assert_eq!(requests.len(), 2);
        let user = requests[1]["messages"][1]["content"].as_str().unwrap();
        assert!(!user.contains("上一场回顾"), "latest 行 recap 缺席 → 快照无回顾行：{user}");
        assert!(
            !user.contains("对峙从一句口信误会开始"),
            "上一场的 recap 不进入下一次结算输入：{user}"
        );
        assert!(user.contains("上一场摘要：（无）"), "latest 行 summary 亦缺席（不再预填）：{user}");
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// cancel 退出（ADR-005「用户可打断退出等待」）：重试等待中被取消 → 本轮放弃、
    /// 零结算副作用（§7-2：欠账由下次结算自愈）。
    #[tokio::test(flavor = "multi_thread")]
    async fn run_settlement_cancel_exits_without_commit() {
        let (storage, dir, session_id, _char_id, _trigger_id) = settlement_setup("dir_cancel");
        let attempts = Arc::new(AtomicUsize::new(0));
        let counter = attempts.clone();
        let server = MockServer::start(move |_req, stream| {
            counter.fetch_add(1, Ordering::SeqCst);
            let _ = json_body(stream, "永远是坏输出");
        });

        let registry = Arc::new(GenerationRegistry::new());
        let ticket = registry.begin(session_id).unwrap();
        let trigger = trigger_of(&storage, session_id);
        let deps = deps_with_director(&storage, &server.url());

        let task = tokio::spawn(async move {
            run_settlement(&deps, &ticket, &trigger).await;
        });
        // 等首次尝试失败进入退避，再取消（打断退出等待）。
        wait_for(|| attempts.load(Ordering::SeqCst) >= 1);
        registry.cancel(session_id);
        task.await.unwrap();

        // FR-014：取消的结算零落库，账上只剩建会话 seed 的开场锚行。
        let scenes = storage.list_scenes(session_id).unwrap();
        assert_eq!(scenes.len(), 1, "被取消的结算零落库（仅存开场锚行）");
        assert_eq!(scenes[0].summary.as_deref(), None, "锚行未收到结算回写");
        assert!(storage.list_character_states(session_id).unwrap().is_empty());
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 轮询等待条件成立（生成 / 结算在另一 worker 上推进）。
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
