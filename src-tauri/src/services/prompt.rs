//! Prompt 装配（TASK-006 / FR-001 / FR-003 / FR-012 / ADR-004）：纯函数，可单测，不做 IO。
//!
//! ADR-004 场景对齐装配（§7.8 近景/远景，替换 ADR-002 条数滑窗）：
//! - system = 常驻核心五段（各段空态自然省略；全空时不产生 system 回合）：
//!   1. 人设卡 persona（BR-001「在场完整人设」的 v1 单角色形态）；
//!   2. 当前虚时行「当前时间：…」（BR-003 记账层的读者侧投影）：最新场景行的
//!      记账位 + 会话日历快照（FR-013），让角色知道「现在是什么时间」；
//!   3. 远景编年史：更早的每个场景恰好一行（场序 / 地点 / 时间原文 / 日历 label /
//!      一句话摘要中可用的字段），拼在 persona 之后；persona 为空时 system 只含
//!      其余四段；Task-03 起两档——刚滑出窗口的**桥场**（窗口外最近的一场）有
//!      recap（两三句加厚回顾）时追加一行缩进回顾，无 recap 回退单行，更古老的
//!      场恒一行；
//!   4. 相关回忆（卷宗，Task-05 记忆探索器产出）：探索器查证出的与本回合直接
//!      相关的往事引文与事实（services/explorer.rs）；None / 空白省略；
//!   5. 人物状态快照（FR-012）：character_state 按 scope 分「当前状态」/「关系」
//!      两组渲染，让角色知道自己当前的状态；expiry 是给结算的清算线索，不进
//!      叙事快照（给模型的永远是「现在成立的事实」）；
//! - 近景 = 最近 N 个已结算场景的整场逐字消息 + 进行中场景全量（窗口数学见
//!   [`crate::domain::context`]），只取原始正文——reasoning 不进上下文：它是给
//!   用户看的思考，不是对话内容。
//!
//! 场景边界与结算归属同源：结算把「上一道场景线所在消息（不含）到触发行（含）」
//! 整段挂到上一场景行（ports::AttachRange），因此这里用同一判定
//! （[`super::director::contains_scene_line`]）按场景线消息切段，触发行归收束场，
//! 最后一道场景线之后 = 进行中场（scene_id 尚为 NULL）。已知偏差（接受并记录）：
//! - 结算欠账（§7-2，场景线已出现但结算未落）：切分仍按场景线进行，近景多带一场
//!   而不丢叙事；远景以场景行为准，无行的场不产生编年史行——偏移随欠账数累积，
//!   上限 = 欠账场数行级缺失（每欠一场至多让远景少一行，已落行的信息不丢）；
//! - 重新生成撞已结算边界（§7-3）：旧行不回滚，行数与场景线数可能短暂错位，
//!   至多影响单行编年史的归属，随下次成功结算近似自愈。

use crate::domain::context::{self, SceneSpans};
use crate::domain::fiction_time::{self, CalendarConfig};
use crate::domain::models::{
    Character, CharacterState, CharacterStateScope, Message, MessageRole, Scene,
};
use crate::infra::llm::{ChatMessage, ChatRole};

/// 一次装配的只读输入包：Task-01 后 system 注入渐增（persona / 虚时 / 编年史 /
/// 状态），收拢成 struct 免得参数列继续变长。`calendar` 为会话快照
/// （session.calendar_config 经 [`fiction_time::parse`] 解析后的形态）——解析在
/// 调用方（services/generation.rs）完成，装配本体保持零 IO、纯函数。
pub struct AssembleInputs<'a> {
    pub character: &'a Character,
    pub scenes: &'a [Scene],
    pub history: &'a [Message],
    pub calendar: &'a CalendarConfig,
    pub states: &'a [CharacterState],
    /// 相关回忆卷宗（Task-05）：探索器（services/explorer.rs）判定本回合需要往事
    /// 事实时产出的一段引文/事实，注入 system 第四段；None / 空白 = 无卷宗，段落
    /// 自然省略（system 退回四段形态，Task-02 行为不变）。
    pub dossier: Option<&'a str>,
}

