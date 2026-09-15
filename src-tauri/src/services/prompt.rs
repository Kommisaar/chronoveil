//! Prompt 装配（TASK-006 / FR-001 / FR-003 / FR-012 / ADR-004）：纯函数，可单测，不做 IO。
//!
//! ADR-004 场景对齐装配（§7.8 近景/远景，替换 ADR-002 条数滑窗）：
//! - system = 常驻核心七段（各段空态自然省略；全空时不产生 system 回合）：
//!   1. 全局系统提示词（config.json `system_prompt`，2026-09-15）：用户自定义
//!      指令原文，置于所有领域段之前——全局框架指令先于人设 / 世界段（main
//!      prompt 先于角色定义的惯例）；空白整段省略；
//!   2. 世界段（2026-09-15 世界卡定稿）：会话恰一世界实例的世界观正文
//!      （worldbook，快照冻结）——舞台设定先于演员登场；None / 空白整段省略；
//!   3. 人设段（多角色群像，方案 §2 第 1 步 / D1-D3）：每个 LLM 位实例的 persona
//!      作为该角色的自我人设——**LLM 位唯一时保持 v1 单角色裸 persona 形态（等价
//!      改造）**，多 LLM 位时逐个分节（【角色名】+ persona）并附群像语境声明
//!      （v1.5 简化：多角色按 roster 序单次生成，尚未逐拍独立调用——见 generation.rs）；
//!      随后注入用户位 persona 作为「对话对手设定」段（措辞「用户扮演的角色：{name}
//!      ——{persona}」，D2 扮演位；persona 空白时只报名字或整段省略）；
//!   4. 当前虚时行「当前时间：…」（BR-003 记账层的读者侧投影）：最新场景行的
//!      记账位 + 会话日历（FR-013；0017 起历法唯一归属 = 世界实例快照），
//!      让角色知道「现在是什么时间」；
//!   5. 远景编年史：更早的每个场景恰好一行（场序 / 地点 / 时间原文 / 日历 label /
//!      一句话摘要中可用的字段），拼在人设段之后；人设段为空时 system 只含
//!      其余各段；Task-03 起两档——刚滑出窗口的**桥场**（窗口外最近的一场）有
//!      recap（两三句加厚回顾）时追加一行缩进回顾，无 recap 回退单行，更古老的
//!      场恒一行；
//!   6. 相关回忆（卷宗，Task-05 记忆探索器产出）：探索器查证出的与本回合直接
//!      相关的往事引文与事实（services/explorer.rs）；None / 空白省略；
//!   7. 人物状态快照（FR-012，迁移 0009 起挂实例）：状态按**实例**分组渲染——
//!      恰一个持有状态的实例时保持 v1 两小组形态（【当前状态】/【关系】，等价
//!      改造），多实例时逐实例分节（【实例名 · 组名】），让每个角色知道自己当前
//!      的状态；expiry 是给结算的清算线索，不进叙事快照（给模型的永远是「现在
//!      成立的事实」）；
//! - 近景 = 最近 N 个已结算场景的整场逐字消息 + 进行中场景全量（窗口数学见
//!   [`crate::domain::context`]），只取原始正文——reasoning 不进上下文：它是给
//!   用户看的思考，不是对话内容。N 可配（config.json `near_scenes`，1–6，缺省
//!   [`crate::domain::context::SETTLED_SCENES_IN_NEAR`]）＝近景窗口可选化：
//!   经 [`AssembleInputs::near_scenes`] 由调用方穿入，装配语义本身不变。
//!
//! 场景边界与结算归属同源：结算把「上一道场景线所在消息（不含）到触发行（含）」
//! 整段挂到上一场景行（ports::AttachRange），因此切分**优先按库内 scene_id 归属
//! 分组**（盖章段的行 / 段 id 精确对应）；scene_id 为 NULL 的游程沿用内容场景线
//! 判定（[`super::director::contains_scene_line`]）兜底切分，触发行归收束场，
//! 最后一道场景线之后 / 最新盖章段之后 = 进行中场。旧版两类已登记偏差在新语义下
//! 消除 / 收窄：
//! - 结算欠账（§7-2，场景线已出现但结算未落）：欠账消息恒 NULL，只在 NULL 游程内
//!   被内容切分承接——近景多带一场而不丢叙事，语义不变；欠账段无场景行、不占
//!   编年史行，已落行的行 / 段对应恒精确，远景偏移**不再随欠账数累积**。残余
//!   （仍接受）：欠账段滑出近景即丢——无行可接，没有编年史行对冲；
//! - 重新生成撞已结算边界（§7-3，旧行不回滚）：旧行软删、替换条以 NULL 插入尾部，
//!   盖章分组不受内容增删影响；被清空的场收敛为「空段」——行还在但消息没了，
//!   编年史行照常输出（id 精确对应），行数与场景线数不再错位，随下次成功结算
//!   近似自愈。

