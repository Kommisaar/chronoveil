//! 记忆探索器（切片 C / Task-05）：主对话生成前的「抽针 + 检索 + 卷宗」一步。
//!
//! 理想流程：生成主对话前，由一次带工具的 LLM 调用自主决定是否检索历史、查什么、
//! 查多深，产出「卷宗」（本回合真正需要的引文与事实），经 `AssembleInputs::dossier`
//! 注入 system 的【相关回忆】段（services/prompt.rs 五段装配）。
//!
//! **硬约束：探索器是锦上添花——任何失败（网络 / 协议 / 超预算 / 取消）都降级为
//! 无卷宗（返回 None），主对话照常生成**；降级留痕走 log facade（warn，
//! 后端见组合根的 tauri-plugin-log，风格同 generation.rs / director.rs）。
//!
//! 活动事件透出（Task-06，切片 D）：探索的幕后步骤经 `EventSink` 以
//! `LlmEvent::Activity` 即时透出（research_start → tool_call / tool_result →
//! dossier_ready；快车道 research_skipped），供前端「正在回忆…」活动条消费。
//! 事件走调用方传入的**原始 sink**（生成编排的终态闸门只扣 token / reasoning /
//! done / error，活动事件不受闸门）。失败 / 取消等错误路径**不发事件**静默降级
//! ——避免错误路径打扰 UI（research_start 之后无下文即隐含降级，主对话流式随即
//! 开始，活动条自然让位）。
//!
//! 工具面（Rust 侧执行，v1 两个，全部只读、不加新端口方法）：
//! - `search_history(keyword)`：services 层对 list_messages 做**内存包含匹配**
//!   （大小写不敏感，case-fold）——个人应用消息量级（千条级）下线性扫描可接受，
//!   不值得为它上 FTS 索引或新端口；
//! - `read_scene(scene)`：按场景号取该场全部消息全文，切分复用
//!   [`super::prompt::split_into_scene_spans`]（与近景/结算同一归属语义：库内
//!   scene_id 优先、NULL 段内容场景线兜底），超长场按近景同款字符预算截断头部
//!   （复用 domain::context::truncate_head）。
//!
//! 角色指认（多角色换挂，方案 §3）：结果中的说话人前缀优先用**实例名**（消息
//! instance_id → 会话实例名，迁移 0009 换挂后的真语义）；实例特性之前的旧数据 /
//! 未指认消息（instance_id = NULL）回退 role 字符串（`user` / `assistant`），
//! 旧形态可读性不丢。
//!
//! 注入面防御：卷宗正文与 search_history 引文在进入模型上下文 / system 注入前
//! **换行压平**（\n 与 \r → 单空格），防携带换行的文本伪造段标题（与 Task-02
//! 状态 value 压平同款风险面）。
//!
//! 取消：每轮工具往返间检查取消信号（complete_with_tools 本身不接受取消句柄，
//! 这是 v1 的最小侵入接入点——单轮非流式 HTTP 内不可取消，由读超时兜底）；
//! 已取消 → 返回 None，上游 chat_stream 会立刻看到取消并按既有语义走半条落库。

use crate::domain::context;
use crate::domain::models::{CharacterInstance, LlmCallKind, Message, Scene};
use crate::domain::ports::StoragePort;
use crate::infra::llm::{
    ActivityPhase, CallTrace, CancelHandle, ChatMessage, ChatRole, EventSink, LlmClient, LlmEvent,
    MessageIds, ToolCall, ToolLoopTurn, ToolSpec,
};

/// 工具往返上限：累计达此轮数后强制收尾（下一轮不再带 tools，让模型只输出卷宗正文）。
const MAX_TOOL_ROUNDS: u32 = 3;

/// search_history 单条命中引文的字符上限（UTF-8 边界安全截断）。
const HIT_QUOTE_MAX_CHARS: usize = 200;

/// search_history 总命中条数上限。
const HIT_LIMIT: usize = 8;

