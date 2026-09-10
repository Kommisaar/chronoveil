//! 状态过期三义判定（BR-002）：scene_end / event:xxx / manual，manual 最高。
//!
//! 形态出口收敛在本模块（domain 是唯一出口，services / infra 只引用不另造）：
//! 结算层产出的 expiry 值经 [`is_valid`] 校验后透传存储（存储层不解释，
//! 见 models::CharacterState.expiry）；三义的实际清算语义（何时置失效）由后续
//! FR-012 消费方实现，本切片只定义形态与校验。

/// 过期义：随下次场景收束失效（结算时点清算）。
pub const SCENE_END: &str = "scene_end";

/// 过期义前缀：具名事件发生时失效（如 `event:亮灯`）。
pub const EVENT_PREFIX: &str = "event:";

/// 过期义：仅手动清除（BR-002 三义中最高，不被自动清算触碰）。
pub const MANUAL: &str = "manual";

/// 过期三义的结构化形态（BR-002）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expiry {
    SceneEnd,
    Event(String),
    Manual,
}

/// 解析 expiry 库值 / 模型输出为三义；非法值（三义之外、`event:` 空事件名）→ None。
pub fn parse(expiry: &str) -> Option<Expiry> {
    let trimmed = expiry.trim();
    match trimmed {
        SCENE_END => return Some(Expiry::SceneEnd),
        MANUAL => return Some(Expiry::Manual),
        _ => {}
    }
    trimmed
        .strip_prefix(EVENT_PREFIX)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| Expiry::Event(name.to_string()))
}

/// 值域校验：是否合法三义（BR-002）。结算字段级容错用它把越界值修正为 None（不重试）。
pub fn is_valid(expiry: &str) -> bool {
    parse(expiry).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_three_kinds_and_rejects_garbage() {
        assert_eq!(parse("scene_end"), Some(Expiry::SceneEnd));
        assert_eq!(parse("manual"), Some(Expiry::Manual));
        assert_eq!(parse("event:亮灯"), Some(Expiry::Event("亮灯".into())));
        assert_eq!(parse("  scene_end  "), Some(Expiry::SceneEnd), "容忍首尾空白");
        assert_eq!(parse("event: 亮灯 "), Some(Expiry::Event("亮灯".into())));

        // 非法值：三义之外、裸前缀、空串。
        assert_eq!(parse("明天"), None);
        assert_eq!(parse("event:"), None);
        assert_eq!(parse("event:   "), None);
        assert_eq!(parse(""), None);
    }

    #[test]
    fn is_valid_matches_parse() {
        assert!(is_valid(SCENE_END));
        assert!(is_valid(MANUAL));
        assert!(is_valid("event:开封"));
        assert!(!is_valid("forever"));
        assert!(!is_valid(""));
    }
}
