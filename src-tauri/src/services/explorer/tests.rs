//! 本体（super）的单测：自 services/explorer.rs 尾部的 `mod tests` 外置（500 行规范；测试代码逐字搬移，断言零改动）。

// ---------------------------------------------------------------------------
// 测试：mock LLM 脚本驱动多轮工具回路（同一模式沿用 infra/llm/tests.rs），
// 存储用临时库（真实 list_messages / list_scenes，含 FR-014 锚行 seed）。
// ---------------------------------------------------------------------------

use super::*;
use crate::domain::models::{CharacterInstance, MessageRole, NewCharacter, NewMessage, NewSession, RosterPick};
use crate::infra::llm::mock::{json_raw_body, status_head, MockServer};
use crate::infra::llm::{cancel_channel, LlmConfig, RetryPolicy};
use crate::infra::storage::test_support::temp_storage;
use crate::infra::storage::Storage;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// 零重试客户端（既有 generation.rs 测试同款）。
fn client(url: &str) -> LlmClient {
    LlmClient::new(LlmConfig {
        base_url: url.to_owned(),
        api_key: "test".into(),
        model: "test-model".into(),
        api: crate::infra::llm::ProviderApi::OpenAi,
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

/// 静默 sink：忽略全部事件（不关心活动事件的既有测试沿用）。
struct NoopSink;
impl EventSink for NoopSink {
    fn emit(&self, _event: LlmEvent) {}
}

/// 事件收集器（Task-06）：记录全部 LlmEvent 供活动事件断言。
struct RecordingSink(Mutex<Vec<LlmEvent>>);
impl EventSink for RecordingSink {
    fn emit(&self, event: LlmEvent) {
        self.0.lock().unwrap().push(event);
    }
}

/// 取出已收集的活动事件（(phase, detail) 投影）。
fn activities(sink: &RecordingSink) -> Vec<(ActivityPhase, Option<String>)> {
    sink.0
        .lock()
        .unwrap()
        .iter()
        .filter_map(|event| match event {
            LlmEvent::Activity { phase, detail, .. } => Some((*phase, detail.clone())),
            _ => None,
        })
        .collect()
}

/// tool_calls 响应体（arguments 是 JSON 字符串，经 json! 宏正确转义）。
fn tool_calls_body(id: &str, name: &str, arguments: &str) -> String {
    serde_json::json!({
        "choices": [{
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": id,
                    "type": "function",
                    "function": { "name": name, "arguments": arguments }
                }]
            }
        }]
    })
    .to_string()
}

/// 纯正文响应体。
fn content_body(text: &str) -> String {
    serde_json::json!({
        "choices": [{ "message": { "role": "assistant", "content": text } }]
    })
    .to_string()
}

type Captured = Arc<Mutex<Vec<serde_json::Value>>>;

/// 逐连接脚本 mock：按序回放 bodies（越界回放最后一个），可选捕获请求体。
fn scripted_server(bodies: Vec<String>, captured: Option<Captured>) -> (MockServer, Arc<AtomicUsize>) {
    let counter = Arc::new(AtomicUsize::new(0));
    let n = counter.clone();
    let server = MockServer::start(move |req, stream| {
        if let Some(cap) = &captured {
            cap.lock().unwrap().push(req.json());
        }
        let index = n.fetch_add(1, Ordering::SeqCst).min(bodies.len() - 1);
        let _ = json_raw_body(stream, &bodies[index]);
    });
    (server, counter)
}

/// 临时库 + 阵容（旅人用户位 + 苏鸢 LLM 位）+ 会话（create_session 已 seed 开场
/// 锚行，FR-014），返回 (storage, session_id, 实例列表) 供 explore 的指认入参。
fn storage_with_session(tag: &str) -> (Arc<Storage>, i64, Vec<CharacterInstance>) {
    let (raw, _dir) = temp_storage(tag);
    let storage = Arc::new(raw);
    let user_card = storage
        .create_character(&NewCharacter { name: "旅人".into(), ..Default::default() })
        .unwrap();
    let llm_card = storage
        .create_character(&NewCharacter { name: "苏鸢".into(), ..Default::default() })
        .unwrap();
    let session_id = storage
        .create_session(&NewSession {
            roster: vec![
                RosterPick { character_id: llm_card.id, is_user: false },
                RosterPick { character_id: user_card.id, is_user: true },
            ],
            title: String::new(),
            opening: None,
        
            default_render_style: "type".to_string(),
        })
        .unwrap()
        .id;
    let instances = storage.list_instances(session_id).unwrap();
    (storage, session_id, instances)
}

/// 纯内存消息构造（盖章形态测试用，与库读出的 Message 同构）。
fn stamped_message(id: i64, role: MessageRole, content: &str, scene_id: Option<i64>) -> Message {
    Message {
        id,
        session_id: 1,
        role,
        content: content.to_string(),
        reasoning: None,
        think_ms: None,
        tokens: None,
        created_at: id,
        interrupt_flag: None,
        scene_id,
        instance_id: None,
        deleted_at: None,
    }
}

