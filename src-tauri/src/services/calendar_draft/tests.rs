//! 历法起草回路测试（自 calendar_draft.rs 外置，源文件 500 行上限）：
//! prompt 装配、解析容错与钳制边界、修正重试编排（mock HTTP 走真实
//! complete_json 回路）、取消语义与调用轨迹接线。
use super::*;
use crate::infra::llm::mock::{json_body, MockRequest, MockServer};
use std::sync::{Arc, Mutex};

/// 测试客户端：零退避、短超时（连接本地 mock 服务）。
fn client(url: &str) -> LlmClient {
    LlmClient::new(LlmConfig {
        base_url: url.to_owned(),
        api_key: "test-key".into(),
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

/// 按脚本逐连接吐 content（队列前段先出），并快照全部请求供断言。
fn scripted_server(script: Vec<String>) -> (MockServer, Arc<Mutex<Vec<MockRequest>>>) {
    let queue = Arc::new(Mutex::new(script));
    let captured: Arc<Mutex<Vec<MockRequest>>> = Arc::new(Mutex::new(Vec::new()));
    // 队列原件直接被闭包捕获使用，无需 clone；只 clone 快照表进闭包。
    let cap_clone = captured.clone();
    let server = MockServer::start(move |req, stream| {
        cap_clone.lock().unwrap().push(req.clone());
        let next = queue.lock().unwrap().remove(0);
        let _ = json_body(stream, &next);
    });
    (server, captured)
}

/// 合法白蜡历样例（camelCase 键 + festivals 数字字符串键，走围栏输出）。
fn fenced_valid_calendar() -> String {
    r#"```json
{"name":"白蜡历","months":["白蜡月","烬月"],"daysPerMonth":30,
 "dayNames":["晨露日","风息日"],"festivals":{"45":"灯节","60":"守夜"}}
```"#
        .into()
}

// 注意：取消通道在各测试体内创建——signal 必须活过整个调用（watch 语义：
// 发送端销毁 → wait 立即返回，句柄单独返回会提前 drop signal）。

// ---- prompt 装配 ----

#[test]
fn prompt_states_schema_defaults_and_material_rules() {
    let messages = build_prompt("修仙世界，灵气潮汐");
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].role, ChatRole::System);
    assert_eq!(messages[1].role, ChatRole::User);
    let system = &messages[0].content;
    // schema 关键字：字段名、 festivals 数字字符串键、只输出 JSON、禁围栏。
    for keyword in [
        "days_per_month",
        "day_names",
        "festivals",
        "只输出",
        "```",
        "数字字符串",
    ] {
        assert!(system.contains(keyword), "system 指令缺少「{keyword}」");
    }
    // 默认结构与取材规则。
    for rule in ["12 个月", "30 天", "从描述中取材", "不要发明与描述矛盾"] {
        assert!(system.contains(rule), "system 指令缺少规则「{rule}」");
    }
    // user 消息携带描述原文。
    assert!(messages[1].content.contains("修仙世界，灵气潮汐"));
    assert!(messages[1].content.contains("只输出 JSON"));
}

// ---- parse_draft：容错 + 钳制 ----

fn parse_ok(json: &str) -> CalendarConfig {
    parse_draft(&serde_json::from_str(json).unwrap()).unwrap()
}

fn parse_err(json: &str) -> String {
    parse_draft(&serde_json::from_str(json).unwrap()).unwrap_err()
}

#[test]
fn parse_draft_accepts_snake_and_camel_and_numeric_festival_keys() {
    // snake_case（领域 schema 形态）。
    let snake = parse_ok(
        r#"{"name":"干支历","months":["正月"],"days_per_month":30,
                "day_names":["子日"],"festivals":{"15":"上元"}}"#,
    );
    assert_eq!(snake.days_per_month, 30);
    assert_eq!(snake.festivals.get(&15).map(String::as_str), Some("上元"));
    // camelCase（wire 习惯）+ null 历法名 + 数字字符串节日键（键 30 = 界内末日）。
    let camel = parse_ok(
        r#"{"name":null,"months":["霜月"],"daysPerMonth":30,
                "dayNames":["晨露日"],"festivals":{"30":"守夜"}}"#,
    );
    assert_eq!(camel.name, None);
    assert_eq!(camel.days_per_month, 30);
    assert_eq!(camel.festivals.get(&30).map(String::as_str), Some("守夜"));
    // 整数值浮点与数字字符串的每月天数都容忍。
    assert_eq!(
        parse_ok(r#"{"months":["霜月"],"days_per_month":30.0}"#).days_per_month,
        30
    );
    assert_eq!(
        parse_ok(r#"{"months":["霜月"],"daysPerMonth":"30"}"#).days_per_month,
        30
    );
    // 空白节日名 / 非数字键按噪声跳过，不致失败。
    let noisy = parse_ok(
        r#"{"months":["霜月"],"days_per_month":30,"festivals":{"第几日":"灯节","2":"  "}}"#,
    );
    assert!(noisy.festivals.is_empty());
}

#[test]
fn parse_draft_drops_out_of_year_festivals_silently() {
    // 3 月 × 30 天 = 90：键 90 恰在界内保留，361 越年整条丢弃且不计入失败
    // 原因（若计因，parse_ok 会因触发修正重试语义而失败）。
    let calendar = parse_ok(
        r#"{"months":["霜月","烬月","雪月"],"days_per_month":30,
                "festivals":{"90":"融雪祭","361":"越年死键","15":"上元"}}"#,
    );
    assert_eq!(calendar.festivals.len(), 2, "越年键被丢弃，合法键保留");
    assert_eq!(
        calendar.festivals.get(&90).map(String::as_str),
        Some("融雪祭")
    );
    assert_eq!(
        calendar.festivals.get(&15).map(String::as_str),
        Some("上元")
    );
    assert!(!calendar.festivals.contains_key(&361));
    // months 为空（仅日名）时无法界定年长：只查 ≥ 1 界，大键保留。
    let only_day_names = parse_ok(
        r#"{"months":[],"dayNames":["晨露日"],"days_per_month":30,
                "festivals":{"361":"无界保留"}}"#,
    );
    assert_eq!(
        only_day_names.festivals.get(&361).map(String::as_str),
        Some("无界保留")
    );
}