/// 活动事件 detail 摘要的字符上限（技术措辞，过长无展示价值）。
const ACTIVITY_DETAIL_MAX_CHARS: usize = 80;

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
/// （list_messages / list_scenes，读取失败降级 None）、会话实例阵容（工具结果的
/// 说话人指认换实例名，多角色换挂）、与主对话同一个 LlmClient（不加新配置项）、
/// 活动事件 sink（Task-06，即时透出、不走生成编排终态闸门）、事件路由键
/// （session_id + 生成期临时负数 message_id，与主对话事件同键）、取消信号。
/// LLM 回路：complete_with_tools 首轮 ToolCalls → 本地执行工具 →
/// ChatRole::Tool 回填 → 再调用；首轮 Content 且零工具调用 = 快车道 None；
/// Content 即终止返回卷宗（换行压平后）。
pub async fn explore(
    storage: &dyn StoragePort,
    llm: &LlmClient,
    sink: &dyn EventSink,
    ids: MessageIds,
    latest_user_message: &str,
    instances: &[CharacterInstance],
    cancel: &CancelHandle,
) -> Option<String> {
    let session_id = ids.session_id;
    let message_id = ids.message_id;
    // 读取失败 → 降级无卷宗（warn 留痕，主对话不受影响；不发任何活动事件——
    // 探索从未开始，错误路径不打扰 UI）。
    let messages = match storage.list_messages(session_id) {
        Ok(rows) => rows,
        Err(error) => {
            log::warn!("会话 #{session_id} 历史读取失败，本回合无卷宗：{error}");
            return None;
        }
    };
    let scenes = match storage.list_scenes(session_id) {
        Ok(rows) => rows,
        Err(error) => {
            log::warn!("会话 #{session_id} 场景行读取失败，本回合无卷宗：{error}");
            return None;
        }
    };
    // 进入探索（Task-06）：存储就绪、即将发起研究员调用。
    emit_activity(sink, session_id, message_id, ActivityPhase::ResearchStart, None);
    // 实例名映射（多角色换挂）：工具结果的说话人前缀按实例名指认。
    let roster: Vec<(i64, String)> =
        instances.iter().map(|i| (i.id, i.name.clone())).collect();

    let mut conversation = vec![
        ChatMessage::new(ChatRole::System, RESEARCHER_SYSTEM),
        ChatMessage::new(ChatRole::User, latest_user_message),
    ];
    let tools = tool_specs();
    // 调用轨迹接线（透明化功能）：工具循环的每一轮请求在网关内各记一条 explorer 轨迹。
    let trace = CallTrace { session_id: Some(session_id), kind: LlmCallKind::Explorer };
    let mut tool_rounds: u32 = 0;
    loop {
        // 取消检查（每轮工具往返间）：已取消 → None，上游按既有取消语义走。
        if cancel.is_cancelled() {
            return None;
        }
        // 累计工具轮达上限 → 强制收尾：不再带 tools（空切片在网关构造层等同未提供），
        // 模型只能输出正文总结卷宗。
        let turn = if tool_rounds >= MAX_TOOL_ROUNDS {
            llm.complete_with_tools(&conversation, &[], Some(&trace)).await
        } else {
            llm.complete_with_tools(&conversation, &tools, Some(&trace)).await
        };
        match turn {
            // 失败降级（硬约束）：Err（含重试耗尽）→ 留痕 + 无卷宗，不阻塞主对话。
            // 错误路径不发活动事件（research_start 后静默收尾，主对话流式随即开始）。
            Err(error) => {
                log::warn!("会话 #{session_id} 探索调用失败，本回合无卷宗：{error}");
                return None;
            }
            Ok(ToolLoopTurn::Content(text)) => {
                if tool_rounds == 0 {
                    // 快车道：零工具调用的首轮 Content = 研究员判定无需检索。
                    emit_activity(
                        sink,
                        session_id,
                        message_id,
                        ActivityPhase::ResearchSkipped,
                        None,
                    );
                    return None;
                }
                // 查证后的卷宗正文；空白视为无效卷宗（不注入空段）。换行压平（\n /
                // \r → 单空格）防模型产出伪造 system 段标题（注入面防御）。
                let flattened = flatten_newlines(text.trim());
                if flattened.is_empty() {
                    return None;
                }
                emit_activity(
                    sink,
                    session_id,
                    message_id,
                    ActivityPhase::DossierReady,
                    Some(truncate_chars(&flattened, ACTIVITY_DETAIL_MAX_CHARS)),
                );
                return Some(flattened);
            }
            Ok(ToolLoopTurn::ToolCalls(calls)) => {
                if tool_rounds >= MAX_TOOL_ROUNDS {
                    // 收尾轮（未带 tools）仍收到工具调用 = 协议异常的服务端行为：
                    // 降级退出防死循环，不回填不重试。
                    log::warn!("会话 #{session_id} 收尾轮仍收到工具调用，本回合无卷宗");
                    return None;
                }
                tool_rounds += 1;
                // assistant 工具调用消息原样回传（续接多轮工具回路），再逐个执行工具
                // 并以 tool 角色消息回填——工具面全部本地只读执行，错误以文本回告。
                conversation
                    .push(ChatMessage::new(ChatRole::Assistant, "").with_tool_calls(calls.clone()));
                for call in &calls {
                    // 活动事件（Task-06）：单次工具调用 → 执行 → 结果回填，逐步即时透出。
                    emit_activity(
                        sink,
                        session_id,
                        message_id,
                        ActivityPhase::ToolCall,
                        Some(truncate_chars(
                            &format!("{}({})", call.name, call.arguments.trim()),
                            ACTIVITY_DETAIL_MAX_CHARS,
                        )),
                    );
                    let result = execute_tool(call, &messages, &scenes, &roster);
                    emit_activity(
                        sink,
                        session_id,
                        message_id,
                        ActivityPhase::ToolResult,
                        Some(truncate_chars(&result, ACTIVITY_DETAIL_MAX_CHARS)),
                    );
                    conversation
                        .push(ChatMessage::new(ChatRole::Tool, result).with_tool_call_id(call.id.clone()));
                }
            }
        }
    }
}