/// 纯内存场景行构造（指定行 id / idx，盖章锚定测试需要二者对上）。
fn scene_row(id: i64, idx: i64) -> Scene {
    Scene {
        id,
        session_id: 1,
        idx,
        location: Some(format!("地点{idx}")),
        time_note: None,
        fic_day: Some(idx),
        fic_part: Some("夜".into()),
        date_label: None,
        summary: Some(format!("场{idx}摘要")),
        recap: None,
        present: vec![1],
        deleted_at: None,
    }
}

/// 快车道：研究员首轮直接 Content（零工具调用）→ None，且只发一次请求。
#[tokio::test]
async fn fast_path_content_without_tools_returns_none() {
    let (storage, sid, instances) = storage_with_session("exp_fast");
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::User, "今天天气如何"))
        .unwrap();
    let (server, counter) = scripted_server(vec![content_body("无需检索")], None);
    let (_signal, cancel) = cancel_channel();

    let out = explore(
        storage.as_ref(),
        &client(&server.url()),
        &NoopSink,
        MessageIds { session_id: sid, message_id: -1 },
        "今天天气如何",
        &instances,
        &cancel,
    )
    .await;

    assert_eq!(out, None, "快车道无卷宗");
    assert_eq!(counter.load(Ordering::SeqCst), 1, "恰好一次 LLM 调用");
}

/// 单轮工具往返：tool_calls → 本地执行（真实命中库中消息）→ tool 回填 → Content
/// 卷宗 Some；第二轮请求的 wire 形态（assistant tool_calls 原样回传 + tool 结果）。
#[tokio::test]
async fn single_tool_roundtrip_returns_dossier() {
    let (storage, sid, instances) = storage_with_session("exp_round");
    storage
        .insert_message(&NewMessage::new(
            sid,
            MessageRole::User,
            "上次我们在钟楼下分食了一块饼，把信物埋在了树下。",
        ))
        .unwrap();
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::Assistant, "她把饼掰成两半。"))
        .unwrap();
    let dossier = "卷宗：\n- 场0：两人曾在钟楼下分食一块饼，并把信物埋在树下。";
    let captured: Captured = Arc::new(Mutex::new(Vec::new()));
    let (server, _counter) = scripted_server(
        vec![
            tool_calls_body("call_1", "search_history", r#"{"keyword":"信物"}"#),
            content_body(dossier),
        ],
        Some(captured.clone()),
    );
    let (_signal, cancel) = cancel_channel();

    let out = explore(
        storage.as_ref(),
        &client(&server.url()),
        &NoopSink,
        MessageIds { session_id: sid, message_id: -1 },
        "埋下的信物还在吗？",
        &instances,
        &cancel,
    )
    .await;

    // Task-06：卷宗换行压平后返回（注入面防御，压平行为另测）。
    assert_eq!(out.as_deref(), Some("卷宗： - 场0：两人曾在钟楼下分食一块饼，并把信物埋在树下。"));
    let requests = captured.lock().unwrap().clone();
    assert_eq!(requests.len(), 2, "两轮：工具调用 + 卷宗总结");
    let second = &requests[1];
    let msgs = second["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 4, "system + user + assistant(tool_calls) + tool 回填");
    assert_eq!(msgs[2]["role"], "assistant");
    assert_eq!(msgs[2]["tool_calls"][0]["id"], "call_1");
    assert_eq!(msgs[2]["tool_calls"][0]["function"]["name"], "search_history");
    assert_eq!(msgs[3]["role"], "tool");
    assert_eq!(msgs[3]["tool_call_id"], "call_1");
    let tool_content = msgs[3]["content"].as_str().unwrap();
    assert!(tool_content.contains("命中 1 条"), "真实命中库中消息：{tool_content}");
    assert!(tool_content.contains("钟楼"), "命中引文在场定位行内：{tool_content}");
    assert!(tool_content.contains("[user]"), "命中带角色前缀：{tool_content}");
}

/// 3 轮工具上限：第 4 轮强制收尾（请求不再带 tools 键），Content 即卷宗。
#[tokio::test]
async fn tool_round_cap_forces_wrap_up_without_tools() {
    let (storage, sid, instances) = storage_with_session("exp_cap");
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::User, "那天的事你还记得吗"))
        .unwrap();
    let round = tool_calls_body("call_n", "search_history", r#"{"keyword":"那天"}"#);
    let captured: Captured = Arc::new(Mutex::new(Vec::new()));
    let (server, _counter) = scripted_server(
        vec![
            round.clone(),
            round.clone(),
            round,
            content_body("卷宗：三轮检索后的事实汇总。"),
        ],
        Some(captured.clone()),
    );
    let (_signal, cancel) = cancel_channel();

    let out = explore(
        storage.as_ref(),
        &client(&server.url()),
        &NoopSink,
        MessageIds { session_id: sid, message_id: -1 },
        "那天的事",
        &instances,
        &cancel,
    )
    .await;

    assert_eq!(out.as_deref(), Some("卷宗：三轮检索后的事实汇总。"));
    let requests = captured.lock().unwrap().clone();
    assert_eq!(requests.len(), 4, "3 轮工具 + 1 轮收尾");
    for (index, body) in requests.iter().enumerate() {
        if index < 3 {
            assert!(body.get("tools").is_some(), "前 3 轮带工具：{body}");
        } else {
            assert!(
                body.get("tools").is_none(),
                "收尾轮不再带 tools（空切片等同未提供）：{body}"
            );
        }
    }
}

