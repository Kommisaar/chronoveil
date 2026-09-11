//! 记忆探索器（切片 C / Task-05）：主对话生成前的「抽针 + 检索 + 卷宗」一步。
//!
//! 理想流程：生成主对话前，由一次带工具的 LLM 调用自主决定是否检索历史、查什么、
//! 查多深，产出「卷宗」（本回合真正需要的引文与事实），经 `AssembleInputs::dossier`
//! 注入 system 的【相关回忆】段（services/prompt.rs 五段装配）。
//!
//! **硬约束：探索器是锦上添花——任何失败（网络 / 协议 / 超预算 / 取消）都降级为
//! 无卷宗（返回 None），主对话照常生成，不阻塞不报事件**；全程静默 + eprintln
//! 留痕（风格同 generation.rs / director.rs；探索活动的事件透出是切片 D）。
//!
//! 工具面（Rust 侧执行，v1 两个，全部只读、不加新端口方法）：
//! - `search_history(keyword)`：services 层对 list_messages 做**内存包含匹配**——
//!   个人应用消息量级（千条级）下线性扫描可接受，不值得为它上 FTS 索引或新端口；
//! - `read_scene(scene)`：按场景号取该场全部消息全文，内容切分复用
//!   [`super::prompt::split_into_scene_spans`]（与近景/结算同一场景线切界），
//!   超长场按近景同款字符预算截断头部（复用 domain::context::truncate_head）。
//!
//! 取消：每轮工具往返间检查取消信号（complete_with_tools 本身不接受取消句柄，
//! 这是 v1 的最小侵入接入点——单轮非流式 HTTP 内不可取消，由读超时兜底）；
//! 已取消 → 返回 None，上游 chat_stream 会立刻看到取消并按既有语义走半条落库。

use crate::domain::context;
use crate::domain::models::{Message, Scene};
use crate::domain::ports::StoragePort;
use crate::infra::llm::{
    CancelHandle, ChatMessage, ChatRole, LlmClient, ToolCall, ToolLoopTurn, ToolSpec,
};

/// 工具往返上限：累计达此轮数后强制收尾（下一轮不再带 tools，让模型只输出卷宗正文）。
const MAX_TOOL_ROUNDS: u32 = 3;

/// search_history 单条命中引文的字符上限（UTF-8 边界安全截断）。
const HIT_QUOTE_MAX_CHARS: usize = 200;

/// search_history 总命中条数上限。
const HIT_LIMIT: usize = 8;

/// 研究员 system prompt：职责 = 判断指涉 + 查证 + 产出卷宗（快车道：无可查不调用工具）。
const RESEARCHER_SYSTEM: &str = "\
你是「记忆研究员」，在一次角色扮演回复生成之前工作：判断用户最新消息是否指涉更早的对话历史，若是则查证并整理出「卷宗」。\n\
\n\
判断标准（只看用户消息本身，不要臆测）：\n\
- 指涉往事的信号：提到旧事件、旧地名、旧人名，或时间指涉（「之前」「那天」「上次」「还记得吗」等）；\n\
- 纯当下话题（寒暄、新指令、对刚说完内容的延续）不需要检索。\n\
\n\
行动规则：\n\
- 无需检索时：不要调用任何工具，直接回复一句「无需检索」即可；\n\
- 需要查证时：先用 search_history 按关键词找线索，需要更多上下文时用 read_scene 读整场原文；最多 3 轮工具往返，够用即止；\n\
- 查证完成后输出卷宗：简短中文分条，只列与本回合回答直接相关的往事事实，按需附简短引文并注明场号；不要全文转贴检索结果，不要编造检索不到的细节，不要评论。\n\
\n\
你的输出将作为「相关回忆」注入主对话的 system 提示。";