/// 发射一条探索活动事件（Task-06）：经调用方传入的 sink 即时透出。发射本身不
/// 失败不 panic（sink 实现侧已保证：活动事件丢失不应击穿探索或主对话）。
fn emit_activity(
    sink: &dyn EventSink,
    session_id: i64,
    message_id: i64,
    phase: ActivityPhase,
    detail: Option<String>,
) {
    sink.emit(LlmEvent::Activity { session_id, message_id, phase, detail });
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
fn execute_tool(call: &ToolCall, messages: &[Message], scenes: &[Scene], roster: &[(i64, String)]) -> String {
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
            search_history(keyword, messages, scenes, roster)
        }
        "read_scene" => {
            let Some(scene) = args.get("scene").and_then(serde_json::Value::as_i64) else {
                return "参数格式错误：缺少整数字段 scene".into();
            };
            read_scene(scene, messages, scenes, roster)
        }
        other => format!("未知工具：{other}（可用工具：search_history / read_scene）"),
    }
}

/// search_history：对全部历史做内存包含匹配（取舍见模块注释）。**大小写不敏感**
/// （case-fold：两侧 to_lowercase 后比较——英文关键词不受形态影响，中文
/// to_lowercase 为恒等映射不受影响）。命中 = 场定位 + 说话人前缀（实例名优先，
/// 未指认回退 role 字符串）+ 引文截断（换行压平后注入，防伪造段标题）；场定位与
/// read_scene 同一命名空间（库内归属优先，NULL 回退内容序临时标签，见实现内注释）；
/// 无命中回「未命中」让模型换关键词或收手。
fn search_history(
    keyword: &str,
    messages: &[Message],
    scenes: &[Scene],
    roster: &[(i64, String)],
) -> String {
    let keyword_folded = keyword.to_lowercase();
    let mut hits: Vec<String> = Vec::new();
    // 场号标签两档取法（与 read_scene 按 id 命中同一命名空间，都是 scene.idx）：
    // - 消息带 scene_id（库内盖章）→ 按 scenes 行 id 查 idx，打**真实场号**——
    //   欠账 / 重生成形态下内容序可能与库内归属分歧，以库内归属为准；
    // - NULL 消息（欠账段 / 进行中段）无库内归属 → 沿用内容切分场序（0 起，锚场
    //   = 0，触发行归收束场、其后消息归下一场）作**临时**标签：内容序是欠账场的
    //   临时序，与库内场号可能错位（触发行被软删 / 重生成后序号漂移时尤其如此）。
    // 盖章 id 查不到在世行（场景行被软删的极端形态）→ 同样回退内容序临时标签。
    let mut ordinal: usize = 0;
    for message in messages {
        let label = match message
            .scene_id
            .and_then(|id| scenes.iter().find(|scene| scene.id == id))
        {
            Some(scene) => scene.idx,
            None => scene_label(ordinal, scenes),
        };
        if super::director::contains_scene_line(&message.content) {
            ordinal += 1;
        }
        if !message.content.to_lowercase().contains(&keyword_folded) {
            continue;
        }
        if hits.len() >= HIT_LIMIT {
            break;
        }
        // 引文换行压平后截断（注入面防御，见模块注释）。
        let quote =
            truncate_chars(&flatten_newlines(message.content.trim()), HIT_QUOTE_MAX_CHARS);
        hits.push(format!("[场{}] [{}] {}", label, speaker_label(message, roster), quote));
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
/// 优先按**库内归属**命中：场景行 id → 盖章段（scene_id 精确对应，欠账 / 重生成
/// 不再错位）。行不是任何盖章段、也非末行（进行中 header → ongoing）时回退现行
/// 内容切分位置对齐（closed[i] 归第 i 行）——覆盖无盖章的旧数据 / 纯内容切分形态，
/// 回退路径保留既有「场景 N 无消息记录」提示语义（空段 / 越界定位）。
fn read_scene(
    scene_idx: i64,
    messages: &[Message],
    scenes: &[Scene],
    roster: &[(i64, String)],
) -> String {
    // 场号 → 行（idx 单调但墓碑行留空洞，按值查找而非下标直取）。
    let Some(position) = scenes.iter().position(|scene| scene.idx == scene_idx) else {
        let available: Vec<String> = scenes.iter().map(|scene| scene.idx.to_string()).collect();
        return format!("未找到场景 {scene_idx}；可用场景号：{}", available.join("、"));
    };
    let row = &scenes[position];
    let spans = super::prompt::split_into_scene_spans(messages);
    let span: &[Message] = if let Some(stamped) =
        spans.closed.iter().find(|span| span.scene_id == Some(row.id))
    {
        stamped.messages
    } else if position + 1 == scenes.len() {
        // 末行 = 进行中 header：NULL 尾段（含欠账切分后的余段）逻辑上属于它。
        spans.ongoing
    } else if position < spans.closed.len() {
        // 回退：内容切分位置对齐（无盖章形态下与旧版逐字同界）。
        spans.closed[position].messages
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
        out.push_str(&format!("\n[{}] {}", speaker_label(message, roster), message.content));
    }
    out
}

/// 说话人指认（多角色换挂）：消息带 instance_id → 会话实例名（模型可读的人名）；
/// 未指认（旧数据 / NULL）回退 role 字符串，保持旧形态可读。
fn speaker_label(message: &Message, roster: &[(i64, String)]) -> String {
    message
        .instance_id
        .and_then(|id| roster.iter().find(|(rid, _)| *rid == id))
        .map(|(_, name)| name.clone())
        .unwrap_or_else(|| message.role.as_str().to_string())
}

/// 内容切分场序 → **临时**场号标签（仅 NULL 消息与孤儿盖章的回退档使用）：正常态
/// （无墓碑、无欠账）场序 == 场景行 idx；有偏差时以行内 idx 为准（编年史给模型看
/// 的场号就是 scene.idx，保持同一命名空间），越界（欠账多出的场序）回退序号本身。
/// 内容序是欠账场的临时序，与库内场号可能错位——盖章消息不走此回退（见
/// search_history 的两档取法）。
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

/// 换行压平（\n 与 \r 的连续序列 → 单空格）：卷宗正文与检索引文在进入模型上下文 /
/// system 注入面前压平，防携带换行的文本在段内伪造新段标题（如伪「【当前状态】」
/// 起段，与 Task-02 状态 value 压平同款风险面）。\r\n 视为一次换行（不产生双空格）。
fn flatten_newlines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c == '\n' || c == '\r' {
            if !out.ends_with(' ') {
                out.push(' ');
            }
        } else {
            out.push(c);
        }
    }
    out
}


#[cfg(test)]
mod tests;