/// 未知工具名：回错误文本不 abort，回路继续，最终 Content 卷宗照常产出。
#[tokio::test]
async fn unknown_tool_name_returns_error_text_and_continues() {
    let (storage, sid, instances) = storage_with_session("exp_unknown");
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::User, "还记得吗"))
        .unwrap();
    let captured: Captured = Arc::new(Mutex::new(Vec::new()));
    let (server, _counter) = scripted_server(
        vec![
            tool_calls_body("call_1", "nonexistent_tool", "{}"),
            content_body("卷宗：改用可用工具后的结论。"),
        ],
        Some(captured.clone()),
    );
    let (_signal, cancel) = cancel_channel();

    let out = explore(
        storage.as_ref(),
        &client(&server.url()),
        &NoopSink,
        MessageIds { session_id: sid, message_id: -1 },
        "还记得吗",
        &instances,
        &cancel,
    )
    .await;

    assert_eq!(out.as_deref(), Some("卷宗：改用可用工具后的结论。"));
    let msgs = captured.lock().unwrap()[1]["messages"].as_array().unwrap().clone();
    let tool_content = msgs[3]["content"].as_str().unwrap();
    assert!(
        tool_content.contains("未知工具") && tool_content.contains("nonexistent_tool"),
        "未知工具以文本回告：{tool_content}"
    );
}

/// 非法 JSON arguments：回「参数格式错误」文本，不 abort 不 panic，回路继续。
#[tokio::test]
async fn invalid_json_arguments_tolerated() {
    let (storage, sid, instances) = storage_with_session("exp_badargs");
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::User, "还记得吗"))
        .unwrap();
    let captured: Captured = Arc::new(Mutex::new(Vec::new()));
    let (server, _counter) = scripted_server(
        vec![
            tool_calls_body("call_1", "search_history", "{bad json"),
            content_body("卷宗：参数修正后的结论。"),
        ],
        Some(captured.clone()),
    );
    let (_signal, cancel) = cancel_channel();

    let out = explore(
        storage.as_ref(),
        &client(&server.url()),
        &NoopSink,
        MessageIds { session_id: sid, message_id: -1 },
        "还记得吗",
        &instances,
        &cancel,
    )
    .await;

    assert_eq!(out.as_deref(), Some("卷宗：参数修正后的结论。"));
    let msgs = captured.lock().unwrap()[1]["messages"].as_array().unwrap().clone();
    let tool_content = msgs[3]["content"].as_str().unwrap();
    assert!(tool_content.contains("参数格式错误"), "非法 JSON 以文本回告：{tool_content}");
}

/// LLM 失败降级（硬约束）：持续 5xx + retry(1) 重试耗尽 → None，共 2 次连接。
#[tokio::test]
async fn llm_failure_degrades_to_none() {
    let (storage, sid, instances) = storage_with_session("exp_5xx");
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::User, "上次说的那件事"))
        .unwrap();
    let server = MockServer::start(|_req, stream| {
        let _ = status_head(stream, 500, "Internal Server Error");
    });
    let llm = LlmClient::new(LlmConfig {
        base_url: server.url(),
        api_key: "test".into(),
        model: "test-model".into(),
        api: crate::infra::llm::ProviderApi::OpenAi,
        connect_timeout_ms: 2_000,
        read_timeout_ms: 2_000,
        retry: RetryPolicy {
            max_retries: 1,
            initial_backoff_ms: 0,
            backoff_multiplier: 1,
            max_backoff_ms: 0,
        },
    })
    .unwrap();
    let (_signal, cancel) = cancel_channel();

    let out = explore(storage.as_ref(), &llm, &NoopSink, MessageIds { session_id: sid, message_id: -1 }, "上次说的那件事", &instances, &cancel).await;

    assert_eq!(out, None, "探索失败降级无卷宗，不向上抛错");
    assert_eq!(server.connection_count(), 2, "重试一次后耗尽");
}

/// 取消：每轮往返间的检查点命中 → None 且不再发起调用。
#[tokio::test]
async fn cancelled_explore_returns_none_without_calling() {
    let (storage, sid, instances) = storage_with_session("exp_cancel");
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::User, "还记得吗"))
        .unwrap();
    let (server, counter) = scripted_server(vec![content_body("不该被请求到")], None);
    let (signal, cancel) = cancel_channel();
    signal.cancel();

    let out = explore(
        storage.as_ref(),
        &client(&server.url()),
        &NoopSink,
        MessageIds { session_id: sid, message_id: -1 },
        "还记得吗",
        &instances,
        &cancel,
    )
    .await;

    assert_eq!(out, None);
    assert_eq!(counter.load(Ordering::SeqCst), 0, "已取消不再发起 LLM 调用");
}

