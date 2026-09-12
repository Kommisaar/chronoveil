//! AI 起草历法（FR-014 二期）：按用户的世界观描述让 LLM 起草一份自定义
//! [`CalendarConfig`]，返回给前端供审阅后保存（保存走既有 update_character /
//! 开局向导路径，本服务**不做持久化、不自动应用**）。
//!
//! 复用回路（INT-002）：非流式结构化调用直接走 [`LlmClient::complete_json`]——
//! 围栏剥离 / 前后杂文容错（`extract_json`）与可重试错误的整条重发都由网关自持，
//! 本模块只做 prompt 装配、schema 级解析修复（含合理性钳制）与至多一次的
//! 「指出错误让模型修正」重试。模型解析（全局默认模型）与导演结算
//! （`director::resolve_director_llm`）刻意分开：起草是向导里的通用能力，
//! 不吃导演专用模型覆写。

use std::collections::BTreeMap;

use crate::domain::fiction_time::{self, CalendarConfig, MAX_DAYS_PER_MONTH};
use crate::domain::models::LlmCallKind;
use crate::infra::config::Config as FileConfig;
use crate::infra::llm::{CallTrace, CancelHandle, ChatMessage, ChatRole, LlmClient, LlmConfig};

/// 世界观描述长度上限（按码点计）：超长直接拒绝（错误信息明确），不静默截断
/// ——截断可能把设定拦腰斩断，起草质量不可控。
pub const MAX_DESCRIPTION_CHARS: usize = 4_000;

/// 合理性钳制：月名 / 日名序列条数上限。
const MAX_NAME_ITEMS: usize = 64;
/// 合理性钳制：单个名称（月名 / 日名 / 节日名）字符数上限。
const MAX_ITEM_CHARS: usize = 32;
/// 合理性钳制：节日条数上限。
const MAX_FESTIVALS: usize = 64;
// 每月天数上界不在此定义：直接引用 domain 单一事实源
// `fiction_time::MAX_DAYS_PER_MONTH`（模块顶部 use），钳制 range、报错文案与
// prompt 取值域说明三处同源；下限 1 由 [`fiction_time::validate`] 把守。

// ---------------------------------------------------------------------------
// 错误（调用方 ipc 层映射为 IpcError 分型）
// ---------------------------------------------------------------------------

/// 起草失败的分型：参数错误不发起调用；LLM 错误透传网关分型；输出不合格
/// 携带人类可读原因（已含一次修正重试后的最终原因）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CalendarDraftError {
    /// 世界观描述空白或超长（[`MAX_DESCRIPTION_CHARS`]），未发起任何网络调用。
    InvalidDescription(String),
    /// LLM 调用失败（网络 / 超时 / 401 / 429 / 协议 / JSON 提取失败，见 `LlmError`）。
    Llm(crate::infra::llm::LlmError),
    /// 模型输出经一次修正重试后仍不满足 schema / 校验，携带原因。
    InvalidOutput(String),
    /// 起草被取消（发起前检查或调用中途打断）。
    Cancelled,
}

impl std::fmt::Display for CalendarDraftError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CalendarDraftError::InvalidDescription(message) => write!(f, "{message}"),
            CalendarDraftError::Llm(error) => write!(f, "{error}"),
            CalendarDraftError::InvalidOutput(reason) => {
                write!(f, "模型输出不合格（已重试一次）：{reason}")
            }
            CalendarDraftError::Cancelled => write!(f, "已取消日历起草"),
        }
    }
}

impl std::error::Error for CalendarDraftError {}

// ---------------------------------------------------------------------------
// prompt 装配（system 规则 + 单条 user 描述）
// ---------------------------------------------------------------------------