/// 装配一次聊天的完整 messages：system(persona + 当前虚时 + 远景编年史 + 相关回忆
/// 卷宗 + 人物状态快照) + 近景上下文。persona 为空白时跳过 persona（角色卡允许空
/// 人设）；五段全空时不产生空 system 回合（v1 不变量）。`scenes` 为空（场景特性之前
/// 的旧数据会话）时无虚时行与远景，全部消息按字符预算兜底（ADR-004 优雅退化，不 panic）。
pub fn assemble(input: &AssembleInputs<'_>) -> Vec<ChatMessage> {
    let AssembleInputs { character, scenes, history, calendar, states, dossier } = input;
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
        context::SETTLED_SCENES_IN_NEAR,
        context::NEAR_VIEW_CHAR_BUDGET,
    );

    let mut out = Vec::new();
    // system 常驻核心五段（顺序固定）：persona → 当前虚时行 → 远景编年史 →
    // 相关回忆（卷宗）→ 人物状态快照；各段空态自然省略，段间空行分隔。
    let mut sections: Vec<String> = Vec::new();
    let persona = character.persona.trim();
    if !persona.is_empty() {
        sections.push(persona.to_string());
    }
    if let Some(time) = current_time_line(calendar, scenes) {
        sections.push(time);
    }
    let chronicle = chronicle_block(scenes, near.kept_settled);
    if !chronicle.is_empty() {
        sections.push(chronicle);
    }
    // Task-05 卷宗段：编年史（一行流）与人物状态（现在的事实）之间的第五视角——
    // 「本回合按需查证的往事引文」；空白视为无卷宗，不注入空段。
    if let Some(dossier) = dossier.map(str::trim).filter(|text| !text.is_empty()) {
        sections.push(format!("【相关回忆】\n{dossier}"));
    }
    sections.extend(state_snapshot_sections(states));
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

/// 按场景线把历史切成场景分段（模块注释：与结算归属同一切界）。
/// 末条含场景线的连续段 = 已收束场（含触发行本身），其后直到下一道场景线；
/// 最后一道场景线之后（或全程无场景线时）为进行中场。
/// Task-05 起探索器 read_scene 复用本切分（pub(super)，同一场景线知识不出 services）。
pub(super) fn split_into_scene_spans(history: &[Message]) -> SceneSpans<'_> {
    let mut closed = Vec::new();
    let mut start = 0;
    for (index, message) in history.iter().enumerate() {
        if super::director::contains_scene_line(&message.content) {
            closed.push(&history[start..=index]);
            start = index + 1;
        }
    }
    SceneSpans {
        closed,
        ongoing: &history[start..],
    }
}