/// 检索面封顶：总命中 ≤ 8 条、单条引文截断（纯函数路径，LLM 回路不参与）。
#[test]
fn search_history_caps_hits_and_truncates_quotes() {
    let (storage, sid, _instances) = storage_with_session("exp_caps");
    // 10 条含关键词的消息（第 3 条超长验证截断）。
    for i in 0..10 {
        let content = if i == 2 {
            format!("灯塔{i}{}", "字".repeat(500))
        } else {
            format!("灯塔{i}的旧事")
        };
        storage
            .insert_message(&NewMessage::new(sid, MessageRole::User, &content))
            .unwrap();
    }
    let messages = storage.list_messages(sid).unwrap();
    let scenes = storage.list_scenes(sid).unwrap();

    let out = search_history("灯塔", &messages, &scenes, &[]);

    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 1 + HIT_LIMIT, "标题行 + 恰好 8 条命中：{out}");
    assert!(out.starts_with("命中 8 条"), "总命中封顶：{out}");
    let long_hit = lines.iter().find(|l| l.contains("灯塔2")).unwrap();
    assert!(long_hit.ends_with('…'), "超长引文截断补省略号：{long_hit}");
    assert!(long_hit.chars().count() <= "[场0] [user] ".chars().count() + HIT_QUOTE_MAX_CHARS + 1);
    assert!(lines.iter().skip(1).all(|l| l.contains("[场0]")), "场定位前缀：{out}");
}

/// read_scene：按场号取整场原文（含场景线的触发行归收束场；末行 = 进行中场），
/// 越界场号回可用清单。
#[test]
fn read_scene_returns_whole_scene_and_rejects_unknown() {
    let (storage, sid, _instances) = storage_with_session("exp_read");
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::User, "场一问"))
        .unwrap();
    storage
        .insert_message(&NewMessage::new(
            sid,
            MessageRole::Assistant,
            "场一答\n\n---\n\n场二开场",
        ))
        .unwrap();
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::User, "场二问"))
        .unwrap();
    // 补一行已结算形态的场景行（对齐真实结算后的行布局：锚行 + 场一行，
    // 场一线的结算本会创建它并把 (0..=m2] 挂到锚行）。
    storage
        .insert_scene(&crate::domain::models::NewScene {
            session_id: sid,
            location: Some("场二".into()),
            time_note: None,
            fic_day: Some(2),
            fic_part: Some("夜".into()),
            date_label: None,
            summary: None,
            recap: None,
            present: vec![1],
        })
        .unwrap();
    let messages = storage.list_messages(sid).unwrap();
    let scenes = storage.list_scenes(sid).unwrap();
    assert_eq!(scenes.len(), 2, "锚行 + 场一行（场二线未结算 = 进行中）");

    // 场0（锚行）= 收束段整场：触发行原文在内，归收束场。
    let first = read_scene(0, &messages, &scenes, &[]);
    assert!(first.starts_with("【场0】共 2 条消息"), "锚行整场：{first}");
    assert!(first.contains("[user] 场一问"));
    assert!(first.contains("[assistant] 场一答\n\n---\n\n场二开场"), "触发行原文在内");

    // 场1（末行）= 进行中场：场景线之后的全量。
    let second = read_scene(1, &messages, &scenes, &[]);
    assert!(second.starts_with("【场1】共 1 条消息"), "末行归进行中场：{second}");
    assert!(second.contains("[user] 场二问"));

    let missing = read_scene(7, &messages, &scenes, &[]);
    assert!(missing.contains("未找到场景 7"), "越界场号回可用清单：{missing}");
    assert!(missing.contains('0') && missing.contains('1'), "清单含可用场号：{missing}");
}

/// read_scene 按 scene_id 命中（库内归属优先，欠账夹缝不错位）：行 id → 盖章段
/// 精确取原文；中部欠账消息（NULL、场景线已出现但结算未落）不被位置对齐误归
/// 给邻行——旧版内容切分在此形态下会把欠账段错配给该行。
#[test]
fn read_scene_hits_stamped_span_by_scene_id() {
    // 行布局：1=锚行(idx0)、2=已收束行(idx1)、3=进行中 header(idx2)。
    let scenes = vec![scene_row(1, 0), scene_row(2, 1), scene_row(3, 2)];
    let messages = vec![
        stamped_message(1, MessageRole::User, "场零问", Some(1)),
        stamped_message(2, MessageRole::Assistant, "场零答\n\n---\n\n新场", Some(1)),
        // 中部欠账段（NULL，m4 带场景线）：逻辑上不属于任何行
        stamped_message(3, MessageRole::User, "欠账问", None),
        stamped_message(4, MessageRole::Assistant, "欠账答\n\n---\n\n再新场", None),
        stamped_message(5, MessageRole::User, "真场问", Some(2)),
        stamped_message(6, MessageRole::Assistant, "真场答", Some(2)),
        stamped_message(7, MessageRole::User, "进行中问", None),
    ];

    // 场0（锚行 id 1）→ 盖章段 m1-m2 原文（触发行在内）。
    let zero = read_scene(0, &messages, &scenes, &[]);
    assert!(zero.starts_with("【场0】共 2 条消息"), "锚行整场：{zero}");
    assert!(zero.contains("[user] 场零问") && zero.contains("场零答"));

    // 场1（行 id 2）→ 盖章段 m5-m6；欠账消息 m3/m4 不被误归（旧版位置对齐
    // 会取到 closed[1] = 欠账段）。
    let first = read_scene(1, &messages, &scenes, &[]);
    assert!(first.starts_with("【场1】共 2 条消息"), "按 id 命中盖章段：{first}");
    assert!(first.contains("真场问") && first.contains("真场答"), "真场原文在内：{first}");
    assert!(!first.contains("欠账"), "欠账段不误归给行 2：{first}");

    // 场2（末行）→ 进行中场（NULL 尾）。
    let ongoing = read_scene(2, &messages, &scenes, &[]);
    assert!(ongoing.starts_with("【场2】共 1 条消息"), "末行归进行中场：{ongoing}");
    assert!(ongoing.contains("[user] 进行中问"));
}