/// 一次记忆探索：返回卷宗文本；None = 无卷宗（快车道 / 全部降级路径）。
///
/// 输入半：最新用户消息（调用方过滤历史后取最后一条 user）、StoragePort 只读面
/// （list_messages / list_scenes，读取失败降级 None）、与主对话同一个 LlmClient
/// （不加新配置项）、取消信号。LLM 回路：complete_with_tools 首轮 ToolCalls →
/// 本地执行工具 → ChatRole::Tool 回填 → 再调用；首轮 Content 且零工具调用 =
/// 快车道 None；Content 即终止返回卷宗。
pub async fn explore(
    storage: &dyn StoragePort,
    llm: &LlmClient,
    session_id: i64,
    latest_user_message: &str,
    cancel: &CancelHandle,
) -> Option<String> {
    // 读取失败 → 降级无卷宗（eprintln 留痕，主对话不受影响）。
    let messages = match storage.list_messages(session_id) {
        Ok(rows) => rows,
        Err(error) => {
            eprintln!("[explorer] 会话 #{session_id} 历史读取失败，本回合无卷宗：{error}");
            return None;
        }
    };
    let scenes = match storage.list_scenes(session_id) {
        Ok(rows) => rows,
        Err(error) => {
            eprintln!("[explorer] 会话 #{session_id} 场景行读取失败，本回合无卷宗：{error}");
            return None;
        }
    };

    let mut conversation = vec![
        ChatMessage::new(ChatRole::System, RESEARCHER_SYSTEM),
        ChatMessage::new(ChatRole::User, latest_user_message),
    ];
    let tools = tool_specs();
    let mut tool_rounds: u32 = 0;
    loop {
        // 取消检查（每轮工具往返间）：已取消 → None，上游按既有取消语义走。
        if cancel.is_cancelled() {
            return None;
        }
        // 累计工具轮达上限 → 强制收尾：不再带 tools（空切片在网关构造层等同未提供），
        // 模型只能输出正文总结卷宗。
        let turn = if tool_rounds >= MAX_TOOL_ROUNDS {
            llm.complete_with_tools(&conversation, &[]).await
        } else {
            llm.complete_with_tools(&conversation, &tools).await
        };
        match turn {
            // 失败降级（硬约束）：Err（含重试耗尽）→ 留痕 + 无卷宗，不阻塞主对话。
            Err(error) => {
                eprintln!("[explorer] 会话 #{session_id} 探索调用失败，本回合无卷宗：{error}");
                return None;
            }
            Ok(ToolLoopTurn::Content(text)) => {
                if tool_rounds == 0 {
                    // 快车道：零工具调用的首轮 Content = 研究员判定无需检索。
                    return None;
                }
                // 查证后的卷宗正文；空白视为无效卷宗（不注入空段）。
                let trimmed = text.trim();
                return (!trimmed.is_empty()).then(|| trimmed.to_string());
            }
            Ok(ToolLoopTurn::ToolCalls(calls)) => {
                if tool_rounds >= MAX_TOOL_ROUNDS {
                    // 收尾轮（未带 tools）仍收到工具调用 = 协议异常的服务端行为：
                    // 降级退出防死循环，不回填不重试。
                    eprintln!(
                        "[explorer] 会话 #{session_id} 收尾轮仍收到工具调用，本回合无卷宗"
                    );
                    return None;
                }
                tool_rounds += 1;
                // assistant 工具调用消息原样回传（续接多轮工具回路），再逐个执行工具
                // 并以 tool 角色消息回填——工具面全部本地只读执行，错误以文本回告。
                conversation
                    .push(ChatMessage::new(ChatRole::Assistant, "").with_tool_calls(calls.clone()));
                for call in &calls {
                    let result = execute_tool(call, &messages, &scenes);
                    conversation
                        .push(ChatMessage::new(ChatRole::Tool, result).with_tool_call_id(call.id.clone()));
                }
            }
        }
    }
}

