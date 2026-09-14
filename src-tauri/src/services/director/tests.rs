//! 本体（super）的单测：自 services/director.rs 尾部的 `mod tests` 外置（500 行规范；测试代码逐字搬移，断言零改动）。

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
                { "instance_id": 1, "scope": "state", "key": "情绪", "value": "释然", "expiry": "scene_end" },
                { "instance_id": 1, "clear": "别扭" }
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
    assert!(serde_json::from_str::<DirectorVerdict>(r#"{"states": [{"instance_id": 1}]}"#).is_err());
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
                    {"instance_id": 1, "scope": "state", "key": "情绪", "value": "释然", "expiry": "event:亮灯"},
                    {"instance_id": 1, "scope": "relation", "key": "对店主", "value": "信任"},
                    {"instance_id": 1, "clear": "别扭"}
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
                    {"instance_id": 1, "scope": "mood", "key": "情绪", "value": "释然"},
                    {"instance_id": 1, "scope": "state", "key": "  ", "value": "释然"},
                    {"instance_id": 1, "scope": "state", "key": "持有", "value": " "},
                    {"instance_id": 1, "scope": "state", "key": "情绪", "value": "平静", "expiry": "明天"},
                    {"instance_id": 1, "scope": "state", "key": "衣着", "value": "斗篷", "expiry": "  "}
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
                    {"instance_id": 999, "scope": "state", "key": "情绪", "value": "串场"},
                    {"instance_id": 999, "clear": "别扭"},
                    {"instance_id": 1, "scope": "state", "key": "情绪", "value": "守场"}
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
            Message { id: i + 1, session_id: 1, role, content: format!("m{i}"), reasoning: None, think_ms: None, tokens: None, created_at: i, interrupt_flag: None, scene_id: None, instance_id: None, deleted_at: None }
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
            instance_id: None,
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
        instance_id: None,
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

use crate::domain::models::{NewCharacter, NewMessage, NewSession, RosterPick};
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

/// 结算集成夹具：阵容「旅人（用户位）+ 苏鸢（LLM 位，roster 首位 → 实例 id 1）」
/// 加会话与 user / assistant（含 ---）两条消息，
/// 返回 (storage, dir, session_id, llm_instance_id, trigger_id)。
fn settlement_setup(tag: &str) -> (Arc<Storage>, PathBuf, i64, i64, i64) {
    let (raw, dir) = temp_storage(tag);
    let storage = Arc::new(raw);
    let llm_card = storage
        .create_character(&NewCharacter { name: "苏鸢".into(), ..Default::default() })
        .unwrap()
        .id;
    let user_card = storage
        .create_character(&NewCharacter { name: "旅人".into(), ..Default::default() })
        .unwrap()
        .id;
    let session_id = storage
        .create_session(&NewSession {
            roster: vec![
                RosterPick { character_id: llm_card, is_user: false },
                RosterPick { character_id: user_card, is_user: true },
            ],
            title: String::new(),
            opening: None,
        
            default_render_style: "type".to_string(),
        })
        .unwrap()
        .id;
    let char_id = storage
        .list_instances(session_id)
        .unwrap()
        .into_iter()
        .find(|i| !i.is_user)
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
        near_scenes: crate::domain::context::SETTLED_SCENES_IN_NEAR,
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
            instance_id: char_id,
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
            r#"{"location":"旧书店 · 打烊后","time_note":"次日清晨","fic_day":2,"fic_part":"清晨","summary":"钟楼下的对峙无果而终","recap":"对峙从一句口信误会开始。两人在钟楼下的巷口对望。最后她转身走进夜色。","present":[1],"states":[{"instance_id":1,"scope":"state","key":"情绪","value":"释然","expiry":"scene_end"},{"instance_id":1,"clear":"别扭"}]}"#,
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
    let mut expected_present: Vec<i64> = storage
        .list_instances(session_id)
        .unwrap()
        .iter()
        .map(|i| i.id)
        .collect();
    expected_present.sort_unstable();
    assert_eq!(
        newest.present,
        expected_present,
        "§7-7 多角色化：在场恒为全部实例（创建序 id ASC，与锚行同序）"
    );
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

// ---- 调用轨迹 kind 接线（透明化功能）：director 类别 + 每次重试各一条 ----

/// 轨迹收集器：挂在导演客户端上验证结算裁决每次调用落 director 轨迹。
struct TraceCollector(std::sync::Mutex<Vec<crate::domain::llm_call::NewLlmCall>>);
impl crate::infra::llm::LlmCallSink for TraceCollector {
    fn record(&self, call: crate::domain::llm_call::NewLlmCall) {
        self.0.lock().unwrap().push(call);
    }
}

/// Json 失败重试：两次调用各落一条轨迹——首条 status error（带原因），
/// 次条 status ok；kind 均为 director、会话定位一致。
#[tokio::test]
async fn run_settlement_records_one_trace_per_attempt() {
    use crate::domain::llm_call::{LlmCallKind, LlmCallStatus};
    let (storage, dir, session_id, _char_id, _trigger_id) = settlement_setup("dir_trace");
    let attempts = Arc::new(AtomicUsize::new(0));
    let counter = attempts.clone();
    let server = MockServer::start(move |_req, stream| {
        let nth = counter.fetch_add(1, Ordering::SeqCst);
        if nth == 0 {
            let _ = json_body(stream, "抱歉，我无法输出 JSON。");
        } else {
            let _ = json_body(stream, r#"{"fic_day":2,"summary":"重试后的裁决"}"#);
        }
    });
    let collector = Arc::new(TraceCollector(std::sync::Mutex::new(Vec::new())));
    let llm = Arc::new(director_client(&server.url()).with_call_sink(collector.clone()));
    let deps = GenerationDeps {
        storage: storage.clone(),
        sink: Arc::new(NoopSink),
        llm: llm.clone(),
        director_llm: Some(llm),
        near_scenes: crate::domain::context::SETTLED_SCENES_IN_NEAR,
    };
    let registry = GenerationRegistry::new();
    let ticket = registry.begin(session_id).unwrap();
    run_settlement(&deps, &ticket, &trigger_of(&storage, session_id)).await;
    assert!(attempts.load(Ordering::SeqCst) >= 2, "Json 失败后必须重试");

    let records = collector.0.lock().unwrap().clone();
    assert_eq!(records.len(), 2, "每次结算尝试各一条轨迹");
    assert!(records.iter().all(|call| call.session_id == Some(session_id)));
    assert!(records.iter().all(|call| call.kind == LlmCallKind::Director));
    assert_eq!(records[0].status, LlmCallStatus::Error);
    assert!(records[0].error_text.is_some(), "失败尝试留原因");
    assert_eq!(records[1].status, LlmCallStatus::Ok);
    assert_eq!(records[1].response_text.as_deref(), Some(r#"{"fic_day":2,"summary":"重试后的裁决"}"#));
    drop(storage);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 手动清除 × 结算清算语义（FR-012 手动清除，Task-09 验收核心）：状态行被手动清除
/// （soft_delete 置墓碑，clear_character_state IPC 命令委托的同一存储原语）后，
/// 「会复活该状态的结算路径」不得把该键带回在世账本——墓碑行不进 list 读路径 →
/// 结算 prompt 的【当前状态集】不含该键（模型无从维护）；裁决对已清除键再发 clear
/// 时 build_write 只映射手头在世行 → 幂等跳过；ADR-009 宁可缺失、不虚构复活。
#[tokio::test]
async fn run_settlement_does_not_resurrect_manually_cleared_state() {
    let (storage, dir, session_id, char_id, _trigger_id) = settlement_setup("dir_clear");
    let stale = storage
        .upsert_character_state(&NewCharacterState {
            instance_id: char_id,
            scope: CharacterStateScope::State,
            key: "别扭".into(),
            value: "欲言又止".into(),
            expiry: None,
            source_scene: None,
        })
        .unwrap();
    // 手动清除：行立即从账本读路径消失。
    storage.soft_delete_character_state(stale.id).unwrap();
    assert!(storage.list_character_states(session_id).unwrap().is_empty());

    // 会复活该键的结算路径：裁决对已清除的键再发 clear（模拟模型从叙事上下文捡回
    // 旧键），同时 upsert 新键「情绪」以证明结算本身照常落库。
    let captured: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let cap = captured.clone();
    let server = MockServer::start(move |req, stream| {
        cap.lock().unwrap().push(req.json());
        let _ = json_body(
            stream,
            r#"{"location":"旧书店 · 打烊后","time_note":"次日清晨","fic_day":2,"fic_part":"清晨","summary":"钟楼下的对峙无果而终","present":[1],"states":[{"instance_id":1,"clear":"别扭"},{"instance_id":1,"scope":"state","key":"情绪","value":"释然","expiry":"scene_end"}]}"#,
        );
    });
    let registry = GenerationRegistry::new();
    let ticket = registry.begin(session_id).unwrap();
    let deps = deps_with_director(&storage, &server.url());
    run_settlement(&deps, &ticket, &trigger_of(&storage, session_id)).await;

    // 不复活的机制证据：prompt 状态集不含已清除键（墓碑不进读路径）。
    let user = captured.lock().unwrap()[0]["messages"][1]["content"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(!user.contains("别扭"), "结算 prompt 不得含已清除键：{user}");
    // 结算成功落库（「情绪」已上账），但「别扭」不被复活。
    let states = storage.list_character_states(session_id).unwrap();
    assert_eq!(states.len(), 1, "只有新键「情绪」上账，「别扭」不得复活");
    assert_eq!(states[0].key, "情绪");
    // 墓碑行本体未动：仍处已删态（重复清除报 NotFound，墓碑不会被打捞）。
    assert!(
        storage.soft_delete_character_state(stale.id).is_err(),
        "墓碑行不得复活"
    );
    drop(storage);
    let _ = std::fs::remove_dir_all(&dir);
}