/// read_scene 回退路径（无盖章形态 → 内容位置对齐）与「无消息记录」提示语义：
/// 行存在但既无盖章段、又非末行、位置对齐越界 → 空段提示（重生成清空后的
/// 常见形态），不 panic。
#[test]
fn read_scene_falls_back_and_reports_missing_messages() {
    let scenes = vec![scene_row(1, 0), scene_row(2, 1), scene_row(3, 2)];
    // 全 NULL（无盖章）：场0 走内容位置对齐（closed[0] = m1-m2，与旧版同界）。
    let messages = vec![
        stamped_message(1, MessageRole::User, "场一问", None),
        stamped_message(2, MessageRole::Assistant, "场一答\n\n---\n\n新场", None),
        stamped_message(3, MessageRole::User, "进行中问", None),
    ];

    let zero = read_scene(0, &messages, &scenes, &[]);
    assert!(zero.starts_with("【场0】共 2 条消息"), "回退内容位置对齐：{zero}");
    assert!(zero.contains("[assistant] 场一答"), "触发行原文在内：{zero}");

    // 行 2：无盖章段、非末行、closed 仅 1 段 → 既有「无消息记录」语义保留。
    let empty = read_scene(1, &messages, &scenes, &[]);
    assert!(
        empty.contains("场景 1 无消息记录"),
        "空段 / 越界定位回提示文本：{empty}"
    );

    let ongoing = read_scene(2, &messages, &scenes, &[]);
    assert!(ongoing.contains("[user] 进行中问"), "末行归进行中场：{ongoing}");
}

/// read_scene 错位档（空段行在前 + 盖章段在后，重生成清空的可达形态）：行 A 无
/// 盖章段（旧行软删后收敛为空段），其后行 B 有盖章段——旧守卫只查下标
/// （position < closed.len()），会把 closed[0] = span(B) 的正文冒充行 A 内容。
/// 回退档收窄为「全无盖章段」的纯内容切分形态后，此形态必须回「无消息记录」
/// 且不含 B 的正文（prompt.rs §7-3：被清空的场收敛为空段——行还在但消息没了）。
#[test]
fn read_scene_misaligned_reports_missing_instead_of_other_scene() {
    // 行布局：1=行A(idx1，重生成清空)、2=行B(idx2，已盖章)、3=进行中 header(idx3)。
    let scenes = vec![scene_row(1, 1), scene_row(2, 2), scene_row(3, 3)];
    // 历史：行 B 的盖章段在场，行 A 的段已随重生成软删（list 后不出现），
    // 行 A 无任何盖章段 → 旧行为会按位置取到 closed[0] = span(B)。
    let messages = vec![
        stamped_message(5, MessageRole::User, "乙场问", Some(2)),
        stamped_message(6, MessageRole::Assistant, "乙场答", Some(2)),
        stamped_message(7, MessageRole::User, "进行中问", None),
    ];

    // 场1（行 A，空段）：不得取到 B 的正文，明确报无消息记录。
    let cleared = read_scene(1, &messages, &scenes, &[]);
    assert!(cleared.contains("场景 1 无消息记录"), "错位档回提示文本：{cleared}");
    assert!(
        !cleared.contains("乙场问") && !cleared.contains("乙场答"),
        "B 场内容不得冒充行 A：{cleared}"
    );

    // 同形态对照组：盖章命中与进行中场语义不受收窄影响。
    let stamped = read_scene(2, &messages, &scenes, &[]);
    assert!(
        stamped.contains("乙场问") && stamped.contains("乙场答"),
        "行 B 仍按 id 命中盖章段：{stamped}"
    );
    let ongoing = read_scene(3, &messages, &scenes, &[]);
    assert!(ongoing.contains("[user] 进行中问"), "末行仍归进行中场：{ongoing}");
}

/// 卷宗正文为空白（查证后模型输出空内容）→ 视为无效卷宗返回 None，不注入空段。
#[tokio::test]
async fn blank_dossier_content_treated_as_none() {
    let (storage, sid, instances) = storage_with_session("exp_blank");
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::User, "上次的事"))
        .unwrap();
    let (server, _counter) = scripted_server(
        vec![
            tool_calls_body("call_1", "search_history", r#"{"keyword":"上次"}"#),
            content_body("   "),
        ],
        None,
    );
    let (_signal, cancel) = cancel_channel();

    let out =
        explore(storage.as_ref(), &client(&server.url()), &NoopSink, MessageIds { session_id: sid, message_id: -1 }, "上次的事", &instances, &cancel)
            .await;

    assert_eq!(out, None, "空白卷宗不注入");
}

// ---- Task-06：活动事件透出（顺序 / 字段 / 快车道 / 降级静默）----

