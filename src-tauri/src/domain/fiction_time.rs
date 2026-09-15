//! 虚时换算（BR-003）：记账层 {day, part} 是唯一事实源；日历双射换算 date_label（FR-013）。
//!
//! 分工：fic_day / fic_part 由导演结算产出并钳制（[`clamp_day`] / [`is_valid_part`]），
//! 本模块只在其上做「命名皮肤」换算——`CalendarConfig` 是角色世界观日历的 JSON 形态
//! （角色卡归属、建会话时快照到 Session，FR-013「日历归属与继承」），[`date_label`]
//! 把记账位渲染成人类可读缓存（如「白蜡月·晨露日·夜」）。预设历法的写入由 FR-014
//! 开局向导负责，本模块只正确消费。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// 时段六值（BR-003）：fic_part 的合法值域；结算字段级容错的判定基准。
pub const PARTS: [&str; 6] = ["清晨", "上午", "午后", "黄昏", "夜", "深夜"];

/// 六值校验：不在 [`PARTS`] 内的时段值视为模型噪声，容错为 None（不重试）。
pub fn is_valid_part(part: &str) -> bool {
    PARTS.contains(&part)
}

/// 记账层 day 单调（BR-003，第 3 步「时间线分叉」起收窄为**单时间线内**不倒流）——
/// 虚时只被叙事推进，绝不倒流，但账本是**每条时间线（会话）一份**：跨线回退合法且
/// 正是「从此分叉」的意义（新线从锚点场的 fic_day 重走，见 infra/storage/session_fork）。
/// 本函数的 `last` 由调用方取**本会话**最新场景行的 fic_day（如 director::verdict），
/// 天然按线隔离，跨会话钳制不存在。新值小于账本最后值时钳到 last；无账本原样通过。
pub fn clamp_day(new: i64, last: Option<i64>) -> i64 {
    match last {
        Some(last) if new < last => last,
        _ => new,
    }
}

/// 角色世界观日历（FR-013；data_model §7.6 schema）。只做 day → 命名的双射换算皮肤，
/// 不参与记账。全部字段缺省可用：空配置 = 无命名皮肤（v1 默认历）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CalendarConfig {
    /// 历法名（如「白蜡历」）；None = 无命名皮肤。
    #[serde(default)]
    pub name: Option<String>,
    /// 月名序列（day-1 → 月序双射换算）。
    #[serde(default)]
    pub months: Vec<String>,
    /// 每月天数（固定天数历）；0 = 无月换算基准，date_label 回退数字形式。
    #[serde(default)]
    pub days_per_month: u32,
    /// 日名序列（如七曜），按 (day-1) 对序列长度取模循环。
    #[serde(default)]
    pub day_names: Vec<String>,
    /// 节日表：键 = 年内第几天（1 起），值 = 节日名；命中则在 date_label 缀节日名。
    #[serde(default)]
    pub festivals: BTreeMap<i64, String>,
}

impl Default for CalendarConfig {
    /// v1 默认历 = 无命名皮肤：date_label 直接 `第{day}日·{part}`。
    fn default() -> Self {
        Self {
            name: None,
            months: Vec::new(),
            days_per_month: 0,
            day_names: Vec::new(),
            festivals: BTreeMap::new(),
        }
    }
}

impl CalendarConfig {
    /// 是否具备可用的命名皮肤（至少有月名或日名，且有月长基准可做双射换算）。
    fn has_skin(&self) -> bool {
        validate(self)
    }
}

/// 命名皮肤可用性判定（FR-014 开局向导与 date_label 回退共用同一规则）：
/// `days_per_month > 0` 且月名 / 日名至少其一非空（对齐原 `has_skin`）。
pub fn validate(calendar: &CalendarConfig) -> bool {
    calendar.days_per_month > 0 && (!calendar.months.is_empty() || !calendar.day_names.is_empty())
}

/// 内置四预设历法（FR-014 开局向导一期：零 LLM 依赖、离线可用、建会话同步完成）。
///
/// 形态约束（schema 事实源即本文件的 [`CalendarConfig`]）：festivals 键 = 年内第几天
/// 整数（1 起）；每月天数固定（四预设统一 12 月 × 30 日 = 360 日一年），保证
/// day ↔ (月序, 日序) 双射。自动拟历（廉价结构化调用起草）留二期。
///
/// 以函数逐次构造（`String` / `BTreeMap` 无 const 构造）；调用方每次拿独立副本，
/// 可直接改写或落库。
pub mod presets {
    use std::collections::BTreeMap;

    use super::CalendarConfig;