#[test]
fn parse_draft_failure_table_reports_reasons() {
    // daysPerMonth = 0（fiction_time::validate 底线）。
    assert!(parse_err(r#"{"months":["霜月"],"days_per_month":0}"#).contains("每月天数"));
    // 缺每月天数。
    assert!(parse_err(r#"{"months":["霜月"]}"#).contains("缺少每月天数"));
    // 越上界（> 999）。
    assert!(parse_err(r#"{"months":["霜月"],"days_per_month":1000}"#).contains("1000"));
    // 非正整数形态（含浮点小数 / 杂字符串）。
    assert!(parse_err(r#"{"months":["霜月"],"days_per_month":30.5}"#).contains("正整数"));
    assert!(parse_err(r#"{"months":["霜月"],"days_per_month":"三十"}"#).contains("正整数"));
    // months 与 day_names 全空（validate 底线）。
    let reason = parse_err(r#"{"days_per_month":30}"#);
    assert!(reason.contains("月名 / 日名至少其一非空"), "实际：{reason}");
    // 超钳制：65 项月名表。
    let months: Vec<String> = (0..65).map(|i| format!("月{i}")).collect();
    let reason = parse_err(&format!(r#"{{"months":{:?},"days_per_month":30}}"#, months));
    assert!(reason.contains("超过上限 64"), "实际：{reason}");
    // 超钳制：单项 33 字符。
    let long = "甲".repeat(33);
    let reason = parse_err(&format!(r#"{{"months":["{long}"],"days_per_month":30}}"#));
    assert!(reason.contains("超长"), "实际：{reason}");
    // 32 字符恰好放行（钳制边界）。
    let ok = "甲".repeat(32);
    assert!(
        !parse_ok(&format!(r#"{{"months":["{ok}"],"days_per_month":30}}"#))
            .months
            .is_empty()
    );
    // 超钳制：65 条节日（键 1..=65 须全部在年内，故用 999 天/月放大年长）。
    let festivals: Vec<String> = (1..=65).map(|i| format!("\"{i}\":\"节{i}\"")).collect();
    let reason = parse_err(&format!(
        r#"{{"months":["霜月"],"days_per_month":999,"festivals":{{{}}}}}"#,
        festivals.join(",")
    ));
    assert!(reason.contains("超过上限 64"), "实际：{reason}");
    // 根不是对象。
    let value = serde_json::from_str::<serde_json::Value>("[1,2]").unwrap();
    assert_eq!(parse_draft(&value).unwrap_err(), "输出必须是单个 JSON 对象");
    // 多原因聚合（一次修完）：月名表形态错 + 每月天数越界，两条原因并报。
    let reason = parse_err(r#"{"months":"月名","days_per_month":0}"#);
    assert!(reason.contains('；'), "多原因应以「；」聚合：{reason}");
    assert!(reason.contains("月名表 必须是字符串数组") && reason.contains("每月天数"));
}

// ---- draft_calendar 编排（mock HTTP 服务走真实 complete_json 回路）----

#[tokio::test]
async fn draft_success_strips_fences_and_returns_calendar_in_one_call() {
    let (server, captured) = scripted_server(vec![fenced_valid_calendar()]);
    let (_signal, cancel) = crate::infra::llm::cancel_channel();
    let calendar = draft_calendar(
        &client(&server.url()),
        "  修仙世界，一年十二个月  ",
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(calendar.name.as_deref(), Some("白蜡历"));
    assert_eq!(calendar.days_per_month, 30);
    assert_eq!(
        calendar.months,
        vec!["白蜡月".to_string(), "烬月".to_string()]
    );
    assert_eq!(
        calendar.festivals.get(&45).map(String::as_str),
        Some("灯节")
    );
    assert_eq!(captured.lock().unwrap().len(), 1, "合法输出一次调用即成");
    // 请求体：system + user 两消息，描述已 trim。
    let body = captured.lock().unwrap()[0].json();
    assert_eq!(body["messages"].as_array().unwrap().len(), 2);
    assert_eq!(
        body["messages"][1]["content"],
        "【世界观描述】\n修仙世界，一年十二个月\n\n请起草历法，只输出 JSON 对象。"
    );
}

#[tokio::test]
async fn draft_retries_once_with_correction_then_succeeds() {
    let (server, captured) = scripted_server(vec![
        r#"{"name":"坏历","months":["霜月"],"daysPerMonth":0}"#.into(),
        fenced_valid_calendar(),
    ]);
    let (_signal, cancel) = crate::infra::llm::cancel_channel();
    let calendar = draft_calendar(&client(&server.url()), "旧都世界观", &cancel)
        .await
        .unwrap();
    assert_eq!(calendar.days_per_month, 30, "第二次输出应生效");
    let requests = captured.lock().unwrap();
    assert_eq!(requests.len(), 2, "失败后恰好一次修正重试");
    // 第二次请求 = 原 prompt + assistant 回放 + 修正指令（指出原因）。
    let messages = requests[1].json()["messages"].as_array().unwrap().clone();
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[2]["role"], "assistant");
    assert!(messages[2]["content"]
        .as_str()
        .unwrap()
        .contains("daysPerMonth"));
    assert_eq!(messages[3]["role"], "user");
    let correction = messages[3]["content"].as_str().unwrap();
    assert!(
        correction.contains("每月天数"),
        "修正指令应携带原因：{correction}"
    );
    assert!(correction.contains("只输出 JSON"));
}

#[tokio::test]
async fn draft_fails_after_single_correction_retry() {
    let (server, captured) = scripted_server(vec![
        r#"{"months":["霜月"],"daysPerMonth":0}"#.into(),
        r#"{"months":[],"dayNames":[],"daysPerMonth":0}"#.into(),
    ]);
    let (_signal, cancel) = crate::infra::llm::cancel_channel();
    let err = draft_calendar(&client(&server.url()), "旧都世界观", &cancel)
        .await
        .unwrap_err();
    match err {
        CalendarDraftError::InvalidOutput(reason) => {
            assert!(
                reason.contains("每月天数") || reason.contains("月名 / 日名"),
                "原因：{reason}"
            );
        }
        other => panic!("应为 InvalidOutput：{other:?}"),
    }
    assert_eq!(captured.lock().unwrap().len(), 2, "修正重试至多一次");
}

#[tokio::test]
async fn draft_rejects_blank_and_overlong_description_without_network() {
    let (server, captured) = scripted_server(vec![fenced_valid_calendar()]);
    let llm = client(&server.url());
    let (_signal, cancel) = crate::infra::llm::cancel_channel();

    // 空白 → InvalidDescription，零网络。
    for blank in ["", "   ", "\n\t "] {
        let err = draft_calendar(&llm, blank, &cancel).await.unwrap_err();
        assert_eq!(
            err,
            CalendarDraftError::InvalidDescription("描述内容为空：请先填写世界观描述".into())
        );
    }
    // 4001 字符 → 拒绝并给出明确上限；4000 字符恰好放行（边界走真实调用）。
    let boundary = "甲".repeat(MAX_DESCRIPTION_CHARS);
    assert!(draft_calendar(&llm, &boundary, &cancel).await.is_ok());
    let overlong = "甲".repeat(MAX_DESCRIPTION_CHARS + 1);
    let err = draft_calendar(&llm, &overlong, &cancel).await.unwrap_err();
    assert!(
        matches!(err, CalendarDraftError::InvalidDescription(ref m) if m.contains("4001") && m.contains("4000"))
    );
    assert_eq!(captured.lock().unwrap().len(), 1, "参数错误不发起调用");
}

#[tokio::test]
async fn draft_cancelled_before_call_makes_no_request() {
    let (server, captured) = scripted_server(vec![fenced_valid_calendar()]);
    let (signal, cancel) = crate::infra::llm::cancel_channel();
    signal.cancel();
    let err = draft_calendar(&client(&server.url()), "旧都世界观", &cancel)
        .await
        .unwrap_err();
    assert_eq!(err, CalendarDraftError::Cancelled);
    assert!(captured.lock().unwrap().is_empty(), "已取消不得发起请求");
}

// ---- 模型解析 ----

#[test]
fn resolve_draft_llm_requires_active_selection() {
    use crate::infra::config::{Config, ProviderConfig};
    // 无 provider → 明确文案。
    let empty = Config::new_with_defaults();
    let err = resolve_draft_llm(&empty).unwrap_err();
    assert!(err.contains("未配置全局默认模型"), "实际：{err}");

    // 有 provider + active_model → 主模型（非导演模型）。
    let mut config = Config::new_with_defaults();
    config.providers = vec![ProviderConfig {
        id: "p1".into(),
        name: "测试".into(),
        base_url: "https://example.invalid/v1".into(),
        api_key: "k".into(),
        models: vec!["m1".into(), "m2".into()],
        model: None,
    }];
    config.active_provider_id = Some("p1".into());
    config.active_model = Some("m2".into());
    let llm = resolve_draft_llm(&config).unwrap();
    assert_eq!(llm.config().model, "m2");
    assert_eq!(llm.config().base_url, "https://example.invalid/v1");

    // active_model 未选 → 回落该服务第一个模型。
    config.active_model = None;
    assert_eq!(resolve_draft_llm(&config).unwrap().config().model, "m1");
}

// ---- 调用轨迹 kind 接线（透明化功能）：draft 类别 + 无会话（session_id None）----

/// 轨迹收集器：挂在起草客户端上验证起草调用落 draft 轨迹。
struct TraceCollector(std::sync::Mutex<Vec<crate::domain::models::NewLlmCall>>);
impl crate::infra::llm::LlmCallSink for TraceCollector {
    fn record(&self, call: crate::domain::models::NewLlmCall) {
        self.0.lock().unwrap().push(call);
    }
}

#[tokio::test]
async fn draft_records_trace_without_session() {
    use crate::domain::models::{LlmCallKind, LlmCallStatus};
    let (server, captured) = scripted_server(vec![fenced_valid_calendar()]);
    let (_signal, cancel) = crate::infra::llm::cancel_channel();
    let collector = Arc::new(TraceCollector(std::sync::Mutex::new(Vec::new())));
    let llm = client(&server.url()).with_call_sink(collector.clone());

    draft_calendar(&llm, "旧都世界观", &cancel).await.unwrap();

    let records = collector.0.lock().unwrap().clone();
    assert_eq!(records.len(), 1, "一次合法起草恰好一条轨迹");
    let call = &records[0];
    assert_eq!(call.session_id, None, "起草发生在会话之外");
    assert_eq!(call.kind, LlmCallKind::Draft);
    assert_eq!(call.status, LlmCallStatus::Ok);
    assert_eq!(captured.lock().unwrap().len(), 1);
}