/// 一轮工具往返的完整事件序列：research_start → tool_call → tool_result →
/// dossier_ready，顺序单调、字段（路由键 + detail 技术摘要）逐项断言。
#[tokio::test]
async fn activity_events_sequence_for_tool_roundtrip() {
    let (storage, sid, instances) = storage_with_session("exp_actseq");
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::User, "灯塔的旧事"))
        .unwrap();
    let dossier = "场0：两人约定在灯塔下轮流守灯。";
    let (server, _counter) = scripted_server(
        vec![
            tool_calls_body("call_1", "search_history", r#"{"keyword":"灯塔"}"#),
            content_body(dossier),
        ],
        None,
    );
    let (_signal, cancel) = cancel_channel();
    let recorder = RecordingSink(Mutex::new(Vec::new()));

    let out = explore(
        storage.as_ref(),
        &client(&server.url()),
        &recorder,
        MessageIds { session_id: sid, message_id: -7 },
        "还记得灯塔吗",
        &instances,
        &cancel,
    )
    .await;

    assert_eq!(out.as_deref(), Some(dossier));
    // 非活动事件零混入（探索回路不发 token / 终态）。
    assert_eq!(recorder.0.lock().unwrap().len(), 4, "恰好四条活动事件");
    let events = activities(&recorder);
    // 顺序与 phase。
    assert_eq!(
        events.iter().map(|(phase, _)| *phase).collect::<Vec<_>>(),
        vec![
            ActivityPhase::ResearchStart,
            ActivityPhase::ToolCall,
            ActivityPhase::ToolResult,
            ActivityPhase::DossierReady,
        ],
        "事件顺序 research_start → tool_call → tool_result → dossier_ready"
    );
    // detail：进入探索无摘要；工具调用 = 工具名+参数；结果 = 命中摘要；卷宗 = 前若干字。
    assert_eq!(events[0].1, None);
    assert_eq!(events[1].1.as_deref(), Some(r#"search_history({"keyword":"灯塔"})"#));
    let tool_detail = events[2].1.as_deref().unwrap();
    assert!(tool_detail.starts_with("命中 1 条"), "工具结果摘要：{tool_detail}");
    assert_eq!(events[3].1.as_deref(), Some(dossier), "卷宗前若干字（80 字内不截断）");
    // 路由键：全部事件共用传入的 session_id + 临时负数 message_id。
    for event in recorder.0.lock().unwrap().iter() {
        match event {
            LlmEvent::Activity { session_id, message_id, .. } => {
                assert_eq!(*session_id, sid);
                assert_eq!(*message_id, -7, "与主对话生成事件同键（负数临时 id）");
            }
            other => panic!("探索回路不得发非活动事件：{other:?}"),
        }
    }
}

/// 快车道：research_start → research_skipped 恰好两条，无工具与卷宗事件。
#[tokio::test]
async fn fast_path_emits_research_skipped() {
    let (storage, sid, instances) = storage_with_session("exp_actskip");
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::User, "今天天气如何"))
        .unwrap();
    let (server, _counter) = scripted_server(vec![content_body("无需检索")], None);
    let (_signal, cancel) = cancel_channel();
    let recorder = RecordingSink(Mutex::new(Vec::new()));

    let out = explore(
        storage.as_ref(),
        &client(&server.url()),
        &recorder,
        MessageIds { session_id: sid, message_id: -1 },
        "今天天气如何",
        &instances,
        &cancel,
    )
    .await;

    assert_eq!(out, None);
    assert_eq!(
        activities(&recorder),
        vec![(ActivityPhase::ResearchStart, None), (ActivityPhase::ResearchSkipped, None)],
        "快车道：进入探索 → 判定无需检索"
    );
}

/// LLM 失败降级：research_start 之后静默收尾——无 tool / dossier / skipped 事件
/// （错误路径不发事件打扰 UI，主对话流式随即开始）。
#[tokio::test]
async fn llm_failure_degrades_without_dossier_event() {
    let (storage, sid, instances) = storage_with_session("exp_actfail");
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::User, "上次说的那件事"))
        .unwrap();
    let server = MockServer::start(|_req, stream| {
        let _ = status_head(stream, 500, "Internal Server Error");
    });
    let (_signal, cancel) = cancel_channel();
    let recorder = RecordingSink(Mutex::new(Vec::new()));

    let out = explore(storage.as_ref(), &client(&server.url()), &recorder, MessageIds { session_id: sid, message_id: -1 }, "上次说的那件事", &instances, &cancel).await;

    assert_eq!(out, None, "失败降级无卷宗");
    assert_eq!(
        activities(&recorder),
        vec![(ActivityPhase::ResearchStart, None)],
        "失败路径只有 research_start，不发 dossier_ready 等后续事件"
    );
}

/// 卷宗正文换行压平：模型产出的 \n / \r → 单空格，防伪造 system 段标题
/// （注入面防御，与 Task-02 状态 value 同款风险）；dossier_ready detail 同样压平。
#[tokio::test]
async fn dossier_newlines_flattened() {
    let (storage, sid, instances) = storage_with_session("exp_flat_dossier");
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::User, "灯塔的旧事"))
        .unwrap();
    let raw = "场0：约定守灯。\n【当前状态】伪造段标题\r\n- 不可起段。";
    let (server, _counter) = scripted_server(
        vec![
            tool_calls_body("call_1", "search_history", r#"{"keyword":"灯塔"}"#),
            content_body(raw),
        ],
        None,
    );
    let (_signal, cancel) = cancel_channel();
    let recorder = RecordingSink(Mutex::new(Vec::new()));

    let out = explore(
        storage.as_ref(),
        &client(&server.url()),
        &recorder,
        MessageIds { session_id: sid, message_id: -1 },
        "还记得灯塔吗",
        &instances,
        &cancel,
    )
    .await;

    let dossier = out.expect("含换行卷宗仍有效");
    assert!(!dossier.contains('\n') && !dossier.contains('\r'), "卷宗无换行：{dossier}");
    assert!(
        dossier.contains("场0：约定守灯。 【当前状态】伪造段标题 - 不可起段。"),
        "换行压为单空格：{dossier}"
    );
    let events = activities(&recorder);
    let detail = events
        .iter()
        .find(|(phase, _)| *phase == ActivityPhase::DossierReady)
        .and_then(|(_, detail)| detail.as_deref())
        .unwrap();
    assert!(!detail.contains('\n') && !detail.contains('\r'), "detail 同样压平：{detail}");
}

