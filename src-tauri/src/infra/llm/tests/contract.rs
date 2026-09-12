//! 契约形态：事件序列化（INT-001 wire）与配置构造校验。

use super::*;

/// 验收 4：事件序列化形态（INT-001 契约：token/reasoning 负载为 text，OQ-004 对齐后直通 Tauri 事件通道）。
#[test]
fn event_payload_shape_matches_int001_contract() {
    let value = serde_json::to_value(LlmEvent::Token {
        session_id: 1,
        message_id: 2,
        text: "x".into(),
        reset: true,
    })
    .unwrap();
    assert_eq!(value["type"], "token");
    assert_eq!(value["session_id"], 1);
    assert_eq!(value["message_id"], 2);
    assert_eq!(value["text"], "x");
    assert_eq!(value["reset"], true);

    let value = serde_json::to_value(LlmEvent::Done {
        session_id: 1,
        message_id: 2,
        think_ms: Some(99),
    })
    .unwrap();
    assert_eq!(value["type"], "done");
    assert_eq!(value["think_ms"], 99);

    let value = serde_json::to_value(LlmEvent::Error {
        session_id: 1,
        message_id: 2,
        reason: "boom".into(),
        interrupted: true,
    })
    .unwrap();
    assert_eq!(value["type"], "error");
    assert_eq!(value["reason"], "boom");
    assert_eq!(value["interrupted"], true);
}

/// 配置校验：缺 base_url / model 在构造期即报 Config。
#[test]
fn config_validation_rejects_empty_fields() {
    let err = LlmClient::new(LlmConfig { base_url: String::new(), ..Default::default() }).unwrap_err();
    assert!(matches!(err, LlmError::Config(_)));
    let err = LlmClient::new(LlmConfig {
        base_url: "http://x".into(),
        model: String::new(),
        ..Default::default()
    })
    .unwrap_err();
    assert!(matches!(err, LlmError::Config(_)));
}
