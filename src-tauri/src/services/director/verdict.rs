//! 导演裁决纯函数半（自 director.rs 本体外置，500 行规范；代码逐字搬移，可见性不变）：
//! §1 场景线触发判定（与渲染引擎逐字对齐）+ §2 导演裁决 serde 类型与字段级容错。
//! 编排半（模型解析 → prompt 装配 → 重试落库）见 [`super`]。

use serde::Deserialize;

use crate::domain::fiction_time;
use crate::domain::models::{CharacterStateScope, Scene};
use crate::domain::state_expiry;

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
/// untagged 按序匹配：含 scope/key/value 判 upsert；只含 instance_id + clear 判清除。
/// 多角色换挂（迁移 0009 / 方案 §2.2）：模型经结算 prompt 的【在场名单】用**实例 id**
/// 指认状态归属（名单即 id ↔ 实例名映射，Q5/D9 的「对XX」歧义由 key 文本承载）。
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum StateOp {
    Upsert {
        instance_id: i64,
        scope: String,
        key: String,
        value: String,
        #[serde(default)]
        expiry: Option<String>,
    },
    Clear {
        instance_id: i64,
        /// 要清除的状态键名（wire 形态 `{"instance_id": 1, "clear": "别扭"}`）。
        clear: String,
    },
}

/// 归一后的状态写入（字段级容错完成；落库形态 `NewCharacterState` 挂实例）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateUpsert {
    pub instance_id: i64,
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
    /// (instance_id, key)：编排层映射到在世状态行 id 后走 soft_delete。
    pub clears: Vec<(i64, String)>,
}

/// 字段级容错（§2，值域修正、不重试）：
/// - location / time_note / summary / recap：缺失或空白 → None（列可空）；
/// - fic_day：缺失 → 沿用 latest.fic_day（不推进）；小于账本位 → 钳到账本位（BR-003 单调）；
/// - fic_part：不在六值 → None；
/// - present / states 引用 roster 外 instance_id、scope 非法 → 丢弃该条继续（配合
///   system 指令与名单输入，发生概率低，不值得整次重试烧一次调用）；
/// - expiry：非三义 → None（形态由结算层定，见 state_expiry；语义等价「无过期信息」）。
///
/// present 恒为 roster（全部实例 id，§7-7 的多角色化收窄）：模型输出的 present 仅作
/// schema 占位，校验不扩展（离场清算 D4 由后续步骤的状态历史化承接）。
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
            StateOp::Upsert { instance_id, scope, key, value, expiry } => {
                if !roster.contains(instance_id) {
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
                    instance_id: *instance_id,
                    scope,
                    key: key.to_string(),
                    value: value.to_string(),
                    expiry,
                });
            }
            StateOp::Clear { instance_id, clear } => {
                if !roster.contains(instance_id) {
                    continue;
                }
                let key = clear.trim();
                if key.is_empty() {
                    continue;
                }
                clears.push((*instance_id, key.to_string()));
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