/// 起草 system 指令：只输出 JSON、schema 说明、取材与自洽规则、默认结构。
/// days_per_month 取值域上界由单一事实源 [`fiction_time::MAX_DAYS_PER_MONTH`]
/// 格式化注入，与 [`coerce_days_per_month`] 的钳制 range 同源，消除文案与
/// 逻辑漂移；schema 示例中的花括号是字面 JSON 而非占位符，故转义为
/// `{{` / `}}`。
fn system_prompt() -> String {
    format!(
        "你是世界观设定助手：根据用户给出的世界观描述，起草一份与之自洽的架空历法（固定天数历）。
只输出一个 JSON 对象——不要 markdown 代码围栏（不要输出 ```），不要解释，不要输出 JSON 以外的任何文字。

JSON schema（字段名固定）：
{{
  \"name\": \"历法名（字符串，或 null 表示不命名）\",
  \"months\": [\"月名\", …],
  \"days_per_month\": 每月天数（正整数）,
  \"day_names\": [\"日名\", …],
  \"festivals\": {{\"年内第几天\": \"节日名\", …}}
}}

字段说明：
- months：月名序列（字符串数组），按时间顺序排列；
- days_per_month：每月天数，1–{MAX_DAYS_PER_MONTH} 的正整数；
- day_names：日名序列（字符串数组，如七曜），按（当日 - 1）对序列长度取模循环使用；
- festivals：节日表对象，键为「年内第几天」的数字字符串（从 1 起，如 \"45\"），值为节日名；没有节日给空对象 {{}}。

起草规则：
1. 默认结构为一年 12 个月、每月 30 天，除非描述另有说明；
2. 历法名、月名、日名与节日名从描述中取材命名（人物、地名、意象、事件等），与世界观自洽；
3. 不要发明与描述矛盾的设定；描述未提及的细节用中性、可泛化的命名补全；
4. 每个节日的「年内第几天」不得超过一年总天数（月数 × 每月天数）。"
    )
}

/// 装配起草 prompt：system 指令 + 单条 user（世界观描述）。
pub fn build_prompt(description: &str) -> Vec<ChatMessage> {
    vec![
        ChatMessage::new(ChatRole::System, system_prompt()),
        ChatMessage::new(
            ChatRole::User,
            format!("【世界观描述】\n{description}\n\n请起草历法，只输出 JSON 对象。"),
        ),
    ]
}

/// 修正重试的追加指令：把解析 / 校验失败原因原样指给模型。
fn correction_message(reason: &str) -> String {
    format!(
        "你上一次输出的 JSON 存在以下问题：{reason}\n请修正后重新输出一个完整、合法的 JSON 对象——仍然只输出 JSON，不要任何解释或围栏。"
    )
}

// ---------------------------------------------------------------------------
// 解析与修复（容错 + 合理性钳制；失败原因聚合返回，供修正重试与最终报错）
// ---------------------------------------------------------------------------

/// 字段读取（snake_case 优先，兼容 camelCase——模型两种写法都可能出现）；
/// null / 缺失一律视同缺失。
fn field<'a>(
    obj: &'a serde_json::Map<String, serde_json::Value>,
    snake: &str,
    camel: &str,
) -> Option<&'a serde_json::Value> {
    let value = obj.get(snake).or_else(|| obj.get(camel))?;
    if value.is_null() { None } else { Some(value) }
}

/// 名称列表容错（months / day_names 共用）：非数组记因；非字符串与空白条目按
/// 噪声跳过；条数 / 单项长度超限记因（超限条目整条丢弃，原因留给一次重试修完）。
fn coerce_names(
    value: Option<&serde_json::Value>,
    label: &str,
    reasons: &mut Vec<String>,
) -> Vec<String> {
    let Some(value) = value else { return Vec::new() };
    let Some(items) = value.as_array() else {
        reasons.push(format!("{label} 必须是字符串数组"));
        return Vec::new();
    };
    if items.len() > MAX_NAME_ITEMS {
        reasons.push(format!("{label} 有 {} 项，超过上限 {MAX_NAME_ITEMS}", items.len()));
    }
    let mut names = Vec::new();
    for item in items {
        let Some(text) = item.as_str() else { continue };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.chars().count() > MAX_ITEM_CHARS {
            reasons.push(format!(
                "{label}单项超长（> {MAX_ITEM_CHARS} 字符）：{}…",
                trimmed.chars().take(8).collect::<String>()
            ));
            continue;
        }
        names.push(trimmed.to_string());
    }
    names.truncate(MAX_NAME_ITEMS);
    names
}

/// 每月天数容错：接受整数、整数值浮点（30.0）与数字字符串（"30"）；
/// 缺失 / 形态不符 / 越界（合法域 1..=[`fiction_time::MAX_DAYS_PER_MONTH`]
/// 之外）记因。上界为 domain 单一事实源（与 system prompt 文案同源）；
/// 下限 1 由 [`fiction_time::validate`] 把守（0 = 无月换算基准哨兵）。
fn coerce_days_per_month(
    value: Option<&serde_json::Value>,
    reasons: &mut Vec<String>,
) -> u32 {
    let Some(value) = value else {
        reasons.push("缺少每月天数（days_per_month）".into());
        return 0;
    };
    let parsed = match value {
        serde_json::Value::Number(n) => n
            .as_u64()
            .map(|v| u32::try_from(v).ok())
            .unwrap_or_else(|| {
                n.as_f64().filter(|f| f.fract() == 0.0 && *f >= 0.0).and_then(|f| u32::try_from(f as u64).ok())
            }),
        serde_json::Value::String(s) => s.trim().parse::<u32>().ok(),
        _ => None,
    };
    match parsed {
        Some(days) if (1..=MAX_DAYS_PER_MONTH).contains(&days) => days,
        Some(days) => {
            reasons.push(format!("每月天数 {days} 超出 1–{MAX_DAYS_PER_MONTH}"));
            0
        }
        None => {
            reasons.push(format!("每月天数需为 1–{MAX_DAYS_PER_MONTH} 的正整数"));
            0
        }
    }
}

/// 节日表容错：键容忍数字字符串（"45"，即模型最常见的形态），无法解析为
/// ≥ 1 整数的键与空白 / 非字符串值按噪声跳过；越年键（> `year_days`）静默丢弃；
/// 条数 / 节日名长度超限记因。
fn coerce_festivals(
    value: Option<&serde_json::Value>,
    year_days: Option<i64>,
    reasons: &mut Vec<String>,
) -> BTreeMap<i64, String> {
    let Some(value) = value else { return BTreeMap::new() };
    let Some(obj) = value.as_object() else {
        reasons.push("festivals 必须是对象（键 = 年内第几天的数字字符串，值 = 节日名）".into());
        return BTreeMap::new();
    };
    if obj.len() > MAX_FESTIVALS {
        reasons.push(format!("festivals 有 {} 条，超过上限 {MAX_FESTIVALS}", obj.len()));
    }
    let mut festivals = BTreeMap::new();
    for (key, value) in obj {
        let Ok(day) = key.trim().parse::<i64>() else { continue };
        if day < 1 {
            continue;
        }
        // prompt 承诺的约束在解析层兜底：越年节日是永不命中的死数据，静默丢弃
        // 不计入失败原因、不触发修正重试。
        if let Some(year_days) = year_days {
            if day > year_days {
                continue;
            }
        }
        let Some(name) = value.as_str() else { continue };
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.chars().count() > MAX_ITEM_CHARS {
            reasons.push(format!("节日名超长（> {MAX_ITEM_CHARS} 字符）：{trimmed}"));
            continue;
        }
        festivals.insert(day, trimmed.to_string());
    }
    while festivals.len() > MAX_FESTIVALS {
        festivals.pop_last();
    }
    festivals
}

/// 模型输出 → [`CalendarConfig`]：容忍字段缺省 / 键风格（snake / camel）/
/// festivals 数字字符串键，套用合理性钳制，最后以 [`fiction_time::validate`]
/// 兜底。全部原因聚合返回（一个 Err 让模型一次修完）。
pub fn parse_draft(value: &serde_json::Value) -> Result<CalendarConfig, String> {
    let Some(obj) = value.as_object() else {
        return Err("输出必须是单个 JSON 对象".into());
    };
    let mut reasons: Vec<String> = Vec::new();

    let name = field(obj, "name", "name")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    let months = coerce_names(field(obj, "months", "months"), "月名表", &mut reasons);
    let day_names = coerce_names(field(obj, "day_names", "dayNames"), "日名表", &mut reasons);
    let days_per_month = coerce_days_per_month(
        field(obj, "days_per_month", "daysPerMonth"),
        &mut reasons,
    );
    // 年总天数（越年节日判定基准）：months 非空时 = 月数 × 每月天数；months 为空
    // 时无法界定年长，只查 ≥ 1 界。
    let year_days = if months.is_empty() {
        None
    } else {
        Some(i64::from(days_per_month) * months.len() as i64)
    };
    let festivals =
        coerce_festivals(field(obj, "festivals", "festivals"), year_days, &mut reasons);

    if !reasons.is_empty() {
        return Err(reasons.join("；"));
    }
    let calendar =
        CalendarConfig { name, months, days_per_month, day_names, festivals };
    if !fiction_time::validate(&calendar) {
        return Err("历法不可用：每月天数需 > 0 且月名 / 日名至少其一非空".into());
    }
    Ok(calendar)
}

// ---------------------------------------------------------------------------
// 编排：入参校验 → 结构化调用 → 解析 →（至多一次）修正重试
// ---------------------------------------------------------------------------

/// 起草模型解析（全局默认模型）：`active_selection`（active provider + active
/// model，未显式选型回落该服务第一个模型）。**不复用** `resolve_effective_llm`
/// （那是 Character.model_config 覆写语义，起草没有角色上下文）与
/// `resolve_director_llm`（导演专用模型覆写只服务结算，INT-003）。
pub fn resolve_draft_llm(config: &FileConfig) -> Result<LlmClient, String> {
    let (provider, model) = config
        .active_selection()
        .ok_or_else(|| "未配置全局默认模型：请先在设置页选择服务并添加模型".to_string())?;
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

/// 单次结构化调用（可取消）：取消在发起前检查；调用中经 `select!` 打断——
/// future 被 drop 即中止底层请求。`complete_json` 自持围栏剥离与可重试错误
/// 的整条重发，JSON 提取失败直接归入 [`CalendarDraftError::Llm`]（不走修正
/// 重试：网关已尽力容错，仍失败说明输出不可救）。`trace`：调用轨迹上下文。
async fn complete_value(
    llm: &LlmClient,
    messages: &[ChatMessage],
    cancel: &CancelHandle,
    trace: &CallTrace,
) -> Result<serde_json::Value, CalendarDraftError> {
    if cancel.is_cancelled() {
        return Err(CalendarDraftError::Cancelled);
    }
    tokio::select! {
        result = llm.complete_json::<serde_json::Value>(messages, Some(trace)) => {
            result.map_err(CalendarDraftError::Llm)
        }
        _ = cancel.wait() => Err(CalendarDraftError::Cancelled),
    }
}

/// AI 起草历法：按世界观描述产出一份通过校验的 [`CalendarConfig`]。
///
/// - 空白 / 超长（> [`MAX_DESCRIPTION_CHARS`]）描述直接拒绝，不发起调用；
/// - 首次输出的 schema / 校验失败 → 追加「指出错误」的修正消息重试**至多一次**，
///   仍失败则 [`CalendarDraftError::InvalidOutput`]（携带原因）；
/// - 全程可被 `cancel` 打断（发起前 / 调用中）。
pub async fn draft_calendar(
    llm: &LlmClient,
    description: &str,
    cancel: &CancelHandle,
) -> Result<CalendarConfig, CalendarDraftError> {
    let trimmed = description.trim();
    if trimmed.is_empty() {
        return Err(CalendarDraftError::InvalidDescription(
            "描述内容为空：请先填写世界观描述".into(),
        ));
    }
    let chars = trimmed.chars().count();
    if chars > MAX_DESCRIPTION_CHARS {
        return Err(CalendarDraftError::InvalidDescription(format!(
            "描述过长：{chars} 字符，上限 {MAX_DESCRIPTION_CHARS}，请精简后重试"
        )));
    }

    let mut messages = build_prompt(trimmed);
    // 调用轨迹接线（透明化功能）：起草发生在会话之外（session_id = None），draft 类别；
    // 修正重试的每次调用在网关内各记一条轨迹。
    let trace = CallTrace { session_id: None, kind: LlmCallKind::Draft };
    let value = complete_value(llm, &messages, cancel, &trace).await?;
    // 一次修正重试：assistant 原样回放已提取的 JSON + user 指出失败原因。
    let reason = match parse_draft(&value) {
        Ok(calendar) => return Ok(calendar),
        Err(reason) => reason,
    };
    messages.push(ChatMessage::new(ChatRole::Assistant, value.to_string()));
    messages.push(ChatMessage::new(ChatRole::User, correction_message(&reason)));
    let value = complete_value(llm, &messages, cancel, &trace).await?;
    parse_draft(&value).map_err(CalendarDraftError::InvalidOutput)
}

#[cfg(test)]
mod tests;