/// 远景编年史（§7.8「之前每场一行摘要」；Task-03 两档）：收录比近景更早的场景行，
/// 每场恰好一行；**桥场**（窗口外最近的一场 = far 末行）有 recap 时追加一行缩进
/// 回顾（两三句加厚形态），无 recap 回退单行，更早的场恒单行。
/// 场景行数 = 进行中 header 行（结算只建行不挂消息，最后 1 行恒为进行中场）+
/// `kept_settled` 行（整场在近景）+ 远景行数。列缺失（锚行未回写 / 欠账）跳过该
/// 字段，不输出「（未记录）」占位——编年史要的是一行一个脚印，不是快照。
fn chronicle_block(scenes: &[Scene], kept_settled: usize) -> String {
    let far = &scenes[..scenes.len().saturating_sub(1 + kept_settled)];
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

/// 人物状态快照段（FR-012）：按 scope 分「当前状态」（state）/「关系」（relation）
/// 两组，每组标题 + 每条一行 `- key：value`（中文冒号，与编年史的「·」分隔风格同系）。
/// 空组省略标题，全空省略整段（返回空 Vec）；expiry 不渲染——那是结算的清算线索，
/// 叙事快照只给「现在成立的事实」。组内顺序保持库序（id ASC，即状态建立的先后）。
fn state_snapshot_sections(states: &[CharacterState]) -> Vec<String> {
    let groups = [
        (CharacterStateScope::State, "当前状态"),
        (CharacterStateScope::Relation, "关系"),
    ];
    groups
        .iter()
        .filter_map(|(scope, title)| {
            let rows: Vec<&CharacterState> =
                states.iter().filter(|state| state.scope == *scope).collect();
            if rows.is_empty() {
                return None;
            }
            let mut block = format!("【{title}】");
            for row in rows {
                block.push_str(&format!("\n- {}：{}", row.key, row.value));
            }
            Some(block)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::NewCharacter;

    /// 默认历（无命名皮肤）单例：既有用例的「无日历注入」对照基线。
    static DEFAULT_CALENDAR: std::sync::LazyLock<CalendarConfig> =
        std::sync::LazyLock::new(CalendarConfig::default);

    /// Task-01 三参形态的等价包装（默认历 + 无状态）：供迁移用例与「无注入」对照。
    fn assemble_base(
        character: &Character,
        scenes: &[Scene],
        history: &[Message],
    ) -> Vec<ChatMessage> {
        assemble(&AssembleInputs {
            character,
            scenes,
            history,
            calendar: &DEFAULT_CALENDAR,
            states: &[],
            dossier: None,
        })
    }

    fn character(persona: &str) -> Character {
        let new = NewCharacter {
            name: "苏鸢".into(),
            persona: persona.into(),
            ..Default::default()
        };
        Character {
            id: 1,
            name: new.name,
            avatar: None,
            persona: new.persona,
            gender: new.gender,
            age: new.age,
            render_style: new.render_style,
            model_config: None,
            accent_color: new.accent_color,
            voice_config: None,
            calendar_config: None,
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
        }
    }

    fn message(id: i64, role: MessageRole, content: &str) -> Message {
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
            deleted_at: None,
        }
    }

    /// 场景行：idx 单调递增，各可空字段给全（锚行用 [`anchor_scene`] 造缺省形态）；
    /// recap 可选（Task-03 桥场加厚，None = 未产出 / 旧数据）。
    fn scene(idx: i64, summary: &str) -> Scene {
        Scene {
            id: idx + 1,
            session_id: 1,
            idx,
            location: Some(format!("地点{idx}")),
            time_note: Some(format!("第{idx}天的清晨")),
            fic_day: Some(idx),
            fic_part: Some("清晨".into()),
            date_label: Some(format!("第{idx}日·清晨")),
            summary: Some(summary.into()),
            recap: None,
            present: vec![1],
            deleted_at: None,
        }
    }

    /// 开场锚行（FR-014）：只有记账位，地点/摘要等尚未回填。
    fn anchor_scene(summary: &str) -> Scene {
        Scene {
            id: 1,
            session_id: 1,
            idx: 0,
            location: None,
            time_note: None,
            fic_day: Some(1),
            fic_part: Some("夜".into()),
            date_label: None,
            summary: (!summary.is_empty()).then(|| summary.to_string()),
            recap: None,
            present: vec![1],
            deleted_at: None,
        }
    }

    /// 人物状态行（FR-012）：expiry 可选（快照渲染不消费，用于断言「不渲染」）。
    fn state(scope: CharacterStateScope, key: &str, value: &str, expiry: Option<&str>) -> CharacterState {
        CharacterState {
            id: 1,
            character_id: 1,
            session_id: 1,
            scope,
            key: key.into(),
            value: value.into(),
            expiry: expiry.map(str::to_string),
            source_scene: None,
            updated_at: 0,
            deleted_at: None,
        }
    }

    /// 标准多场历史：4 个已收束场（触发行带 ---）+ 进行中场；reasoning 挂在
    /// 进行中场上验证排除。
    fn multi_scene_history() -> Vec<Message> {
        vec![
            message(1, MessageRole::User, "场一问"),
            message(2, MessageRole::Assistant, "场一答\n\n---\n\n场二开场"),
            message(3, MessageRole::User, "场二问"),
            message(4, MessageRole::Assistant, "场二答\n\n---\n\n场三开场"),
            message(5, MessageRole::User, "场三问"),
            message(6, MessageRole::Assistant, "场三答\n\n---\n\n场四开场"),
            message(7, MessageRole::User, "场四问"),
            message(8, MessageRole::Assistant, "场四答\n\n---\n\n场五开场"),
            message(9, MessageRole::User, "进行中问"),
            message(10, MessageRole::Assistant, "进行中答"),
        ]
        .into_iter()
        .map(|mut m| {
            if m.id >= 9 {
                m.reasoning = Some("不该进上下文的思考".into());
            }
            m
        })
        .collect()
    }

    /// 对应 [`multi_scene_history`] 的场景行：锚行 + 四次结算 + 进行中 header 行。
    fn multi_scene_rows() -> Vec<Scene> {
        vec![
            anchor_scene("场一摘要"),
            scene(1, "场二摘要"),
            scene(2, "场三摘要"),
            scene(3, "场四摘要"),
            scene(4, "（进行中）"),
        ]
    }

    /// FR-001 / UC-001 / ADR-004：system(persona) + 近景上下文（无场景时全量）。
    #[test]
    fn assembles_persona_and_history_without_scenes() {
        let c = character("雨夜电话亭的守夜人。");
        let history = vec![
            message(1, MessageRole::User, "在吗？"),
            message(2, MessageRole::Assistant, "在。"),
        ];
        let messages = assemble_base(&c, &[], &history);

        assert_eq!(messages.len(), 3, "system + 2 条上下文");
        assert_eq!(messages[0].role, ChatRole::System);
        assert_eq!(messages[0].content, "雨夜电话亭的守夜人。");
        assert_eq!(messages[1].role, ChatRole::User);
        assert_eq!(messages[2].role, ChatRole::Assistant);
    }

    /// ADR-004 多场近景切分：最近 2 个已结算场**整场逐字** + 进行中场全量，顺序不变；
    /// 更早的场一（m1/m2）不进近景、由编年史行对冲；reasoning 不进上下文；
    /// 远景每场恰好一行；虚时行取最新场景行（进行中场）的记账位（默认历无注入时
    /// 亦由缓存渲染，Task-02 后 system 含「当前时间」）。
    #[test]
    fn multi_scene_near_view_verbatim_and_chronicle_one_line_each() {
        let c = character("人设");
        let messages = assemble_base(&c, &multi_scene_rows(), &multi_scene_history());

        assert_eq!(
            messages.len(),
            7,
            "system + 近景 6 条（两场各 2 条 + 进行中 2 条）"
        );
        let chat: Vec<(ChatRole, &str)> = messages[1..]
            .iter()
            .map(|m| (m.role, m.content.as_str()))
            .collect();
        assert_eq!(
            chat,
            vec![
                (ChatRole::User, "场三问"),
                (ChatRole::Assistant, "场三答\n\n---\n\n场四开场"),
                (ChatRole::User, "场四问"),
                (ChatRole::Assistant, "场四答\n\n---\n\n场五开场"),
                (ChatRole::User, "进行中问"),
                (ChatRole::Assistant, "进行中答"),
            ],
            "整场逐字、消息顺序不变（含触发消息原文）"
        );
        assert!(
            messages
                .iter()
                .all(|m| !m.content.contains("不该进上下文的思考")),
            "reasoning 不进上下文"
        );
        assert!(
            !messages
                .iter()
                .any(|m| m.content.contains("场一问") || m.content.contains("场二问")),
            "超出近景场数的旧场不进近景"
        );

        // system = persona + 虚时行 + 编年史；远景 = 锚行 + 场二行（更近的场与进行中
        // 行不入），每场恰好一行（skip(5) 跳过 persona、虚时与两处段间空行、编年史
        // 标题行）。
        let system = &messages[0].content;
        assert!(
            system.starts_with("人设\n\n当前时间：第4日·清晨\n\n【往事编年史】"),
            "persona → 虚时行（最新场景行 date_label 缓存）→ 编年史，实际：{system}"
        );
        let lines: Vec<&str> = system.lines().skip(5).collect();
        assert_eq!(
            lines.len(),
            2,
            "远景每场恰好一行（锚行 + 场二行），实际：{system}"
        );
        assert!(
            lines[0].starts_with("场0 · "),
            "锚行 idx=0，缺字段自然省略：{}",
            lines[0]
        );
        assert!(
            lines[0].ends_with("场一摘要"),
            "锚行摘要在场末：{}",
            lines[0]
        );
        assert!(lines[1].contains("场1") && lines[1].contains("地点1"));
        assert!(lines[1].contains("第1天的清晨") && lines[1].contains("第1日·清晨"));
        assert!(
            lines[1].ends_with("场二摘要"),
            "四类字段齐全的完整行：{}",
            lines[1]
        );
    }

    /// 无场景会话（旧数据/场景特性之前）：远景为空，全部消息按字符预算兜底；
    /// 超预算丢最旧，顺序不变、不 panic。
    #[test]
    fn no_scenes_degrades_to_char_budget_window() {
        let c = character("人设");
        let history: Vec<Message> = (0..30)
            .map(|i| message(i, MessageRole::User, &format!("行{i}{}", "字".repeat(996))))
            .collect();
        let messages = assemble_base(&c, &[], &history);
        assert_eq!(
            messages.len(),
            1 + 24,
            "30000 字 > 24000 预算 → 头截断留最新 24 条"
        );
        assert!(
            messages[1].content.starts_with("行6"),
            "最旧 6 条被丢：{}",
            messages[1].content
        );
        assert!(messages.last().unwrap().content.starts_with("行29"));
        assert_eq!(messages[0].content, "人设", "远景为空，system 只含 persona");
    }

    /// 字符预算触发整场淘汰：最旧的入选场**整场**出局，其场景行自动落入远景编年史
    /// （远景行数随淘汰增长），入选场仍整场保留。
    #[test]
    fn char_budget_evicts_whole_scene_into_chronicle() {
        let c = character("人设");
        // 三场各 13000 字（每场 2 条 × 6500），进行中场很小：场 B+场 C = 26000 > 24000
        // → 淘汰 B → 近景 = 场 C + 进行中（13000+小额 ≤ 24000）。
        let history = vec![
            message(1, MessageRole::User, &"甲".repeat(6_500)),
            message(2, MessageRole::Assistant, &"甲".repeat(6_400)), // 场 A（默认已出近景）
            message(3, MessageRole::User, &"乙".repeat(6_500)),
            message(4, MessageRole::Assistant, &"乙".repeat(6_400)), // 场 B（被预算淘汰）
            message(5, MessageRole::User, &"丙".repeat(6_500)),
            message(6, MessageRole::Assistant, &"丙".repeat(6_400)), // 场 C（保留）
            message(7, MessageRole::User, "进行中"),
        ];
        // 触发场景线：把每场末条尾部接上 ---（内容超长无妨，判定按整行）。
        let mut history = history;
        for id in [2, 4, 6] {
            history[id as usize - 1].content.push_str("\n\n---\n\n新场");
        }
        let scenes = vec![
            anchor_scene("场A摘要"),
            scene(1, "场B摘要"),
            scene(2, "场C摘要"),
            scene(3, "（进行中）"),
        ];

        let messages = assemble_base(&c, &scenes, &history);
        let chat_contents: Vec<&str> = messages[1..].iter().map(|m| m.content.as_str()).collect();
        assert_eq!(
            chat_contents.len(),
            3,
            "近景 = 场 C（2 条）+ 进行中（1 条）"
        );
        assert!(
            chat_contents.iter().all(|s| !s.contains('乙')),
            "场 B 整场淘汰，不得残留"
        );
        assert!(chat_contents[0].starts_with("丙"), "场 C 整场保留");

        // 远景 = 锚行 + 场 B（淘汰的场落入编年史），每场一行；无淘汰时只有锚行一行。
        let system = &messages[0].content;
        assert!(
            system.contains("场A摘要"),
            "默认窗口外的场 A 在编年史：{system}"
        );
        assert!(
            system.contains("场B摘要"),
            "被预算淘汰的场 B 落入编年史：{system}"
        );
        assert!(
            !system.contains("场C摘要"),
            "仍在近景的场不进编年史（去重）"
        );
        let lines: Vec<&str> = system.lines().skip(5).collect();
        assert_eq!(lines.len(), 2, "远景行数随整场淘汰增长（1 → 2）");
    }

    /// 超长进行中场：头截断（丢最旧消息），已结算场全数让位并落入编年史。
    #[test]
    fn oversized_ongoing_scene_head_truncates() {
        let c = character("人设");
        let mut history = vec![
            message(1, MessageRole::User, "场一问"),
            message(2, MessageRole::Assistant, "场一答\n\n---\n\n场二开场"), // 唯一已结算场
        ];
        for i in 0..30 {
            history.push(message(
                100 + i,
                MessageRole::User,
                &format!("行{i}{}", "字".repeat(996)),
            ));
        }
        let scenes = vec![anchor_scene("场一摘要"), scene(1, "（进行中）")];

        let messages = assemble_base(&c, &scenes, &history);
        let chat: Vec<&str> = messages[1..].iter().map(|m| m.content.as_str()).collect();
        assert_eq!(
            chat.len(),
            24,
            "进行中场 30000 字 > 24000 → 头截断留最新 24 条"
        );
        assert!(chat[0].starts_with("行6"), "丢最旧 6 条：{}", chat[0]);
        assert!(chat.last().unwrap().starts_with("行29"), "最新一条在");
        assert!(!chat.iter().any(|s| s.contains("场一")), "已结算场全部让位");
        assert!(
            messages[0].content.contains("场一摘要"),
            "让位的场落入编年史：{}",
            messages[0].content
        );
    }

    /// 重新生成（FR-008 / OQ-006）：被替换的 assistant（含场景线）从历史剔除后再装配，
    /// 切分按剔除后的内容重算——不残留幻影边界，也不丢仍在场内的消息。
    #[test]
    fn regenerate_filtered_history_recomputes_spans() {
        let c = character("人设");
        let scenes = vec![anchor_scene("")];
        let full = vec![
            message(1, MessageRole::User, "问1"),
            message(2, MessageRole::Assistant, "答1\n\n---\n\n新场"),
            message(3, MessageRole::User, "问2"),
        ];

        // 对照：剔除前 = 已结算场（问1 + 答1）+ 进行中场（问2）。
        let before = assemble_base(&c, &scenes, &full);
        assert_eq!(before.len(), 4);
        assert_eq!(before[2].content, "答1\n\n---\n\n新场");

        // 剔除被替换条（含 --- 的 assistant）后：无场景线 → 全部消息为进行中场，
        // 恰好少掉被替换的那一条，其余原样保留。
        let filtered = vec![
            message(1, MessageRole::User, "问1"),
            message(3, MessageRole::User, "问2"),
        ];
        let messages = assemble_base(&c, &scenes, &filtered);
        assert_eq!(messages.len(), 3, "system + 2 条（无幻影边界拆分）");
        assert_eq!(messages[1].content, "问1");
        assert_eq!(messages[2].role, ChatRole::User);
        assert_eq!(messages[2].content, "问2");
    }

    /// 空 persona + 有注入（Task-02 验收）：system = 虚时行 + 编年史 + 状态快照的
    /// 组合——不产生空消息、不带 persona 空白；「全空不产生空 system」的 v1 不变量
    /// 在新注入下保持（见 [`skips_blank_persona_without_scenes`]）。
    #[test]
    fn blank_persona_system_combines_time_chronicle_and_states() {
        let c = character("   ");
        let states = vec![
            state(CharacterStateScope::State, "情绪", "释然", Some("scene_end")),
            state(CharacterStateScope::Relation, "对旅人", "警惕", None),
        ];
        let calendar = CalendarConfig::default();
        let messages = assemble(&AssembleInputs {
            character: &c,
            scenes: &multi_scene_rows(),
            history: &multi_scene_history(),
            calendar: &calendar,
            states: &states,
            dossier: None,
        });

        assert_eq!(messages[0].role, ChatRole::System);
        let system = &messages[0].content;
        assert!(
            system.starts_with("当前时间：第4日·清晨\n\n【往事编年史】"),
            "persona 空白不残留，虚时行直接开头：{system}"
        );
        // 三段顺序（Task-02 装配序）：虚时 → 编年史 → 状态，位置单调递增。
        let chronicle_at = system.find("【往事编年史】").unwrap();
        let state_at = system.find("【当前状态】").unwrap();
        let relation_at = system.find("【关系】").unwrap();
        assert!(
            chronicle_at < state_at && state_at < relation_at,
            "段落顺序：虚时 → 编年史 → 状态，实际：{system}"
        );
        assert!(system.contains("场一摘要"), "编年史仍在");
        assert!(
            system.contains("\n- 情绪：释然") && system.contains("\n- 对旅人：警惕"),
            "状态行形态 `- key：value`：{system}"
        );
        assert!(!system.contains("scene_end"), "expiry 不进叙事快照");
        assert_eq!(messages.len(), 7, "近景不受 persona 空白影响");
    }

    /// 空 persona 且无任何注入（无场景 / 无状态）：不产生 system 回合（沿用 v1 不变量）。
    #[test]
    fn skips_blank_persona_without_scenes() {
        let c = character("  ");
        let history = vec![message(1, MessageRole::User, "你好")];
        let messages = assemble_base(&c, &[], &history);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, ChatRole::User);
    }

    // ---- Task-02：当前虚时行（三态）----

    /// 虚时行第一态：最新场景行带 date_label 缓存 → 直接用缓存渲染，即使会话日历
    /// 与缓存来源不同（缓存与 fic_day 同源派生，复用零重算）。
    #[test]
    fn time_line_prefers_cached_date_label() {
        let c = character("人设");
        let mut rows = multi_scene_rows();
        let last = rows.last_mut().unwrap();
        last.date_label = Some("白蜡月·晨露日·夜（灯节）".into());
        // 会话日历故意为空皮肤：若走现算会得到「第4日·清晨」，断言必须命中缓存。
        let calendar = CalendarConfig::default();
        let messages = assemble(&AssembleInputs {
            character: &c,
            scenes: &rows,
            history: &multi_scene_history(),
            calendar: &calendar,
            states: &[],
            dossier: None,
        });

        let system = &messages[0].content;
        assert!(
            system.contains("\n\n当前时间：白蜡月·晨露日·夜（灯节）"),
            "date_label 缓存优先于现算：{system}"
        );
        assert!(!system.contains("第4日"), "未走现算路径：{system}");
    }

    /// 虚时行第二态：缓存缺失 → 用会话快照日历现算——皮肤历出命名形式
    /// （fiction_time::date_label 的双射换算，含节日括注等结果）。
    #[test]
    fn time_line_computes_from_calendar_when_cache_missing() {
        let c = character("人设");
        let history = vec![message(1, MessageRole::User, "在吗？")];
        // 锚行（FR-014）：fic_day=1 / fic_part=夜 / date_label=None → 现算路径。
        let scenes = vec![anchor_scene("")];
        let calendar = crate::domain::fiction_time::presets::fantasy();

        let messages = assemble(&AssembleInputs {
            character: &c,
            scenes: &scenes,
            history: &history,
            calendar: &calendar,
            states: &[],
            dossier: None,
        });
        assert_eq!(
            messages[0].content,
            "人设\n\n当前时间：霜月·晨露日·夜",
            "缓存缺失时按会话快照日历现算命名形式：{}",
            messages[0].content
        );
    }

    /// 虚时行第二态的无皮肤分支：缓存缺失 + 默认历（无命名皮肤）→ 回退数字形式
    /// 「第N日·时段」（date_label 自带回退，与缓存路径形态归一）。
    #[test]
    fn time_line_falls_back_to_numeric_without_skin_or_cache() {
        let c = character("人设");
        let history = vec![message(1, MessageRole::User, "在吗？")];
        let scenes = vec![anchor_scene("")];

        let messages = assemble(&AssembleInputs {
            character: &c,
            scenes: &scenes,
            history: &history,
            calendar: &DEFAULT_CALENDAR,
            states: &[],
            dossier: None,
        });
        assert_eq!(
            messages[0].content,
            "人设\n\n当前时间：第1日·夜",
            "无皮肤回退「第N日·时段」：{}",
            messages[0].content
        );
    }

    /// 虚时行第三态：无最新场景（旧数据会话）或最新场景无记账位（fic_day 空）→
    /// 整行省略，不猜测时间。
    #[test]
    fn time_line_omitted_without_scene_or_ledger() {
        let c = character("人设");
        let history = vec![message(1, MessageRole::User, "在吗？")];
        let calendar = crate::domain::fiction_time::presets::fantasy();

        // 无场景（场景特性之前的旧数据会话）：无虚时行。
        let messages = assemble(&AssembleInputs {
            character: &c,
            scenes: &[],
            history: &history,
            calendar: &calendar,
            states: &[],
            dossier: None,
        });
        assert_eq!(
            messages[0].content, "人设",
            "无最新场景整行省略：{}",
            messages[0].content
        );

        // 最新场景无记账位（fic_day=None，date_label 同源亦 None）：同样省略。
        let mut rows = multi_scene_rows();
        for row in &mut rows {
            row.fic_day = None;
            row.date_label = None;
        }
        let messages = assemble(&AssembleInputs {
            character: &c,
            scenes: &rows,
            history: &multi_scene_history(),
            calendar: &calendar,
            states: &[],
            dossier: None,
        });
        assert!(
            !messages[0].content.contains("当前时间"),
            "无记账位（BR-003 唯一事实源缺失）不猜测时间：{}",
            messages[0].content
        );
    }

    // ---- Task-02：人物状态快照段 ----

    /// 状态快照空组省略：只有 relation 时只出【关系】组（空 state 组不渲染标题）；
    /// 全空时整段省略；组内顺序保持库序（id ASC）。
    #[test]
    fn state_snapshot_omits_empty_group_or_whole_section() {
        let c = character("人设");
        let history = vec![message(1, MessageRole::User, "在吗？")];
        let calendar = CalendarConfig::default();

        // 只有 relation：只渲染【关系】，不出现空【当前状态】标题。
        let states = vec![
            state(CharacterStateScope::Relation, "对旅人", "好奇", None),
            state(CharacterStateScope::Relation, "与守夜人的约定", "保守秘密", Some("event:告别")),
        ];
        let messages = assemble(&AssembleInputs {
            character: &c,
            scenes: &[],
            history: &history,
            calendar: &calendar,
            states: &states,
            dossier: None,
        });
        assert_eq!(
            messages[0].content,
            "人设\n\n【关系】\n- 对旅人：好奇\n- 与守夜人的约定：保守秘密",
            "空 state 组省略标题，组内保持库序，expiry 不渲染：{}",
            messages[0].content
        );

        // 全空：整段省略。
        let messages = assemble(&AssembleInputs {
            character: &c,
            scenes: &[],
            history: &history,
            calendar: &calendar,
            states: &[],
            dossier: None,
        });
        assert_eq!(messages[0].content, "人设", "状态全空整段省略");
    }

    // ---- Task-03：桥场加厚（远景两档渲染） ----

    /// 桥场（窗口外最近的一场 = 编年史末行）有 recap → 追加一行缩进回顾，
    /// 树形前缀「└」与 header 行区分；header 行自身形态不变（summary 仍在行末）。
    #[test]
    fn bridge_scene_renders_recap_as_indented_review_line() {
        let c = character("人设");
        let mut rows = multi_scene_rows();
        // 远景 = 锚行 + 场二行（idx1）；桥场 = 场二行。
        rows[1].recap = Some("巷口初遇时她提灯替我照了一段路。后来我们在钟楼下分食了一块饼。分别时她说明天见。".into());

        let messages = assemble_base(&c, &rows, &multi_scene_history());
        let system = &messages[0].content;
        assert!(
            system.contains("\n    └ 回顾：巷口初遇时她提灯替我照了一段路。后来我们在钟楼下分食了一块饼。分别时她说明天见。"),
            "桥场 recap 渲染为缩进回顾行：{system}"
        );
        // 回顾行紧跟桥场 header 行（场1 行以 summary 结尾，回顾行紧随其后）。
        let bridge_header = system.lines().find(|l| l.starts_with("场1")).unwrap();
        let bridge_at = system.lines().position(|l| l == bridge_header).unwrap();
        let after = system.lines().nth(bridge_at + 1).unwrap();
        assert!(after.starts_with("    └ 回顾："), "回顾行紧随桥场 header：{system}");
        assert!(bridge_header.ends_with("场二摘要"), "header 行形态不变，summary 仍在行末");
    }

    /// 桥场无 recap（旧数据 / 模型未产出）→ 回退现有单行形态，不产生回顾行。
    #[test]
    fn bridge_scene_without_recap_falls_back_to_single_line() {
        let c = character("人设");
        // multi_scene_rows 全部 recap = None：远景 = 锚行 + 场二行，每场恰好一行。
        let messages = assemble_base(&c, &multi_scene_rows(), &multi_scene_history());
        let system = &messages[0].content;
        assert!(!system.contains("└ 回顾"), "无 recap 不输出回顾行：{system}");
        let lines: Vec<&str> = system.lines().skip(5).collect();
        assert_eq!(lines.len(), 2, "远景每场恰好一行（回退 Task-01 形态）");
        // 空白 recap 同为 None 路径：trim 后空 → 不渲染。
        let mut rows = multi_scene_rows();
        rows[1].recap = Some("   ".into());
        let messages = assemble_base(&c, &rows, &multi_scene_history());
        assert!(!messages[0].content.contains("└ 回顾"), "空白 recap 视为无：跳过");
    }

    /// 更早的场（桥场之前的远景行）即使有 recap 也保持单行——加厚只给桥场。
    #[test]
    fn older_scenes_stay_single_line_even_with_recap() {
        let c = character("人设");
        let mut rows = multi_scene_rows();
        // 更早的锚行也塞了 recap：只有桥场（场二行 idx1）的 recap 被渲染。
        rows[0].recap = Some("锚行不该出现的回顾。".into());
        rows[1].recap = Some("桥场回顾：一句。两句。三句。".into());

        let messages = assemble_base(&c, &rows, &multi_scene_history());
        let system = &messages[0].content;
        assert!(
            system.contains("\n    └ 回顾：桥场回顾：一句。两句。三句。"),
            "桥场 recap 渲染：{system}"
        );
        assert!(
            !system.contains("锚行不该出现的回顾"),
            "更早的场（锚行）即使有 recap 也保持单行：{system}"
        );
        assert!(system.contains("场一摘要"), "锚行单行原样保留");
    }

    // ---- Task-05：相关回忆（卷宗）第五段 ----

    /// 卷宗注入：system 五段形态 persona → 虚时 → 编年史 → 相关回忆 → 状态，
    /// 段标题措辞与既有【往事编年史】/【当前状态】同系；卷宗正文原样进入段落。
    #[test]
    fn dossier_renders_between_chronicle_and_states() {
        let c = character("人设");
        let messages = assemble(&AssembleInputs {
            character: &c,
            scenes: &multi_scene_rows(),
            history: &multi_scene_history(),
            calendar: &DEFAULT_CALENDAR,
            states: &[state(CharacterStateScope::State, "情绪", "释然", None)],
            dossier: Some("场0：两人曾在钟楼下分食一块饼，并把信物埋在树下。"),
        });

        let system = &messages[0].content;
        let persona_at = system.find("人设").unwrap();
        let time_at = system.find("当前时间：").unwrap();
        let chronicle_at = system.find("【往事编年史】").unwrap();
        let memory_at = system.find("【相关回忆】").unwrap();
        let state_at = system.find("【当前状态】").unwrap();
        assert!(
            persona_at < time_at
                && time_at < chronicle_at
                && chronicle_at < memory_at
                && memory_at < state_at,
            "五段顺序单调递增：{system}"
        );
        assert!(
            system.contains("【相关回忆】\n场0：两人曾在钟楼下分食一块饼，并把信物埋在树下。"),
            "卷宗正文原样注入：{system}"
        );
    }

    /// 卷宗空态省略：None / 纯空白都不产生【相关回忆】段（system 退回四段形态，
    /// Task-02 及之前的既有测试全部走 None 路径，语义不变）。
    #[test]
    fn blank_or_missing_dossier_omits_section() {
        let c = character("人设");
        let states = vec![state(CharacterStateScope::State, "情绪", "释然", None)];
        for dossier in [None, Some("   \n\t  ")] {
            let messages = assemble(&AssembleInputs {
                character: &c,
                scenes: &multi_scene_rows(),
                history: &multi_scene_history(),
                calendar: &DEFAULT_CALENDAR,
                states: &states,
                dossier,
            });
            let system = &messages[0].content;
            assert!(!system.contains("【相关回忆】"), "无卷宗不产生空段：{system}");
            assert!(
                system.find("【往事编年史】").unwrap() < system.find("【当前状态】").unwrap(),
                "省略后四段形态不变：{system}"
            );
        }
    }
}