use crate::domain::context::{self, SceneSpan, SceneSpans};
use crate::domain::fiction_time::{self, CalendarConfig};
use crate::domain::models::{
    CharacterInstance, CharacterState, CharacterStateScope, Message, MessageRole, Scene,
};
use crate::infra::llm::{ChatMessage, ChatRole};

/// 一次装配的只读输入包：Task-01 后 system 注入渐增（persona / 虚时 / 编年史 /
/// 状态），收拢成 struct 免得参数列继续变长。`calendar` 为世界实例快照
/// （world_instances.calendar_config 经 [`fiction_time::parse`] 解析后的形态，
/// 0017 历法收编世界卡）——解析在调用方（services/generation.rs）完成，装配
/// 本体保持零 IO、纯函数。
/// `instances` 为全会话角色实例阵容（多角色群像，D1/D2）：装配按 is_user 分位——
/// LLM 位出自我人设段、用户位出对手设定段；组内保持调用方传入序（roster 序）。
pub struct AssembleInputs<'a> {
    pub instances: &'a [CharacterInstance],
    pub scenes: &'a [Scene],
    pub history: &'a [Message],
    pub calendar: &'a CalendarConfig,
    pub states: &'a [CharacterState],
    /// 相关回忆卷宗（Task-05）：探索器（services/explorer.rs）判定本回合需要往事
    /// 事实时产出的一段引文/事实，注入 system 第四段；None / 空白 = 无卷宗，段落
    /// 自然省略（system 退回四段形态，Task-02 行为不变）。
    pub dossier: Option<&'a str>,
    /// 近景携带的已结算场景数（近景窗口可选化）：config.json `near_scenes`
    /// （1–6，缺省 [`crate::domain::context::SETTLED_SCENES_IN_NEAR`]）由调用方
    /// 穿入；仅改窗口大小，装配/编年史语义不变（窗口数学见 context::near_view）。
    pub near_scenes: usize,
    /// 全局系统提示词（config.json `system_prompt`）：注入 system 消息最前段
    /// （先于人设段）；空白整段省略。与 near_scenes 同经 GenerationDeps 穿入。
    pub system_prompt: &'a str,
    /// 世界段（2026-09-15 世界卡定稿）：会话恰一世界实例的世界观正文（快照
    /// 冻结，读源 = storage 世界实例，经 generate_once 穿入——不属 GenerationDeps
    /// 的 config 穿参通道）；None / 空白整段省略，注入位置在人设段之前。
    pub world: Option<&'a str>,
}