    fn names<const N: usize>(items: [&str; N]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    /// 现代公历：均匀化 360 日年（12 月 × 30 日）；国庆 = (10-1)×30+1 = 271。
    pub fn modern() -> CalendarConfig {
        CalendarConfig {
            name: Some("现代公历".into()),
            months: names([
                "一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月",
                "十一月", "十二月",
            ]),
            days_per_month: 30,
            day_names: names(["周一", "周二", "周三", "周四", "周五", "周六", "周日"]),
            festivals: BTreeMap::from([(1, "元旦".to_string()), (271, "国庆节".to_string())]),
        }
    }

    /// 七曜和历：和风月名 + 七曜日名；七五三 = (11-1)×30+15 = 315，大晦日 = 360。
    pub fn seven() -> CalendarConfig {
        CalendarConfig {
            name: Some("七曜和历".into()),
            months: names([
                "睦月", "如月", "弥生", "卯月", "皋月", "水无月", "文月", "叶月", "长月",
                "神无月", "霜月", "师走",
            ]),
            days_per_month: 30,
            day_names: names([
                "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日", "日曜日",
            ]),
            festivals: BTreeMap::from([(315, "七五三".to_string()), (360, "大晦日".to_string())]),
        }
    }

    /// 干支历：古典月名 + 十二支日名取模循环；上元 = 正月十五 = 15，除夕 = 360。
    pub fn ganzhi() -> CalendarConfig {
        CalendarConfig {
            name: Some("干支历".into()),
            months: names([
                "正月", "杏月", "桃月", "槐月", "榴月", "荷月", "巧月", "桂月", "菊月", "阳月",
                "葭月", "腊月",
            ]),
            days_per_month: 30,
            day_names: names([
                "子日", "丑日", "寅日", "卯日", "辰日", "巳日", "午日", "未日", "申日", "酉日",
                "戌日", "亥日",
            ]),
            festivals: BTreeMap::from([(15, "上元".to_string()), (360, "除夕".to_string())]),
        }
    }

    /// 架空「旧都历」（概念文档 §7.6 样例）；灯节 = (2-1)×30+15 = 45，守夜 = 360。
    pub fn fantasy() -> CalendarConfig {
        CalendarConfig {
            name: Some("旧都历".into()),
            months: names([
                "霜月", "白蜡月", "融雪月", "雨月", "长夏月", "蝉鸣月", "风起月", "收获月",
                "雾月", "炉火月", "冻雨月", "岁末月",
            ]),
            days_per_month: 30,
            day_names: names([
                "晨露日", "萤火日", "潮汐日", "风息日", "炉边日", "集日", "安息日",
            ]),
            festivals: BTreeMap::from([(45, "灯节".to_string()), (360, "守夜".to_string())]),
        }
    }

    /// 全部内置预设（顺序即向导选项展示顺序，「跟随角色卡」之外的四个）。
    pub fn all() -> Vec<CalendarConfig> {
        vec![modern(), seven(), ganzhi(), fantasy()]
    }
}

/// 历法存储 JSON（0017 起归属世界实例快照）→ [`CalendarConfig`]：None / 空白 →
/// 默认历；
/// 坏 JSON → 默认历 + warn 日志降级。FR-013：日历是皮肤，坏了退默认不阻塞结算
/// ——与 config.json 的快速失败语义刻意不同，这里降级无账实风险。
pub fn parse(raw: Option<&str>) -> CalendarConfig {
    let Some(text) = raw.map(str::trim).filter(|text| !text.is_empty()) else {
        return CalendarConfig::default();
    };
    match serde_json::from_str(text) {
        Ok(calendar) => calendar,
        Err(e) => {
            // log 是纯 facade（无 IO），domain 引用不违反分层（守卫只禁
            // tauri/rusqlite/reqwest）；后端由组合根的 tauri-plugin-log 装配。
            log::warn!("calendar_config 解析失败，回退默认历：{e}");
            CalendarConfig::default()
        }
    }
}

/// 记账位 → date_label 命名缓存。皮肤历：day-1 双射换算出（月序, 日序），
/// 日名按 day-1 取模循环，节日查表命中则缀括注；无皮肤或越界回退数字形式
/// `第{day}日·{part}`（part 为空串时省略时段段）。
pub fn date_label(calendar: &CalendarConfig, fic_day: i64, fic_part: &str) -> String {
    let numeric = |day: i64| {
        if fic_part.is_empty() {
            format!("第{day}日")
        } else {
            format!("第{day}日·{fic_part}")
        }
    };
    if fic_day <= 0 || !calendar.has_skin() {
        return numeric(fic_day);
    }
    let index = (fic_day - 1) as u64; // 双射换算的 0 起序号
    let per_month = calendar.days_per_month as u64;

    // 月名：越界（换算出的月序超出月名表）→ 整体回退数字形式。
    let month = if calendar.months.is_empty() {
        Some(None) // 无月名表但有日名：跳过月段继续
    } else {
        match calendar.months.get((index / per_month) as usize) {
            Some(name) => Some(Some(name.as_str())),
            None => return numeric(fic_day),
        }
    };
    // 日段：日名表命中取模用之，否则「N日」（日序 = 月内第几日）。
    let day = if calendar.day_names.is_empty() {
        format!("{}日", index % per_month + 1)
    } else {
        calendar.day_names[(index as usize) % calendar.day_names.len()].clone()
    };
    let mut label = match month {
        Some(Some(name)) => format!("{name}·{day}"),
        _ => day,
    };
    if !fic_part.is_empty() {
        label.push('·');
        label.push_str(fic_part);
    }
    if let Some(festival) = calendar.festivals.get(&fic_day) {
        label.push_str(&format!("（{festival}）"));
    }
    label
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_domain_and_validation() {
        assert_eq!(PARTS, ["清晨", "上午", "午后", "黄昏", "夜", "深夜"]);
        for part in PARTS {
            assert!(is_valid_part(part), "{part} 应在六值内");
        }
        assert!(!is_valid_part("半夜三更"));
        assert!(!is_valid_part(""));
        assert!(!is_valid_part(" 夜"), "六值为精确匹配，不做 trim（trim 归 normalize 管）");
    }

    #[test]
    fn clamp_day_enforces_monotonic_ledger() {
        assert_eq!(clamp_day(3, Some(2)), 3, "正常推进放行");
        assert_eq!(clamp_day(2, Some(2)), 2, "持平放行");
        assert_eq!(clamp_day(1, Some(2)), 2, "倒流钳到账本位（BR-003）");
        assert_eq!(clamp_day(1, None), 1, "无账本原样通过");
    }

    #[test]
    fn parse_falls_back_to_default_on_missing_or_bad_json() {
        assert_eq!(parse(None), CalendarConfig::default());
        assert_eq!(parse(Some("")), CalendarConfig::default());
        assert_eq!(parse(Some("  ")), CalendarConfig::default());
        assert_eq!(parse(Some("{ not json")), CalendarConfig::default(), "坏 JSON 降级默认历");
        // 缺键补默认（皮肤可只配部分字段）。
        assert_eq!(
            parse(Some(r#"{"name": "七曜历"}"#)),
            CalendarConfig { name: Some("七曜历".into()), ..CalendarConfig::default() }
        );
    }

    #[test]
    fn parse_roundtrips_full_skin() {
        let raw = r#"{
            "name": "白蜡历",
            "months": ["白蜡月", "烬月"],
            "days_per_month": 10,
            "day_names": ["晨露日", "风息日", "灰烬日"],
            "festivals": { "7": "灯节" }
        }"#;
        let parsed = parse(Some(raw));
        assert_eq!(parsed.name.as_deref(), Some("白蜡历"));
        assert_eq!(parsed.months, vec!["白蜡月".to_string(), "烬月".to_string()]);
        assert_eq!(parsed.days_per_month, 10);
        assert_eq!(parsed.festivals.get(&7).map(String::as_str), Some("灯节"));
    }

    #[test]
    fn date_label_numeric_form_without_skin() {
        let cal = CalendarConfig::default();
        assert_eq!(date_label(&cal, 1, "清晨"), "第1日·清晨");
        assert_eq!(date_label(&cal, 12, "夜"), "第12日·夜");
        assert_eq!(date_label(&cal, 3, ""), "第3日", "空时段省略时段段");
        assert_eq!(date_label(&cal, 0, "夜"), "第0日·夜", "越界 day 回退数字形式");
    }

    #[test]
    fn date_label_skinned_bijection_with_festival() {
        let cal = CalendarConfig {
            name: Some("白蜡历".into()),
            months: vec!["白蜡月".into(), "烬月".into()],
            days_per_month: 10,
            day_names: vec!["晨露日".into(), "风息日".into(), "灰烬日".into()],
            festivals: BTreeMap::from([(7, "灯节".to_string())]),
        };
        assert_eq!(date_label(&cal, 7, "夜"), "白蜡月·晨露日·夜（灯节）", "节日命中缀括注");
        assert_eq!(date_label(&cal, 1, "清晨"), "白蜡月·晨露日·清晨");
        assert_eq!(date_label(&cal, 11, "上午"), "烬月·风息日·上午", "跨月换算 + 日名取模");
        assert_eq!(
            date_label(&cal, 10, "夜"),
            "白蜡月·晨露日·夜",
            "月内最后一日：日名按 day-1 对序列取模，与月内位置无关"
        );
    }

    #[test]
    fn date_label_out_of_range_falls_back_to_numeric() {
        let cal = CalendarConfig {
            name: Some("白蜡历".into()),
            months: vec!["白蜡月".into()],
            days_per_month: 10,
            day_names: Vec::new(),
            festivals: BTreeMap::new(),
        };
        assert_eq!(date_label(&cal, 11, "夜"), "第11日·夜", "月序越界整体回退数字形式");
        assert_eq!(date_label(&cal, 5, "夜"), "白蜡月·5日·夜", "无日名表用月内日序");
    }

    #[test]
    fn date_label_day_names_only_skin() {
        let cal = CalendarConfig {
            day_names: vec!["晨露日".into(), "风息日".into()],
            days_per_month: 30,
            ..CalendarConfig::default()
        };
        assert_eq!(date_label(&cal, 2, "午后"), "风息日·午后", "无月名表只出日段（day-1 取模）");
    }

    // ---- FR-014：validate helper 与内置预设 ----

    #[test]
    fn validate_aligns_has_skin() {
        // 空配置 / 缺月长基准 / 月日名全空 = 不可用；月名或日名其一即可。
        assert!(!validate(&CalendarConfig::default()));
        assert!(
            !validate(&CalendarConfig {
                months: vec!["白蜡月".into()],
                ..CalendarConfig::default()
            }),
            "days_per_month = 0 不可做双射换算"
        );
        assert!(validate(&CalendarConfig {
            months: vec!["白蜡月".into()],
            days_per_month: 30,
            ..CalendarConfig::default()
        }));
        assert!(validate(&CalendarConfig {
            day_names: vec!["晨露日".into()],
            days_per_month: 30,
            ..CalendarConfig::default()
        }), "月名 / 日名至少其一非空即可");
    }

    /// 四预设 date_label 抽查：节日括注、跨月换算、日名取模逐一命中。
    #[test]
    fn presets_date_label_spot_checks() {
        use presets;

        // 现代公历：day 1 = 一月·周一（元旦）；日名按年内日序取模（270 % 7 = 周五）。
        assert_eq!(date_label(&presets::modern(), 1, "夜"), "一月·周一·夜（元旦）");
        assert_eq!(date_label(&presets::modern(), 2, "清晨"), "一月·周二·清晨");
        assert_eq!(date_label(&presets::modern(), 271, "夜"), "十月·周五·夜（国庆节）");

        // 七曜和历：315 = 霜月·日曜日（七五三，314 % 7）；360 = 师走·水曜日（大晦日）。
        assert_eq!(date_label(&presets::seven(), 315, "夜"), "霜月·日曜日·夜（七五三）");
        assert_eq!(date_label(&presets::seven(), 360, "深夜"), "师走·水曜日·深夜（大晦日）");

        // 干支历：15 = 正月·寅日（上元，14 % 12）；360 = 腊月·亥日（除夕，359 % 12）。
        assert_eq!(date_label(&presets::ganzhi(), 15, "夜"), "正月·寅日·夜（上元）");
        assert_eq!(date_label(&presets::ganzhi(), 360, "夜"), "腊月·亥日·夜（除夕）");

        // 旧都历：45 = 白蜡月·潮汐日（灯节，44 % 7）；360 = 岁末月·潮汐日（守夜）。
        assert_eq!(date_label(&presets::fantasy(), 45, "夜"), "白蜡月·潮汐日·夜（灯节）");
        assert_eq!(date_label(&presets::fantasy(), 360, "夜"), "岁末月·潮汐日·夜（守夜）");
    }

    /// 预设 → JSON → parse 往返无损：锁定存储 JSON 为 snake_case 键（wire camelCase
    /// 只管 DTO，落库由 Rust 序列化 domain 结构得到）。
    #[test]
    fn presets_roundtrip_through_storage_json() {
        for preset in presets::all() {
            assert!(validate(&preset), "内置预设必须可用：{:?}", preset.name);
            let json = serde_json::to_string(&preset).unwrap();
            assert!(
                json.contains("days_per_month"),
                "存储 JSON 键为 snake_case：{json}"
            );
            assert!(!json.contains("daysPerMonth"), "存储 JSON 不得混入 wire camelCase：{json}");
            assert_eq!(parse(Some(&json)), preset, "往返无损：{:?}", preset.name);
        }
    }
}