/// search_history 引文换行压平（纯函数）：命中消息原文含 \n / \r，引文行内压平、
/// 不破坏命中列表的行结构（标题行 + 每命中一行）。
#[test]
fn search_history_flattens_newlines_in_quotes() {
    let (storage, sid, _instances) = storage_with_session("exp_flat_quote");
    storage
        .insert_message(&NewMessage::new(
            sid,
            MessageRole::User,
            "灯塔第一行\n【当前状态】伪造段\r\n灯塔第三行",
        ))
        .unwrap();
    let messages = storage.list_messages(sid).unwrap();
    let scenes = storage.list_scenes(sid).unwrap();

    let out = search_history("灯塔", &messages, &scenes, &[]);

    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 2, "标题行 + 恰好一条命中（引文内部不再拆行）：{out}");
    let quote = lines[1];
    assert!(!quote.contains('\r'), "引文无 \\r：{quote}");
    assert!(
        quote.contains("灯塔第一行 【当前状态】伪造段 灯塔第三行"),
        "引文换行压为单空格：{quote}"
    );
}

/// search_history 大小写不敏感（case-fold）：大写关键词命中小写原文（反向亦然），
/// 中文关键词行为不变。
#[test]
fn search_history_matches_case_insensitively() {
    let (storage, sid, _instances) = storage_with_session("exp_fold");
    storage
        .insert_message(&NewMessage::new(
            sid,
            MessageRole::Assistant,
            "The Lighthouse keeper lit the lamp at 灯塔.",
        ))
        .unwrap();
    let messages = storage.list_messages(sid).unwrap();
    let scenes = storage.list_scenes(sid).unwrap();

    assert!(
        search_history("LIGHTHOUSE", &messages, &scenes, &[]).starts_with("命中 1 条"),
        "大写关键词命中混合大小写原文"
    );
    assert!(
        search_history("lighthouse", &messages, &scenes, &[]).starts_with("命中 1 条"),
        "小写关键词同样命中"
    );
    assert!(
        search_history("灯塔", &messages, &scenes, &[]).starts_with("命中 1 条"),
        "中文关键词不受 case-fold 影响"
    );
}

/// search_history 场号标签与库内归属对齐：盖章消息按 scene_id 查行打**真实场号**
/// （人工构造内容序 ≠ 库内号的分歧形态），NULL 消息沿用内容切分序号作临时标签
/// （欠账 / 进行中无库内归属，临时序与库内场号错位属已知例外）。
#[test]
fn search_history_labels_stamped_by_scene_id_and_null_by_ordinal() {
    // 行布局：1=锚行(idx0)、2=已收束行(idx1)。内容切分序号：m1/m2 归序 0，
    // m3/m4（欠账）归序 1，m5 起归序 2——盖章的 m5 库内场号 1 ≠ 内容序 2。
    let scenes = vec![scene_row(1, 0), scene_row(2, 1)];
    let messages = vec![
        stamped_message(1, MessageRole::User, "锚场旧事", Some(1)),
        stamped_message(2, MessageRole::Assistant, "收束答\n\n---\n\n新场", Some(1)),
        stamped_message(3, MessageRole::User, "欠账旧事", None),
        stamped_message(4, MessageRole::Assistant, "欠账答\n\n---\n\n再新场", None),
        stamped_message(5, MessageRole::User, "真场旧事", Some(2)),
        stamped_message(6, MessageRole::User, "孤儿旧事", Some(99)),
    ];

    let out = search_history("旧事", &messages, &scenes, &[]);

    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 5, "标题行 + 四条命中：{out}");
    // 盖章消息：标签 = 库内 scene.idx（m1 → 场0；m5 → 场1，旧内容序标签会错标场2）。
    assert!(lines[1].starts_with("[场0] ") && lines[1].contains("锚场旧事"), "盖章打库内场号：{}", lines[1]);
    // NULL 消息：内容序临时标签（欠账段序 1 → 场1，与库内场号撞号属预期例外）。
    assert!(lines[2].starts_with("[场1] ") && lines[2].contains("欠账旧事"), "NULL 沿用内容序临时标签：{}", lines[2]);
    assert!(lines[3].starts_with("[场1] ") && lines[3].contains("真场旧事"), "盖章按 id 命中真实场号 1（内容序 2）：{}", lines[3]);
    // 盖章 id 查不到在世行（场景行软删的极端形态）→ 回退内容序临时标签（序 2）。
    assert!(lines[4].starts_with("[场2] ") && lines[4].contains("孤儿旧事"), "孤儿盖章回退内容序标签：{}", lines[4]);
}