/// 装配一次聊天的完整 messages：system(全局系统提示词 + 世界段 + 人设段 +
/// 当前虚时 + 远景编年史 + 相关回忆卷宗 + 人物状态快照) + 近景上下文。persona
/// 为空白时跳过对应段（角色卡允许空人设）；七段全空时不产生空 system 回合
/// （v1 不变量）。`scenes` 为空（场景特性之前的旧数据会话）时无虚时行与远景，
/// 全部消息按字符预算兜底（ADR-004 优雅退化，不 panic）。
pub fn assemble(input: &AssembleInputs<'_>) -> Vec<ChatMessage> {
    let AssembleInputs {
        instances,
        scenes,
        history,
        calendar,
        states,
        dossier,
        near_scenes,
        system_prompt,
        world,
    } = input;
    // 无场景行 = 旧数据：不做场景切分，整段历史视为进行中场走预算兜底。
    let spans = if scenes.is_empty() {
        SceneSpans {
            closed: Vec::new(),
            ongoing: history,
        }
    } else {
        split_into_scene_spans(history)
    };
    let near = context::near_view(
        spans,
        *near_scenes,
        context::NEAR_VIEW_CHAR_BUDGET,
    );

    let mut out = Vec::new();
    // system 常驻核心七段（顺序固定）：全局系统提示词 → 世界段 → 人设段 →
    // 当前虚时行 → 远景编年史 → 相关回忆（卷宗）→ 人物状态快照；各段空态自然
    // 省略，段间空行分隔。
    let mut sections: Vec<String> = Vec::new();
    // 第一段：全局系统提示词——用户自定义指令原文置于所有领域段之前（全局框架
    // 指令先于人设 / 世界段）；空白整段省略。
    let prompt = system_prompt.trim();
    if !prompt.is_empty() {
        sections.push(prompt.to_owned());
    }
    // 第二段：世界段——会话恰一世界实例的世界观正文（快照冻结，读源 = storage
    // 世界实例）；舞台设定先于演员登场，None / 空白整段省略（裸原文形态，
    // 同全局系统提示词，不加标头）。
    if let Some(world) = world.map(str::trim).filter(|text| !text.is_empty()) {
        sections.push(world.to_owned());
    }
    sections.extend(persona_sections(instances));
    if let Some(time) = current_time_line(calendar, scenes) {
        sections.push(time);
    }
    let chronicle = chronicle_block(scenes, &near.kept);
    if !chronicle.is_empty() {
        sections.push(chronicle);
    }
    // Task-05 卷宗段：编年史（一行流）与人物状态（现在的事实）之间的第五视角——
    // 「本回合按需查证的往事引文」；空白视为无卷宗，不注入空段。
    if let Some(dossier) = dossier.map(str::trim).filter(|text| !text.is_empty()) {
        sections.push(format!("【相关回忆】\n{dossier}"));
    }
    sections.extend(state_snapshot_sections(instances, states));
    if !sections.is_empty() {
        out.push(ChatMessage::new(ChatRole::System, sections.join("\n\n")));
    }
    for message in near.messages {
        let role = match message.role {
            MessageRole::User => ChatRole::User,
            MessageRole::Assistant => ChatRole::Assistant,
        };
        out.push(ChatMessage::new(role, message.content.clone()));
    }
    out
}

/// 人设段（多角色群像，方案 §3 装配语义 / D1-D3）：
/// - 每个 LLM 位实例一段自我人设——**LLM 位唯一时裸 persona**（v1 单角色形态的
///   等价改造，不带角色名标头）；多 LLM 位时逐个分节「【角色名】\n persona」
///   （空 persona 也出标头：多角色语境下名字即身份），并附一段群像语境声明
///   （v1.5 简化的诚实标注：单次生成、roster 序登场，逐拍独立调用属第 2 步后能力）；
/// - 用户位实例（恰一，D2）注入「对话对手设定」段，措辞「用户扮演的角色：{name}
///   ——{persona}」；persona 空白时只报名字。
///
/// 人设全空且无用户位段时返回空 Vec（空段自然省略不变量不受影响）。
fn persona_sections(instances: &[CharacterInstance]) -> Vec<String> {
    let llm: Vec<&CharacterInstance> = instances.iter().filter(|i| !i.is_user).collect();
    let user = instances.iter().find(|i| i.is_user);
    let mut sections = Vec::new();
    if llm.len() == 1 {
        // 等价形态：单 LLM 位保持裸 persona（BR-001 v1 形态），空白省略。
        let persona = llm[0].persona.trim();
        if !persona.is_empty() {
            sections.push(persona.to_string());
        }
    } else if llm.len() > 1 {
        for instance in &llm {
            let mut section = format!("【{}】", instance.name);
            let persona = instance.persona.trim();
            if !persona.is_empty() {
                section.push('\n');
                section.push_str(persona);
            }
            sections.push(section);
        }
        let names = llm
            .iter()
            .map(|i| i.name.as_str())
            .collect::<Vec<_>>()
            .join("、");
        sections.push(format!(
            "【群像语境】本会话有 {count} 位由模型扮演的角色：{names}。当前版本对整段对话单次生成，\
             请让各角色在回复中按名单顺序依次登场、以角色名区分发言。",
            count = llm.len(),
        ));
    }
    if let Some(user) = user {
        let persona = user.persona.trim();
        if persona.is_empty() {
            sections.push(format!("用户扮演的角色：{}", user.name));
        } else {
            sections.push(format!("用户扮演的角色：{}——{}", user.name, persona));
        }
    }
    sections
}

