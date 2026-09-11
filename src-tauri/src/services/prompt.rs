//! Prompt 装配（TASK-006 / FR-001 / FR-003 / ADR-004）：纯函数，可单测，不做 IO。
//!
//! ADR-004 场景对齐装配（§7.8 近景/远景，替换 ADR-002 条数滑窗）：
//! - system = 人设卡 persona（BR-001「在场完整人设」的 v1 单角色形态）+ 远景编年史：
//!   更早的每个场景恰好一行（场序 / 地点 / 时间原文 / 日历 label / 一句话摘要中
//!   可用的字段），拼在 persona 之后；persona 为空时 system 只含编年史；
//! - 近景 = 最近 N 个已结算场景的整场逐字消息 + 进行中场景全量（窗口数学见
//!   [`crate::domain::context`]），只取原始正文——reasoning 不进上下文：它是给
//!   用户看的思考，不是对话内容。
//!
//! 场景边界与结算归属同源：结算把「上一道场景线所在消息（不含）到触发行（含）」
//! 整段挂到上一场景行（ports::AttachRange），因此这里用同一判定
//! （[`super::director::contains_scene_line`]）按场景线消息切段，触发行归收束场，
//! 最后一道场景线之后 = 进行中场（scene_id 尚为 NULL）。已知偏差（接受并记录）：
//! - 结算欠账（§7-2，场景线已出现但结算未落）：切分仍按场景线进行，近景多带一场
//!   而不丢叙事；远景以场景行为准，无行的场不产生编年史行；
//! - 重新生成撞已结算边界（§7-3）：旧行不回滚，行数与场景线数可能短暂错位，
//!   至多影响单行编年史的归属，下次结算自愈。

use crate::domain::context::{self, SceneSpans};
use crate::domain::models::{Character, Message, MessageRole, Scene};
use crate::infra::llm::{ChatMessage, ChatRole};

/// 装配一次聊天的完整 messages：system(persona + 远景编年史) + 近景上下文。
/// persona 为空白时跳过 persona（角色卡允许空人设）；远景有行时 system 只含编年史，
/// 仍不产生空 system 回合。`scenes` 为空（场景特性之前的旧数据会话）时无远景，
/// 全部消息按字符预算兜底（ADR-004 优雅退化，不 panic）。
pub fn assemble(character: &Character, scenes: &[Scene], history: &[Message]) -> Vec<ChatMessage> {
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
    let chronicle = chronicle_block(scenes, near.kept_settled);
    let persona = character.persona.trim();
    if !persona.is_empty() || !chronicle.is_empty() {
        let mut system = String::new();
        if !persona.is_empty() {
            system.push_str(persona);
        }
        if !chronicle.is_empty() {
            if !system.is_empty() {
                system.push_str("\n\n");
            }
            system.push_str(&chronicle);
        }
        out.push(ChatMessage::new(ChatRole::System, system));
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
fn split_into_scene_spans(history: &[Message]) -> SceneSpans<'_> {
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

/// 远景编年史（§7.8「之前每场一行摘要」）：收录比近景更早的场景行，每场恰好一行。
/// 场景行数 = 进行中 header 行（结算只建行不挂消息，最后 1 行恒为进行中场）+
/// `kept_settled` 行（整场在近景）+ 远景行数。列缺失（锚行未回写 / 欠账）跳过该
/// 字段，不输出「（未记录）」占位——编年史要的是一行一个脚印，不是快照。
fn chronicle_block(scenes: &[Scene], kept_settled: usize) -> String {
    let far = &scenes[..scenes.len().saturating_sub(1 + kept_settled)];
    if far.is_empty() {
        return String::new();
    }
    let mut block = String::from("【往事编年史】更早的场景各压缩为一行（从旧到新）：");
    for scene in far {
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
    }
    block
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::NewCharacter;

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

    /// 场景行：idx 单调递增，各可空字段给全（锚行用 [`anchor_scene`] 造缺省形态）。
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
            present: vec![1],
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
        let messages = assemble(&c, &[], &history);

        assert_eq!(messages.len(), 3, "system + 2 条上下文");
        assert_eq!(messages[0].role, ChatRole::System);
        assert_eq!(messages[0].content, "雨夜电话亭的守夜人。");
        assert_eq!(messages[1].role, ChatRole::User);
        assert_eq!(messages[2].role, ChatRole::Assistant);
    }

    /// ADR-004 多场近景切分：最近 2 个已结算场**整场逐字** + 进行中场全量，顺序不变；
    /// 更早的场一（m1/m2）不进近景、由编年史行对冲；reasoning 不进上下文；
    /// 远景每场恰好一行。
    #[test]
    fn multi_scene_near_view_verbatim_and_chronicle_one_line_each() {
        let c = character("人设");
        let messages = assemble(&c, &multi_scene_rows(), &multi_scene_history());

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

        // system = persona + 编年史；远景 = 锚行 + 场二行（更近的场与进行中行不入），
        // 每场恰好一行（skip(3) 跳过 persona 行、空行与编年史标题行）。
        let system = &messages[0].content;
        assert!(
            system.starts_with("人设\n\n【往事编年史】"),
            "persona 之后拼编年史"
        );
        let lines: Vec<&str> = system.lines().skip(3).collect();
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
        let messages = assemble(&c, &[], &history);
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

        let messages = assemble(&c, &scenes, &history);
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
        let lines: Vec<&str> = system.lines().skip(3).collect();
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

        let messages = assemble(&c, &scenes, &history);
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
        let before = assemble(&c, &scenes, &full);
        assert_eq!(before.len(), 4);
        assert_eq!(before[2].content, "答1\n\n---\n\n新场");

        // 剔除被替换条（含 --- 的 assistant）后：无场景线 → 全部消息为进行中场，
        // 恰好少掉被替换的那一条，其余原样保留。
        let filtered = vec![
            message(1, MessageRole::User, "问1"),
            message(3, MessageRole::User, "问2"),
        ];
        let messages = assemble(&c, &scenes, &filtered);
        assert_eq!(messages.len(), 3, "system + 2 条（无幻影边界拆分）");
        assert_eq!(messages[1].content, "问1");
        assert_eq!(messages[2].role, ChatRole::User);
        assert_eq!(messages[2].content, "问2");
    }

    /// 空 persona + 有远景：system 只含编年史（不产生空消息、不带 persona 空白）。
    #[test]
    fn blank_persona_with_far_makes_system_chronicle_only() {
        let c = character("   ");
        let messages = assemble(&c, &multi_scene_rows(), &multi_scene_history());

        assert_eq!(messages[0].role, ChatRole::System);
        assert!(
            messages[0].content.starts_with("【往事编年史】"),
            "system 只含编年史，无 persona 残留：{}",
            messages[0].content
        );
        assert!(messages[0].content.contains("场一摘要"));
        assert_eq!(messages.len(), 7, "近景不受 persona 空白影响");
    }

    /// 空 persona 且无远景：不产生 system 回合（沿用 v1 不变量）。
    #[test]
    fn skips_blank_persona_without_scenes() {
        let c = character("  ");
        let history = vec![message(1, MessageRole::User, "你好")];
        let messages = assemble(&c, &[], &history);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, ChatRole::User);
    }
}