/// v1 工具定义（两个，全部只读）。`read_scene` 的场景号 = 编年史行的「场N」编号
/// （scene.idx），与模型在 system 里看到的编号同一命名空间。
fn tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "search_history".into(),
            description: "按关键词在会话全部历史消息中做包含匹配，返回命中消息的场景定位"
                .to_string()
                + "与引文片段（每条截断至 200 字，最多 8 条）。先用它找线索，再用 read_scene 读原文。",
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "keyword": { "type": "string", "description": "检索关键词（人名 / 地名 / 事件词等）" }
                },
                "required": ["keyword"],
            }),
        },
        ToolSpec {
            name: "read_scene".into(),
            description: "按场景号读取该场景的全部消息原文（带角色前缀）；超长场景会从最旧处截断。"
                .to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "scene": { "type": "integer", "description": "场景号，编年史中「场N」的 N" }
                },
                "required": ["scene"],
            }),
        },
    ]
}

/// 执行一次工具调用并返回回填给模型的文本。所有异常路径（非法 JSON / 缺字段 /
/// 未知工具名）都返回人类可读的错误文本让模型自行调整，不 abort 不 panic
/// （探索器无 panic 面：无 unwrap、无越界索引，边界全部走正常错误路径）。
fn execute_tool(call: &ToolCall, messages: &[Message], scenes: &[Scene]) -> String {
    let args: serde_json::Value = match serde_json::from_str(call.arguments.trim()) {
        Ok(value) => value,
        Err(error) => return format!("参数格式错误：arguments 不是合法 JSON（{error}）"),
    };
    match call.name.as_str() {
        "search_history" => {
            let Some(keyword) = args.get("keyword").and_then(serde_json::Value::as_str) else {
                return "参数格式错误：缺少字符串字段 keyword".into();
            };
            let keyword = keyword.trim();
            if keyword.is_empty() {
                return "参数格式错误：keyword 不能为空".into();
            }
            search_history(keyword, messages, scenes)
        }
        "read_scene" => {
            let Some(scene) = args.get("scene").and_then(serde_json::Value::as_i64) else {
                return "参数格式错误：缺少整数字段 scene".into();
            };
            read_scene(scene, messages, scenes)
        }
        other => format!("未知工具：{other}（可用工具：search_history / read_scene）"),
    }
}

/// search_history：对全部历史做内存包含匹配（取舍见模块注释）。命中 = 场定位 +
/// 角色前缀 + 引文截断；无命中回「未命中」让模型换关键词或收手。
fn search_history(keyword: &str, messages: &[Message], scenes: &[Scene]) -> String {
    let mut hits: Vec<String> = Vec::new();
    // 内容切分的场序（0 起，锚场 = 0）：与 split_into_scene_spans 同界——触发行
    // （含场景线的消息）归收束场，其后消息归下一场。
    let mut scene_no: usize = 0;
    for message in messages {
        let belongs = scene_no;
        if super::director::contains_scene_line(&message.content) {
            scene_no += 1;
        }
        if !message.content.contains(keyword) {
            continue;
        }
        if hits.len() >= HIT_LIMIT {
            break;
        }
        let quote = truncate_chars(message.content.trim(), HIT_QUOTE_MAX_CHARS);
        hits.push(format!(
            "[场{}] [{}] {}",
            scene_label(belongs, scenes),
            message.role.as_str(),
            quote
        ));
    }
    if hits.is_empty() {
        return format!("未命中包含「{keyword}」的消息。");
    }
    let mut out = format!("命中 {} 条（关键词「{keyword}」，每条已截断）：", hits.len());
    for hit in hits {
        out.push_str(&format!("\n{hit}"));
    }
    out
}