/// 把历史切成场景分段（模块注释：库内归属优先，与结算同一归属语义）。
///
/// 逐游程扫描：scene_id 有值的连续消息为一个**盖章段**（结算 AttachRange 写入的
/// 半开区间「(边界, 触发行]」，id 升序下归属必然连续成段，段序 = 首现顺序 = 场景
/// idx 序）；NULL 游程保留现行**内容场景线切分**兜底——进行中场 / 结算欠账 /
/// 重新生成替换条都在 NULL 内，切分仍按场景线进行（近景多带一场而不丢叙事），
/// 切出的欠账段无场景行、不占编年史行。末尾 NULL 游程的最后一段 = 进行中场；
/// 夹在盖章段之间的 NULL 游程按不变量必以其边界场景线收尾（下一段盖章段的
/// attach 起点），防御性兜底见函数体内注释。
/// Task-05 起探索器 read_scene 复用本切分（pub(super)，同一场景线知识不出 services）。
pub(super) fn split_into_scene_spans(history: &[Message]) -> SceneSpans<'_> {
    let mut closed = Vec::new();
    let mut ongoing = &history[history.len()..]; // 历史以盖章段收尾时进行中场为空
    let mut index = 0;
    while index < history.len() {
        let anchor = history[index].scene_id;
        if let Some(scene_id) = anchor {
            // 盖章游程：同 scene_id 连续延伸，整段一次成器（库内归属即切界，
            // 不再看内容——正是本切分消除欠账 / 重生成错位的地方）。
            let mut end = index + 1;
            while end < history.len() && history[end].scene_id == anchor {
                end += 1;
            }
            closed.push(SceneSpan { messages: &history[index..end], scene_id: Some(scene_id) });
            index = end;
        } else {
            // NULL 游程：现行内容场景线切分原样兜底。
            let mut seg_start = index;
            let mut cursor = index;
            while cursor < history.len() && history[cursor].scene_id.is_none() {
                if super::director::contains_scene_line(&history[cursor].content) {
                    closed.push(SceneSpan {
                        messages: &history[seg_start..=cursor],
                        scene_id: None,
                    });
                    seg_start = cursor + 1;
                }
                cursor += 1;
            }
            if seg_start < cursor {
                if cursor == history.len() {
                    // 末尾 NULL 游程的余段 = 进行中场。
                    ongoing = &history[seg_start..];
                } else {
                    // 夹在盖章段之间的 NULL 余段：按结算归属不变量不可达（该游程
                    // 必以其边界场景线收尾）——防御性收编为无锚已收束段，保叙事
                    // 不丢、不污染任何盖章段的精确对应。
                    closed.push(SceneSpan { messages: &history[seg_start..cursor], scene_id: None });
                }
            }
            index = cursor;
        }
    }
    SceneSpans { closed, ongoing }
}

/// 远景编年史（§7.8「之前每场一行摘要」；Task-03 两档）：收录比近景更早的场景行，
/// 每场恰好一行；**桥场**（窗口外最近的一场 = far 末行）有 recap 时追加一行缩进
/// 回顾（两三句加厚形态），无 recap 回退单行，更早的场恒单行。
/// 行 / 段**id 精确对应**（替代旧版位置推断）：远景 = 场景行 −（近景保留段锚定
/// 的行 ∪ 末尾进行中 header 行）。空段（重生成后行还在但消息没了）不占近景 →
/// 自动落远景出编年史行；被预算淘汰的段不占锚 → 其行落远景；欠账段锚为 None →
/// 不排除任何行，滑出近景即丢（无行可接，模块注释已记）。列缺失（锚行未回写 /
/// 欠账）跳过该字段，不输出「（未记录）」占位——编年史要的是一行一个脚印，不是
/// 快照。
fn chronicle_block(scenes: &[Scene], kept: &[SceneSpan<'_>]) -> String {
    let far: Vec<&Scene> = scenes
        .iter()
        .enumerate()
        .filter(|(position, scene)| {
            // 末行恒为进行中 header（结算只建行不挂消息），不入编年史。
            position + 1 != scenes.len()
                && !kept.iter().any(|span| span.scene_id == Some(scene.id))
        })
        .map(|(_, scene)| scene)
        .collect();
    if far.is_empty() {
        return String::new();
    }
    let mut block = String::from("【往事编年史】更早的场景各压缩为一行（从旧到新）：");
    for (position, scene) in far.iter().enumerate() {
        block.push_str(&format!("\n场{}", scene.idx));
        for field in [
            &scene.location,
            &scene.time_note,
            &scene.date_label,
            &scene.summary,
        ] {
            if let Some(text) = field.as_deref().filter(|text| !text.trim().is_empty()) {
                block.push_str(" · ");
                block.push_str(text);
            }
        }
        // 桥场加厚（Task-03）：仅窗口外最近的一场渲染 recap，缩进 + 树形前缀与
        // header 行区分；缺失 / 空白 → 回退单行。
        if position + 1 == far.len() {
            if let Some(recap) = scene.recap.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
                block.push_str(&format!("\n    └ 回顾：{recap}"));
            }
        }
    }
    block
}