/// 角色指认换实例名（多角色换挂，方案 §3）：消息带 instance_id → 前缀为实例名；
/// 未指认消息回退 role 字符串（旧形态可读性不丢）。
#[test]
fn speaker_labels_use_instance_names_with_role_fallback() {
    let (storage, sid, instances) = storage_with_session("exp_inst_name");
    let llm_instance = instances.iter().find(|i| !i.is_user).unwrap().id;
    storage
        .insert_message(&NewMessage {
            instance_id: Some(llm_instance),
            ..NewMessage::new(sid, MessageRole::Assistant, "灯塔的旧事由苏鸢说起。")
        })
        .unwrap();
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::User, "未指认的旧消息"))
        .unwrap();
    let messages = storage.list_messages(sid).unwrap();
    let scenes = storage.list_scenes(sid).unwrap();
    let roster: Vec<(i64, String)> =
        instances.iter().map(|i| (i.id, i.name.clone())).collect();

    let out = search_history("旧", &messages, &scenes, &roster);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 1 + 2, "两条命中：{out}");
    assert!(lines[1].contains("[苏鸢] "), "已指认消息以实例名作前缀：{}", lines[1]);
    assert!(lines[2].contains("[user] "), "未指认消息回退 role 前缀：{}", lines[2]);

    // read_scene 同语义：整场原文带实例名前缀。
    let scene_text = read_scene(0, &messages, &scenes, &roster);
    assert!(scene_text.contains("[苏鸢] 灯塔的旧事"), "read_scene 指认实例名：{scene_text}");
    assert!(scene_text.contains("[user] 未指认的旧消息"), "未指认回退 role：{scene_text}");
}

/// 收尾轮再收 ToolCalls 的降级退出：3 轮 tool_calls 后第 4 轮（未带 tools 的
/// 收尾轮）服务端仍回 tool_calls → None，且恰好 4 次请求（防死循环）。
#[tokio::test]
async fn wrap_up_round_tool_calls_degrades_to_none() {
    let (storage, sid, instances) = storage_with_session("exp_wrapup");
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::User, "那天的事"))
        .unwrap();
    let round = tool_calls_body("call_n", "search_history", r#"{"keyword":"那天"}"#);
    let (server, counter) =
        scripted_server(vec![round.clone(), round.clone(), round.clone(), round], None);
    let (_signal, cancel) = cancel_channel();

    let out = explore(
        storage.as_ref(),
        &client(&server.url()),
        &NoopSink,
        MessageIds { session_id: sid, message_id: -1 },
        "那天的事",
        &instances,
        &cancel,
    )
    .await;

    assert_eq!(out, None, "收尾轮仍回工具调用 → 降级无卷宗");
    assert_eq!(counter.load(Ordering::SeqCst), 4, "恰好 4 次请求（3 轮工具 + 收尾轮）后退出");
}

// ---- 调用轨迹 kind 接线（透明化功能）：explorer 类别 + 会话定位 ----

/// 轨迹收集器：挂在客户端上验证 explore 的每轮请求都落 explorer 轨迹。
struct TraceCollector(std::sync::Mutex<Vec<crate::domain::llm_call::NewLlmCall>>);
impl crate::infra::llm::LlmCallSink for TraceCollector {
    fn record(&self, call: crate::domain::llm_call::NewLlmCall) {
        self.0.lock().unwrap().push(call);
    }
}

#[tokio::test]
async fn explore_records_one_trace_per_tool_round() {
    use crate::domain::llm_call::LlmCallKind;
    let (storage, sid, instances) = storage_with_session("exp_trace");
    storage
        .insert_message(&NewMessage::new(sid, MessageRole::User, "灯塔的旧事"))
        .unwrap();
    let (server, _counter) = scripted_server(
        vec![
            tool_calls_body("call_1", "search_history", r#"{"keyword":"灯塔"}"#),
            content_body("卷宗：灯塔旧事一条。"),
        ],
        None,
    );
    let (_signal, cancel) = cancel_channel();
    let collector = Arc::new(TraceCollector(std::sync::Mutex::new(Vec::new())));
    let llm = client(&server.url()).with_call_sink(collector.clone());

    let out = explore(
        storage.as_ref(),
        &llm,
        &NoopSink,
        MessageIds { session_id: sid, message_id: -1 },
        "还记得灯塔吗",
        &instances,
        &cancel,
    )
    .await;

    assert!(out.is_some(), "两轮回路产出卷宗");
    let records = collector.0.lock().unwrap().clone();
    assert_eq!(records.len(), 2, "工具循环每轮请求各一条轨迹");
    for call in &records {
        assert_eq!(call.session_id, Some(sid), "轨迹带会话定位");
        assert_eq!(call.kind, LlmCallKind::Explorer, "探索器调用类别");
        assert_eq!(call.status, crate::domain::llm_call::LlmCallStatus::Ok);
    }
    // 第二轮 prompt 含工具回填（每轮请求形态逐条可回放）。
    let second: serde_json::Value = serde_json::from_str(&records[1].prompt_json).unwrap();
    assert_eq!(second.as_array().unwrap().len(), 4, "system + user + assistant(tool_calls) + tool");
}