/// read_scene：按场景号（scene.idx，编年史「场N」同命名空间）取整场消息全文。
///
/// 行位置 → 内容分段：closed[i] 归第 i 行（0 起对齐锚行），末行（进行中 header）
/// 归 ongoing。已知偏差（接受并记录，同 prompt.rs 模块注释）：结算欠账时场景线
/// 切出的 closed 段可能多于场景行数，此时部分行的定位近似——对「给模型一个合理
/// 的原文窗口」这一工具目标无实质影响。
fn read_scene(scene_idx: i64, messages: &[Message], scenes: &[Scene]) -> String {
    // 场号 → 行位置（idx 单调但墓碑行留空洞，按值查找而非下标直取）。
    let Some(position) = scenes.iter().position(|scene| scene.idx == scene_idx) else {
        let available: Vec<String> = scenes.iter().map(|scene| scene.idx.to_string()).collect();
        return format!("未找到场景 {scene_idx}；可用场景号：{}", available.join("、"));
    };
    let spans = super::prompt::split_into_scene_spans(messages);
    let position = position as usize;
    let span: &[Message] = if position < spans.closed.len() {
        spans.closed[position]
    } else if position + 1 == scenes.len() {
        spans.ongoing
    } else {
        return format!("场景 {scene_idx} 无消息记录（结算归属错位，已知偏差）");
    };
    if span.is_empty() {
        return format!("场景 {scene_idx} 暂无消息。");
    }
    // 超长场头截断：近景同款预算、丢最旧保最新（复用 domain::context 的切窗数学）。
    let kept = context::truncate_head(span, context::NEAR_VIEW_CHAR_BUDGET);
    let mut out = format!("【场{scene_idx}】共 {} 条消息", kept.len());
    if kept.len() < span.len() {
        out.push_str("（超长，已从最旧处截断）");
    }
    for message in kept {
        out.push_str(&format!("\n[{}] {}", message.role.as_str(), message.content));
    }
    out
}

/// 内容切分场序 → 场号标签：正常态（无墓碑、无欠账）场序 == 场景行 idx；有偏差时
/// 以行内 idx 为准（编年史给模型看的场号就是 scene.idx，保持同一命名空间），
/// 越界（欠账多出的场序）回退序号本身。
fn scene_label(ordinal: usize, scenes: &[Scene]) -> i64 {
    scenes.get(ordinal).map_or(ordinal as i64, |scene| scene.idx)
}

/// 按字符数截断（UTF-8 边界安全），超长补省略号。
fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push('…');
    out
}