/// 当前虚时行（BR-003 记账层的读者侧投影）：`当前时间：{label}`。
///
/// 数据 = 最新场景行（末行恒为进行中场，其记账位承接上一场结算——结算只建行不
/// 回填旧行，进行中场行在 FR-014 已 seed、此后被结算逐次推进）+ 会话日历快照。
/// 渲染优先级：date_label 缓存 → [`fiction_time::date_label`] 现算 → 整行省略。
/// 选**缓存优先**的理由：结算落库时缓存与 fic_day 同源派生（director.rs 用同一
/// 会话日历换算，含节日括注等结果），直接复用零重算且语义一致；缓存缺失（锚行
/// 未回写 / 旧数据）时用会话快照日历现算，[`fiction_time::date_label`] 自带
/// 无皮肤回退「第N日·时段」，两路形态归一。无最新场景或无记账位（fic_day 为空，
/// BR-003 记账层是唯一事实源）时整行省略，不猜测「第 1 天」。
fn current_time_line(calendar: &CalendarConfig, scenes: &[Scene]) -> Option<String> {
    let latest = scenes.last()?;
    let day = latest.fic_day?;
    let part = latest.fic_part.as_deref().unwrap_or("");
    let label = match latest.date_label.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(cached) => cached.to_string(),
        None => fiction_time::date_label(calendar, day, part),
    };
    Some(format!("当前时间：{label}"))
}

/// 人物状态快照段（FR-012，迁移 0009 起状态挂实例）：状态按**实例**分组。
/// - 恰一个持有状态的实例（单角色等价形态的主力分支）：保持 v1 两小组形态
///   【当前状态】/【关系】，每组标题 + 每条一行 `- key：value`；
/// - 多个实例持有状态：逐实例分节「【实例名 · 组名】」，节内每条一行同上——
///   多角色语境下每条状态的身份靠节标题（实例名）承载。
///
/// 组内顺序保持库序（id ASC，即状态建立的先后）；实例分组序 = roster 序（调用方
/// 传入序）；空组省略标题，全空省略整段（返回空 Vec）；expiry 不渲染——那是结算
/// 的清算线索，叙事快照只给「现在成立的事实」。状态指向未知实例（数据错位的不
/// 可达形态）时以「实例#{id}」兜底命名，不丢行。
fn state_snapshot_sections(
    instances: &[CharacterInstance],
    states: &[CharacterState],
) -> Vec<String> {
    let groups = [
        (CharacterStateScope::State, "当前状态"),
        (CharacterStateScope::Relation, "关系"),
    ];
    let name_of = |instance_id: i64| {
        instances
            .iter()
            .find(|i| i.id == instance_id)
            .map(|i| i.name.clone())
            .unwrap_or_else(|| format!("实例#{instance_id}"))
    };
    // 持有者按 roster 序去重，未入册的实例 id 按首现序追加在后。
    let mut owners: Vec<i64> = instances
        .iter()
        .map(|i| i.id)
        .filter(|id| states.iter().any(|s| s.instance_id == *id))
        .collect();
    for state in states {
        if !owners.contains(&state.instance_id) {
            owners.push(state.instance_id);
        }
    }
    if owners.len() == 1 {
        // 等价形态：唯一持有者 → v1 两小组（v1 会话只有一个角色实例，语义一致）。
        return groups
            .iter()
            .filter_map(|(scope, title)| {
                let rows: Vec<&CharacterState> = states
                    .iter()
                    .filter(|state| state.instance_id == owners[0] && state.scope == *scope)
                    .collect();
                if rows.is_empty() {
                    return None;
                }
                let mut block = format!("【{title}】");
                for row in rows {
                    block.push_str(&format!("\n- {}：{}", row.key, row.value));
                }
                Some(block)
            })
            .collect();
    }
    let mut sections = Vec::new();
    for owner in owners {
        let name = name_of(owner);
        for (scope, title) in groups {
            let rows: Vec<&CharacterState> = states
                .iter()
                .filter(|state| state.instance_id == owner && state.scope == scope)
                .collect();
            if rows.is_empty() {
                continue;
            }
            let mut block = format!("【{name} · {title}】");
            for row in rows {
                block.push_str(&format!("\n- {}：{}", row.key, row.value));
            }
            sections.push(block);
        }
    }
    sections
}


#[cfg(test)]
mod tests;