// ---------------------------------------------------------------------------
// 测试：mock LLM 脚本驱动多轮工具回路（同一模式沿用 infra/llm/tests.rs），
// 存储用临时库（真实 list_messages / list_scenes，含 FR-014 锚行 seed）。
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::{MessageRole, NewCharacter, NewMessage, NewSession};
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

    /// 临时库 + 角色 + 会话（create_session 已 seed 开场锚行，FR-014）。
    fn storage_with_session(tag: &str) -> (Arc<Storage>, i64) {
        let (raw, _dir) = temp_storage(tag);
        let storage = Arc::new(raw);
        let character = storage
            .create_character(&NewCharacter { name: "苏鸢".into(), ..Default::default() })
            .unwrap();
        let session_id = storage
            .create_session(&NewSession {
                character_id: character.id,
                title: String::new(),
                opening: None,
            })
            .unwrap()
            .id;
        (storage, session_id)
    }

    /// 快车道：研究员首轮直接 Content（零工具调用）→ None，且只发一次请求。
    #[tokio::test]
    async fn fast_path_content_without_tools_returns_none() {
        let (storage, sid) = storage_with_session("exp_fast");
        storage
            .insert_message(&NewMessage::new(sid, MessageRole::User, "今天天气如何"))
            .unwrap();
        let (server, counter) = scripted_server(vec![content_body("无需检索")], None);
        let (_signal, cancel) = cancel_channel();

        let out =
            explore(storage.as_ref(), &client(&server.url()), sid, "今天天气如何", &cancel).await;

        assert_eq!(out, None, "快车道无卷宗");
        assert_eq!(counter.load(Ordering::SeqCst), 1, "恰好一次 LLM 调用");
    }

    /// 单轮工具往返：tool_calls → 本地执行（真实命中库中消息）→ tool 回填 → Content
    /// 卷宗 Some；第二轮请求的 wire 形态（assistant tool_calls 原样回传 + tool 结果）。
    #[tokio::test]
    async fn single_tool_roundtrip_returns_dossier() {
        let (storage, sid) = storage_with_session("exp_round");
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
            sid,
            "埋下的信物还在吗？",
            &cancel,
        )
        .await;

        assert_eq!(out.as_deref(), Some(dossier));
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
        let (storage, sid) = storage_with_session("exp_cap");
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

        let out = explore(storage.as_ref(), &client(&server.url()), sid, "那天的事", &cancel).await;

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
        let (storage, sid) = storage_with_session("exp_unknown");
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

        let out = explore(storage.as_ref(), &client(&server.url()), sid, "还记得吗", &cancel).await;

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
        let (storage, sid) = storage_with_session("exp_badargs");
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

        let out = explore(storage.as_ref(), &client(&server.url()), sid, "还记得吗", &cancel).await;

        assert_eq!(out.as_deref(), Some("卷宗：参数修正后的结论。"));
        let msgs = captured.lock().unwrap()[1]["messages"].as_array().unwrap().clone();
        let tool_content = msgs[3]["content"].as_str().unwrap();
        assert!(tool_content.contains("参数格式错误"), "非法 JSON 以文本回告：{tool_content}");
    }

    /// LLM 失败降级（硬约束）：持续 5xx + retry(1) 重试耗尽 → None，共 2 次连接。
    #[tokio::test]
    async fn llm_failure_degrades_to_none() {
        let (storage, sid) = storage_with_session("exp_5xx");
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

        let out = explore(storage.as_ref(), &llm, sid, "上次说的那件事", &cancel).await;

        assert_eq!(out, None, "探索失败降级无卷宗，不向上抛错");
        assert_eq!(server.connection_count(), 2, "重试一次后耗尽");
    }

    /// 取消：每轮往返间的检查点命中 → None 且不再发起调用。
    #[tokio::test]
    async fn cancelled_explore_returns_none_without_calling() {
        let (storage, sid) = storage_with_session("exp_cancel");
        storage
            .insert_message(&NewMessage::new(sid, MessageRole::User, "还记得吗"))
            .unwrap();
        let (server, counter) = scripted_server(vec![content_body("不该被请求到")], None);
        let (signal, cancel) = cancel_channel();
        signal.cancel();

        let out = explore(storage.as_ref(), &client(&server.url()), sid, "还记得吗", &cancel).await;

        assert_eq!(out, None);
        assert_eq!(counter.load(Ordering::SeqCst), 0, "已取消不再发起 LLM 调用");
    }

    /// 检索面封顶：总命中 ≤ 8 条、单条引文截断（纯函数路径，LLM 回路不参与）。
    #[test]
    fn search_history_caps_hits_and_truncates_quotes() {
        let (storage, sid) = storage_with_session("exp_caps");
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

        let out = search_history("灯塔", &messages, &scenes);

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
        let (storage, sid) = storage_with_session("exp_read");
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
        let first = read_scene(0, &messages, &scenes);
        assert!(first.starts_with("【场0】共 2 条消息"), "锚行整场：{first}");
        assert!(first.contains("[user] 场一问"));
        assert!(first.contains("[assistant] 场一答\n\n---\n\n场二开场"), "触发行原文在内");

        // 场1（末行）= 进行中场：场景线之后的全量。
        let second = read_scene(1, &messages, &scenes);
        assert!(second.starts_with("【场1】共 1 条消息"), "末行归进行中场：{second}");
        assert!(second.contains("[user] 场二问"));

        let missing = read_scene(7, &messages, &scenes);
        assert!(missing.contains("未找到场景 7"), "越界场号回可用清单：{missing}");
        assert!(missing.contains('0') && missing.contains('1'), "清单含可用场号：{missing}");
    }

    /// 卷宗正文为空白（查证后模型输出空内容）→ 视为无效卷宗返回 None，不注入空段。
    #[tokio::test]
    async fn blank_dossier_content_treated_as_none() {
        let (storage, sid) = storage_with_session("exp_blank");
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

        let out = explore(storage.as_ref(), &client(&server.url()), sid, "上次的事", &cancel).await;

        assert_eq!(out, None, "空白卷宗不注入");
    }
}
