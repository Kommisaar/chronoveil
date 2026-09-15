//! 本体（super）的单测：自 services/prompt.rs 尾部的 `mod tests` 外置（500 行规范；测试代码逐字搬移，断言零改动）。

use super::*;

/// 默认历（无命名皮肤）单例：既有用例的「无日历注入」对照基线。
static DEFAULT_CALENDAR: std::sync::LazyLock<CalendarConfig> =
    std::sync::LazyLock::new(CalendarConfig::default);

/// Task-01 三参形态的等价包装（默认历 + 无状态）：供迁移用例与「无注入」对照。
fn assemble_base(
    instances: &[CharacterInstance],
    scenes: &[Scene],
    history: &[Message],
) -> Vec<ChatMessage> {
    assemble(&AssembleInputs {
        instances,
        scenes,
        history,
        calendar: &DEFAULT_CALENDAR,
        states: &[],
        dossier: None,
        near_scenes: context::SETTLED_SCENES_IN_NEAR,
        system_prompt: "",
        world: None,
    })
}

/// LLM 位实例夹具（id 由调用方指定；roster 序 = 传入序）。
fn llm_instance(id: i64, name: &str, persona: &str) -> CharacterInstance {
    CharacterInstance {
        id,
        session_id: 1,
        character_id: Some(100 + id),
        name: name.into(),
        persona: persona.into(),
        render_style: "type".into(),
        is_user: false,
        created_at: 0,
        deleted_at: None,
    }
}

/// 用户位实例夹具（D2：全会话恰一；人设默认空白以保持既有用例的
/// 「persona 之外零注入」断言基线，用户位段语义另测）。
fn user_instance(id: i64, name: &str, persona: &str) -> CharacterInstance {
    CharacterInstance {
        id,
        session_id: 1,
        character_id: Some(100 + id),
        name: name.into(),
        persona: persona.into(),
        render_style: "type".into(),
        is_user: true,
        created_at: 0,
        deleted_at: None,
    }
}

/// 单 LLM 位等价基线阵容：苏鸢（LLM 位）+ 旅人（用户位，人设空白）。
fn solo_roster(persona: &str) -> Vec<CharacterInstance> {
    vec![llm_instance(1, "苏鸢", persona), user_instance(2, "旅人", "")]
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
        scene_id: None,
        instance_id: None,
        deleted_at: None,
    }
}

/// 盖章消息：给 [`message`] 的形态补上库内归属（结算 AttachRange 回填后的读路径形态）。
fn stamped(mut message: Message, scene_id: i64) -> Message {
    message.scene_id = Some(scene_id);
    message
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

/// 人物状态行（FR-012）：expiry 可选（快照渲染不消费，用于断言「不渲染」）；
/// 迁移 0009 起状态挂实例（instance_id = 夹具中的 LLM 位实例 1）。
fn state(scope: CharacterStateScope, key: &str, value: &str, expiry: Option<&str>) -> CharacterState {
    CharacterState {
        id: 1,
        instance_id: 1,
        scope,
        key: key.into(),
        value: value.into(),
        expiry: expiry.map(str::to_string),
        source_scene: None,
        updated_at: 0,
        deleted_at: None,
        superseded_at: None,
    }
}

/// 标准多场历史（结算后盖章形态）：4 个已收束场（scene_id 挂对应场景行，
/// 行 id = multi_scene_rows 的 id：锚行 1、场二 2、场三 3、场四 4；触发行带 ---）
/// + 进行中场；reasoning 挂在进行中场上验证排除。
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
        // 结算归属：m1-2 挂锚行(1)、m3-4 挂场二行(2)、m5-6 挂场三行(3)、
        // m7-8 挂场四行(4)；m9 起进行中场（NULL）。
        m.scene_id = match m.id {
            1 | 2 => Some(1),
            3 | 4 => Some(2),
            5 | 6 => Some(3),
            7 | 8 => Some(4),
            _ => None,
        };
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

// ---- 全局系统提示词（2026-09-15，config.json `system_prompt`）----

/// 有值：原文注入为 system 首段（先于人设段），段间空行分隔；近景不受影响。
#[test]
fn system_prompt_leads_system_message() {
    let roster = solo_roster("雨夜电话亭的守夜人。");
    let history = vec![message(1, MessageRole::User, "在吗？")];
    let messages = assemble(&AssembleInputs {
        instances: &roster,
        scenes: &[],
        history: &history,
        calendar: &DEFAULT_CALENDAR,
        states: &[],
        dossier: None,
        near_scenes: context::SETTLED_SCENES_IN_NEAR,
        system_prompt: "用中文写短句，保持冷峻克制的文风。",
        world: None,
    });
    let system = &messages[0].content;
    assert!(
        system.starts_with("用中文写短句，保持冷峻克制的文风。\n\n雨夜电话亭的守夜人。"),
        "全局指令为 system 首段，人设段紧随其后：{system}"
    );
    assert_eq!(messages.len(), 2, "近景条数不受全局指令影响");
}

/// 空白（含纯空白字符）：整段省略，system 回到人设段打头的既有形态（零注入
/// 语义与 persona 空白一致）。
#[test]
fn blank_system_prompt_omitted() {
    let roster = solo_roster("雨夜电话亭的守夜人。");
    let history = vec![message(1, MessageRole::User, "在吗？")];
    for blank in ["", "   ", "\n\t"] {
        let messages = assemble(&AssembleInputs {
            instances: &roster,
            scenes: &[],
            history: &history,
            calendar: &DEFAULT_CALENDAR,
            states: &[],
            dossier: None,
            near_scenes: context::SETTLED_SCENES_IN_NEAR,
            system_prompt: blank,
            world: None,
        });
        let system = &messages[0].content;
        assert!(
            system.starts_with("雨夜电话亭的守夜人。"),
            "空白（{blank:?}）省略全局指令段，人设段打头：{system}"
        );
    }
}

/// 世界段（2026-09-15 世界卡定稿）：有值时注入为第 2 段——全局系统提示词
/// 之后、人设段之前（先立舞台再上演员）；None / 空白整段省略。
#[test]
fn world_section_between_global_prompt_and_persona() {
    let roster = solo_roster("雨夜电话亭的守夜人。");
    let history = vec![message(1, MessageRole::User, "在吗？")];
    let base = AssembleInputs {
        instances: &roster,
        scenes: &[],
        history: &history,
        calendar: &DEFAULT_CALENDAR,
        states: &[],
        dossier: None,
        near_scenes: context::SETTLED_SCENES_IN_NEAR,
        system_prompt: "用中文写短句。",
        world: Some("永夜的港都，灯是唯一的历法。"),
    };
    let messages = assemble(&base);
    let system = &messages[0].content;
    assert!(
        system.starts_with(
            "用中文写短句。\n\n永夜的港都，灯是唯一的历法。\n\n雨夜电话亭的守夜人。"
        ),
        "全局指令 → 世界段 → 人设段，段间空行分隔：{system}"
    );
    // None / 纯空白：整段省略，回到「全局指令 → 人设」的六段形态。
    for absent in [None, Some(""), Some("   ")] {
        let messages = assemble(&AssembleInputs { world: absent, ..base });
        let system = &messages[0].content;
        assert!(
            system.starts_with("用中文写短句。\n\n雨夜电话亭的守夜人。"),
            "世界（{absent:?}）省略段：{system}"
        );
    }
}

/// FR-001 / UC-001 / ADR-004：system(persona) + 近景上下文（无场景时全量）。
#[test]
fn assembles_persona_and_history_without_scenes() {
    let roster = solo_roster("雨夜电话亭的守夜人。");
    let history = vec![
        message(1, MessageRole::User, "在吗？"),
        message(2, MessageRole::Assistant, "在。"),
    ];
    let messages = assemble_base(&roster, &[], &history);

    assert_eq!(messages.len(), 3, "system + 2 条上下文");
    assert_eq!(messages[0].role, ChatRole::System);
    // 语义变化（多角色 D2）：用户位段为新注入——「对手设定」恒报名字。
    assert_eq!(
        messages[0].content,
        "雨夜电话亭的守夜人。\n\n用户扮演的角色：旅人",
        "persona + 用户位段，实际：{}",
        messages[0].content
    );
    assert_eq!(messages[1].role, ChatRole::User);
    assert_eq!(messages[2].role, ChatRole::Assistant);
}

/// ADR-004 多场近景切分：最近 2 个已结算场**整场逐字** + 进行中场全量，顺序不变；
/// 更早的场一（m1/m2）不进近景、由编年史行对冲；reasoning 不进上下文；
/// 远景每场恰好一行；虚时行取最新场景行（进行中场）的记账位（默认历无注入时
/// 亦由缓存渲染，Task-02 后 system 含「当前时间」）。
#[test]
fn multi_scene_near_view_verbatim_and_chronicle_one_line_each() {
    let roster = solo_roster("人设");
    let messages = assemble_base(&roster, &multi_scene_rows(), &multi_scene_history());

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
    // 行不入），每场恰好一行（skip(7) 跳过 persona、用户位段、虚时与三处段间
    // 空行、编年史标题行）。
    let system = &messages[0].content;
    assert!(
        system.starts_with(
            "人设\n\n用户扮演的角色：旅人\n\n当前时间：第4日·清晨\n\n【往事编年史】"
        ),
        "persona → 用户位段 → 虚时行（最新场景行 date_label 缓存）→ 编年史，实际：{system}"
    );
    let lines: Vec<&str> = system.lines().skip(7).collect();
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

/// 近景窗口可选化（装配层穿参）：同一场历史下 near_scenes=3 把默认窗口外的
/// 场二拉回近景（编年史随之少一行）；near_scenes=1 把场三挤出近景（落编年史）。
/// 默认 2 的行为由 [`multi_scene_near_view_verbatim_and_chronicle_one_line_each`]
/// 锁定，本用例只验证参数确实改变窗口。
#[test]
fn assemble_near_scenes_parameter_changes_window() {
    let roster = solo_roster("人设");
    let make = |near_scenes: usize| {
        let messages = assemble(&AssembleInputs {
            instances: &roster,
            scenes: &multi_scene_rows(),
            history: &multi_scene_history(),
            calendar: &DEFAULT_CALENDAR,
            states: &[],
            dossier: None,
            near_scenes,
            system_prompt: "",
            world: None,
        });
        let chat: Vec<String> =
            messages[1..].iter().map(|m| m.content.clone()).collect();
        let system = &messages[0].content;
        let chronicle_rows = system.lines().filter(|l| l.starts_with("场")).count();
        (chat, chronicle_rows)
    };

    // 3 场（取最新 3 个）：场二（默认窗口外）回近景 → 近景 8 条；远景只剩锚行。
    let (chat, rows) = make(3);
    assert_eq!(chat.len(), 8, "三场各 2 条 + 进行中 2 条");
    assert!(chat[0] == "场二问", "场二整场回近景：{chat:?}");
    assert_eq!(rows, 1, "远景只剩锚行一行");

    // 1 场：只带场四 + 进行中 → 近景 4 条；场三挤出到编年史（3 行）。
    let (chat, rows) = make(1);
    assert_eq!(chat.len(), 4, "场四 2 条 + 进行中 2 条：{chat:?}");
    assert!(chat[0] == "场四问", "最新已结算场整场保留：{chat:?}");
    assert_eq!(rows, 3, "场一/场二/场三各一行（含锚行）");
}

/// 无场景会话（旧数据/场景特性之前）：远景为空，全部消息按字符预算兜底；
/// 超预算丢最旧，顺序不变、不 panic。
#[test]
fn no_scenes_degrades_to_char_budget_window() {
    let roster = solo_roster("人设");
    let history: Vec<Message> = (0..30)
        .map(|i| message(i, MessageRole::User, &format!("行{i}{}", "字".repeat(996))))
        .collect();
    let messages = assemble_base(&roster, &[], &history);
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
    assert_eq!(
        messages[0].content,
        "人设\n\n用户扮演的角色：旅人",
        "远景为空，system 只含 persona 与用户位段"
    );
}

/// 字符预算触发整场淘汰：最旧的入选场**整场**出局，其场景行自动落入远景编年史
/// （远景行数随淘汰增长），入选场仍整场保留。
#[test]
fn char_budget_evicts_whole_scene_into_chronicle() {
    let roster = solo_roster("人设");
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
    // 触发场景线 + 结算盖章：行 id = 1（锚行）/ 2 / 3（scene idx 0/1/2），
    // m1-2 挂锚行、m3-4 挂场 B 行、m5-6 挂场 C 行，m7 进行中（NULL）。
    let mut history = history;
    for (index, scene_id) in [(0usize, 1i64), (2, 2), (4, 3)] {
        history[index].scene_id = Some(scene_id);
        history[index + 1].scene_id = Some(scene_id);
    }
    for id in [2, 4, 6] {
        history[id as usize - 1].content.push_str("\n\n---\n\n新场");
    }
    let scenes = vec![
        anchor_scene("场A摘要"),
        scene(1, "场B摘要"),
        scene(2, "场C摘要"),
        scene(3, "（进行中）"),
    ];

    let messages = assemble_base(&roster, &scenes, &history);
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
    let lines: Vec<&str> = system.lines().skip(7).collect();
    assert_eq!(lines.len(), 2, "远景行数随整场淘汰增长（1 → 2）");
}

/// 超长进行中场：头截断（丢最旧消息），已结算场全数让位并落入编年史。
#[test]
fn oversized_ongoing_scene_head_truncates() {
    let roster = solo_roster("人设");
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

    let messages = assemble_base(&roster, &scenes, &history);
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
    let roster = solo_roster("人设");
    let scenes = vec![anchor_scene("")];
    let full = vec![
        message(1, MessageRole::User, "问1"),
        message(2, MessageRole::Assistant, "答1\n\n---\n\n新场"),
        message(3, MessageRole::User, "问2"),
    ];

    // 对照：剔除前 = 已结算场（问1 + 答1）+ 进行中场（问2）。
    let before = assemble_base(&roster, &scenes, &full);
    assert_eq!(before.len(), 4);
    assert_eq!(before[2].content, "答1\n\n---\n\n新场");

    // 剔除被替换条（含 --- 的 assistant）后：无场景线 → 全部消息为进行中场，
    // 恰好少掉被替换的那一条，其余原样保留。
    let filtered = vec![
        message(1, MessageRole::User, "问1"),
        message(3, MessageRole::User, "问2"),
    ];
    let messages = assemble_base(&roster, &scenes, &filtered);
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
    let roster = solo_roster("   ");
    let states = vec![
        state(CharacterStateScope::State, "情绪", "释然", Some("scene_end")),
        state(CharacterStateScope::Relation, "对旅人", "警惕", None),
    ];
    let calendar = CalendarConfig::default();
    let messages = assemble(&AssembleInputs {
        instances: &roster,
        scenes: &multi_scene_rows(),
        history: &multi_scene_history(),
        calendar: &calendar,
        states: &states,
        dossier: None,
        near_scenes: context::SETTLED_SCENES_IN_NEAR,
        system_prompt: "",
        world: None,
    });

    assert_eq!(messages[0].role, ChatRole::System);
    let system = &messages[0].content;
    assert!(
        system.starts_with("用户扮演的角色：旅人\n\n当前时间：第4日·清晨\n\n【往事编年史】"),
        "persona 空白不残留，用户位段 → 虚时行：{system}"
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
/// 语义变化（多角色 D2）：阵容含用户位时「对手设定」段恒报名字，system 不再可能
/// 为空——全空形态只存在于纯函数的无用户位防御分支（存储层已保证恰一用户位）。
#[test]
fn skips_blank_persona_without_scenes() {
    let history = vec![message(1, MessageRole::User, "你好")];
    // 防御分支：无用户位阵容 + LLM 位空白 → 无 system。
    let bare = vec![llm_instance(1, "苏鸢", "  ")];
    let messages = assemble_base(&bare, &[], &history);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, ChatRole::User);

    // 常规阵容：LLM 位空白，system 只含用户位段（名字兜底）。
    let roster = solo_roster("  ");
    let messages = assemble_base(&roster, &[], &history);
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].content, "用户扮演的角色：旅人");
}

// ---- Task-02：当前虚时行（三态）----

/// 虚时行第一态：最新场景行带 date_label 缓存 → 直接用缓存渲染，即使会话日历
/// 与缓存来源不同（缓存与 fic_day 同源派生，复用零重算）。
#[test]
fn time_line_prefers_cached_date_label() {
    let roster = solo_roster("人设");
    let mut rows = multi_scene_rows();
    let last = rows.last_mut().unwrap();
    last.date_label = Some("白蜡月·晨露日·夜（灯节）".into());
    // 会话日历故意为空皮肤：若走现算会得到「第4日·清晨」，断言必须命中缓存。
    let calendar = CalendarConfig::default();
    let messages = assemble(&AssembleInputs {
        instances: &roster,
        scenes: &rows,
        history: &multi_scene_history(),
        calendar: &calendar,
        states: &[],
        dossier: None,
        near_scenes: context::SETTLED_SCENES_IN_NEAR,
        system_prompt: "",
        world: None,
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
    let roster = solo_roster("人设");
    let history = vec![message(1, MessageRole::User, "在吗？")];
    // 锚行（FR-014）：fic_day=1 / fic_part=夜 / date_label=None → 现算路径。
    let scenes = vec![anchor_scene("")];
    let calendar = crate::domain::fiction_time::presets::fantasy();

    let messages = assemble(&AssembleInputs {
        instances: &roster,
        scenes: &scenes,
        history: &history,
        calendar: &calendar,
        states: &[],
        dossier: None,
        near_scenes: context::SETTLED_SCENES_IN_NEAR,
        system_prompt: "",
        world: None,
    });
    assert_eq!(
        messages[0].content,
        "人设\n\n用户扮演的角色：旅人\n\n当前时间：霜月·晨露日·夜",
        "缓存缺失时按会话快照日历现算命名形式：{}",
        messages[0].content
    );
}

/// 虚时行第二态的无皮肤分支：缓存缺失 + 默认历（无命名皮肤）→ 回退数字形式
/// 「第N日·时段」（date_label 自带回退，与缓存路径形态归一）。
#[test]
fn time_line_falls_back_to_numeric_without_skin_or_cache() {
    let roster = solo_roster("人设");
    let history = vec![message(1, MessageRole::User, "在吗？")];
    let scenes = vec![anchor_scene("")];

    let messages = assemble(&AssembleInputs {
        instances: &roster,
        scenes: &scenes,
        history: &history,
        calendar: &DEFAULT_CALENDAR,
        states: &[],
        dossier: None,
        near_scenes: context::SETTLED_SCENES_IN_NEAR,
        system_prompt: "",
        world: None,
    });
    assert_eq!(
        messages[0].content,
        "人设\n\n用户扮演的角色：旅人\n\n当前时间：第1日·夜",
        "无皮肤回退「第N日·时段」：{}",
        messages[0].content
    );
}

/// 虚时行第三态：无最新场景（旧数据会话）或最新场景无记账位（fic_day 空）→
/// 整行省略，不猜测时间。
#[test]
fn time_line_omitted_without_scene_or_ledger() {
    let roster = solo_roster("人设");
    let history = vec![message(1, MessageRole::User, "在吗？")];
    let calendar = crate::domain::fiction_time::presets::fantasy();

    // 无场景（场景特性之前的旧数据会话）：无虚时行。
    let messages = assemble(&AssembleInputs {
        instances: &roster,
        scenes: &[],
        history: &history,
        calendar: &calendar,
        states: &[],
        dossier: None,
        near_scenes: context::SETTLED_SCENES_IN_NEAR,
        system_prompt: "",
        world: None,
    });
    assert_eq!(
        messages[0].content, "人设\n\n用户扮演的角色：旅人",
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
        instances: &roster,
        scenes: &rows,
        history: &multi_scene_history(),
        calendar: &calendar,
        states: &[],
        dossier: None,
        near_scenes: context::SETTLED_SCENES_IN_NEAR,
        system_prompt: "",
        world: None,
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
    let roster = solo_roster("人设");
    let history = vec![message(1, MessageRole::User, "在吗？")];
    let calendar = CalendarConfig::default();

    // 只有 relation：只渲染【关系】，不出现空【当前状态】标题。
    let states = vec![
        state(CharacterStateScope::Relation, "对旅人", "好奇", None),
        state(CharacterStateScope::Relation, "与守夜人的约定", "保守秘密", Some("event:告别")),
    ];
    let messages = assemble(&AssembleInputs {
        instances: &roster,
        scenes: &[],
        history: &history,
        calendar: &calendar,
        states: &states,
        dossier: None,
        near_scenes: context::SETTLED_SCENES_IN_NEAR,
        system_prompt: "",
        world: None,
    });
    assert_eq!(
        messages[0].content,
        "人设\n\n用户扮演的角色：旅人\n\n【关系】\n- 对旅人：好奇\n- 与守夜人的约定：保守秘密",
        "空 state 组省略标题，组内保持库序，expiry 不渲染：{}",
        messages[0].content
    );

    // 全空：整段省略（system = persona + 用户位段）。
    let messages = assemble(&AssembleInputs {
        instances: &roster,
        scenes: &[],
        history: &history,
        calendar: &calendar,
        states: &[],
        dossier: None,
        near_scenes: context::SETTLED_SCENES_IN_NEAR,
        system_prompt: "",
        world: None,
    });
    assert_eq!(
        messages[0].content,
        "人设\n\n用户扮演的角色：旅人",
        "状态全空整段省略"
    );
}

// ---- Task-03：桥场加厚（远景两档渲染） ----

/// 桥场（窗口外最近的一场 = 编年史末行）有 recap → 追加一行缩进回顾，
/// 树形前缀「└」与 header 行区分；header 行自身形态不变（summary 仍在行末）。
#[test]
fn bridge_scene_renders_recap_as_indented_review_line() {
    let roster = solo_roster("人设");
    let mut rows = multi_scene_rows();
    // 远景 = 锚行 + 场二行（idx1）；桥场 = 场二行。
    rows[1].recap = Some("巷口初遇时她提灯替我照了一段路。后来我们在钟楼下分食了一块饼。分别时她说明天见。".into());

    let messages = assemble_base(&roster, &rows, &multi_scene_history());
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
    let roster = solo_roster("人设");
    // multi_scene_rows 全部 recap = None：远景 = 锚行 + 场二行，每场恰好一行。
    let messages = assemble_base(&roster, &multi_scene_rows(), &multi_scene_history());
    let system = &messages[0].content;
    assert!(!system.contains("└ 回顾"), "无 recap 不输出回顾行：{system}");
    let lines: Vec<&str> = system.lines().skip(7).collect();
    assert_eq!(lines.len(), 2, "远景每场恰好一行（回退 Task-01 形态）");
    // 空白 recap 同为 None 路径：trim 后空 → 不渲染。
    let mut rows = multi_scene_rows();
    rows[1].recap = Some("   ".into());
    let messages = assemble_base(&roster, &rows, &multi_scene_history());
    assert!(!messages[0].content.contains("└ 回顾"), "空白 recap 视为无：跳过");
}

/// 更早的场（桥场之前的远景行）即使有 recap 也保持单行——加厚只给桥场。
#[test]
fn older_scenes_stay_single_line_even_with_recap() {
    let roster = solo_roster("人设");
    let mut rows = multi_scene_rows();
    // 更早的锚行也塞了 recap：只有桥场（场二行 idx1）的 recap 被渲染。
    rows[0].recap = Some("锚行不该出现的回顾。".into());
    rows[1].recap = Some("桥场回顾：一句。两句。三句。".into());

    let messages = assemble_base(&roster, &rows, &multi_scene_history());
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
    let roster = solo_roster("人设");
    let messages = assemble(&AssembleInputs {
        instances: &roster,
        scenes: &multi_scene_rows(),
        history: &multi_scene_history(),
        calendar: &DEFAULT_CALENDAR,
        states: &[state(CharacterStateScope::State, "情绪", "释然", None)],
        dossier: Some("场0：两人曾在钟楼下分食一块饼，并把信物埋在树下。"),
        near_scenes: context::SETTLED_SCENES_IN_NEAR,
        system_prompt: "",
        world: None,
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
    let roster = solo_roster("人设");
    let states = vec![state(CharacterStateScope::State, "情绪", "释然", None)];
    for dossier in [None, Some("   \n\t  ")] {
        let messages = assemble(&AssembleInputs {
            instances: &roster,
            scenes: &multi_scene_rows(),
            history: &multi_scene_history(),
            calendar: &DEFAULT_CALENDAR,
            states: &states,
            dossier,
            near_scenes: context::SETTLED_SCENES_IN_NEAR,
            system_prompt: "",
            world: None,
        });
        let system = &messages[0].content;
        assert!(!system.contains("【相关回忆】"), "无卷宗不产生空段：{system}");
        assert!(
            system.find("【往事编年史】").unwrap() < system.find("【当前状态】").unwrap(),
            "省略后四段形态不变：{system}"
        );
    }
}

// ---- Task-08：scene_id 锚定切分 + 编年史 id 精确对应 ----

/// 盖章分组（库内归属优先）：同 scene_id 连续消息一次成段，段序 = 首现顺序
/// （与场景 idx 同序）；盖章段内容不再参与切界——段首消息纵含场景线也不拆段；
/// NULL 尾无场景线 → 进行中场。
#[test]
fn split_groups_stamped_messages_by_scene_id() {
    let history = vec![
        stamped(message(1, MessageRole::User, "场一问"), 1),
        // 盖章段内首条带场景线：内容判定会让位给库内归属，不拆段
        stamped(message(2, MessageRole::Assistant, "---\n\n场二开场"), 1),
        stamped(message(3, MessageRole::User, "场二问"), 2),
        stamped(message(4, MessageRole::Assistant, "场二答"), 2),
        message(5, MessageRole::User, "进行中问"),
    ];

    let spans = split_into_scene_spans(&history);

    assert_eq!(spans.closed.len(), 2, "两个盖章段");
    assert_eq!(spans.closed[0].messages.len(), 2, "场一段 = m1+m2（场景线不拆段）");
    assert_eq!(spans.closed[0].scene_id, Some(1), "首段锚定行 1");
    assert_eq!(spans.closed[1].messages.len(), 2, "场二段 = m3+m4");
    assert_eq!(spans.closed[1].scene_id, Some(2), "次段锚定行 2（首现顺序）");
    assert_eq!(spans.ongoing.len(), 1, "NULL 尾 = 进行中场");
    assert_eq!(spans.ongoing[0].id, 5);
}

/// NULL 尾内容兜底（欠账语义不变）：全 NULL 历史按场景线切段、锚全 None，
/// 最后一道线之后 = 进行中场——与旧版内容切分逐字同界。
#[test]
fn split_null_history_falls_back_to_scene_lines() {
    let history = vec![
        message(1, MessageRole::User, "场一问"),
        message(2, MessageRole::Assistant, "场一答\n\n---\n\n场二开场"),
        message(3, MessageRole::User, "场二问"),
        message(4, MessageRole::Assistant, "场二答\n\n---\n\n场三开场"),
        message(5, MessageRole::User, "进行中问"),
    ];

    let spans = split_into_scene_spans(&history);

    assert_eq!(spans.closed.len(), 2, "按场景线切两段（旧版行为原样兜底）");
    assert!(spans.closed.iter().all(|span| span.scene_id.is_none()), "锚全 None（欠账段）");
    assert_eq!(spans.closed[0].messages.len(), 2, "触发行归收束场（含 --- 原文）");
    assert_eq!(spans.closed[1].messages.len(), 2);
    assert_eq!(spans.ongoing.len(), 1);
}

/// 混合形态：盖章段 + 中部欠账段（NULL、以场景线收尾）+ 盖章段 + 尾部欠账切分
/// ——欠账段夹在盖章段之间且锚为 None；防御性分支（中部 NULL 余段未以场景线
/// 收尾，按归属不变量不可达）收编为无锚段，消息不丢。
#[test]
fn split_mixed_stamped_debt_and_defensive_remainder() {
    let history = vec![
        stamped(message(1, MessageRole::User, "场一问"), 1),
        stamped(message(2, MessageRole::Assistant, "场一答\n\n---\n\n场二开场"), 1),
        // 欠账：场景线已出现但结算未落（NULL，以场景线收尾）
        message(3, MessageRole::User, "欠账问"),
        message(4, MessageRole::Assistant, "欠账答\n\n---\n\n新场"),
        stamped(message(5, MessageRole::User, "真场问"), 2),
        stamped(message(6, MessageRole::Assistant, "真场答"), 2),
        // 尾部欠账切分 + 进行中场
        message(7, MessageRole::User, "尾欠账"),
        message(8, MessageRole::Assistant, "尾欠账答\n\n---\n\n再新场"),
        message(9, MessageRole::User, "进行中问"),
    ];

    let spans = split_into_scene_spans(&history);

    let shape: Vec<(usize, Option<i64>)> = spans
        .closed
        .iter()
        .map(|span| (span.messages.len(), span.scene_id))
        .collect();
    assert_eq!(
        shape,
        vec![(2, Some(1)), (2, None), (2, Some(2)), (2, None)],
        "盖章段 / 中部欠账段 / 盖章段 / 尾部欠账段，顺序与首现一致"
    );
    assert_eq!(spans.ongoing.len(), 1, "最后一道场景线之后 = 进行中场");
    assert_eq!(spans.ongoing[0].id, 9);

    // 防御性分支：NULL 余段未以场景线收尾即被下一盖章段接续（生产不可达，
    // 人为构造验证不丢消息、不并入盖章段）。
    let odd = vec![
        message(1, MessageRole::User, "无场景线余段"),
        stamped(message(2, MessageRole::Assistant, "盖章条"), 7),
        message(3, MessageRole::User, "进行中"),
    ];
    let spans = split_into_scene_spans(&odd);
    let shape: Vec<(usize, Option<i64>)> = spans
        .closed
        .iter()
        .map(|span| (span.messages.len(), span.scene_id))
        .collect();
    assert_eq!(shape, vec![(1, None), (1, Some(7))], "余段收编为无锚段，盖章段原样");
    assert_eq!(spans.ongoing.len(), 1);
}

/// 编年史 id 精确对应（欠账段不占行 + 淘汰段落入远景）：欠账段进近景但不
/// 隐藏任何行，被淘汰盖章段的行落远景。旧版位置推断在此形态下会把「近景
/// 保留 2 段」当作覆盖前 2 行 → 远景为空，锚行信息丢失；id 对应下锚行照常出行。
#[test]
fn chronicle_maps_rows_by_kept_anchors_with_debt() {
    let roster = solo_roster("人设");
    let scenes = vec![
        anchor_scene("场零摘要"),
        scene(1, "场二摘要"),
        scene(2, "（进行中）"), // 末行 = 进行中 header
    ];
    let history = vec![
        stamped(message(1, MessageRole::User, "场零问"), 1),
        stamped(message(2, MessageRole::Assistant, "场零答\n\n---\n\n新场"), 1),
        // 欠账段（NULL、场景线在 m4）：进近景、不占任何行
        message(3, MessageRole::User, "欠账问"),
        message(4, MessageRole::Assistant, "欠账答\n\n---\n\n再新场"),
        stamped(message(5, MessageRole::User, "场二问"), 2),
        stamped(message(6, MessageRole::Assistant, "场二答"), 2),
        message(7, MessageRole::User, "进行中问"),
    ];

    let messages = assemble_base(&roster, &scenes, &history);

    // 近景 = 欠账段 + 场二段 + 进行中（窗口 2 取最新两段；场零段被默认窗口淘汰）。
    assert_eq!(messages.len(), 6, "system + 近景 5 条");
    assert!(
        messages[1..].iter().any(|m| m.content.contains("欠账问")),
        "欠账段留在近景（多带一场不丢叙事）"
    );
    // 远景 = 场景行 −（锚定行 2 ∪ 末行 3）= 仅锚行：欠账段不占行、被淘汰的
    // 场零段落远景出行。
    let system = &messages[0].content;
    assert!(system.contains("场零摘要"), "被淘汰盖章段的行落远景：{system}");
    assert!(!system.contains("场二摘要"), "仍在近景的段不重复出行：{system}");
    let rows = system.lines().filter(|l| l.starts_with("场")).count();
    assert_eq!(rows, 1, "远景恰好一行（欠账段不占行）：{system}");
}

/// 空段仍出行（重新生成撞已结算边界的新语义）：行还在但消息没了（段的唯一
/// 消息被重生成软删），编年史行照常输出；近景中的段不重复出行。旧版位置
/// 推断在此形态会把已在近景的锚行挤进远景、漏掉空段行。
#[test]
fn chronicle_emits_line_for_empty_regenerated_scene() {
    let roster = solo_roster("人设");
    let scenes = vec![
        anchor_scene("场零摘要"),
        scene(1, "被清空的场"),
        scene(2, "（进行中）"),
    ];
    // 场二行（id 2）的消息已被重生成清空 → 空段；在场消息只有锚行段 + 进行中。
    let history = vec![
        stamped(message(1, MessageRole::User, "场零问"), 1),
        stamped(message(2, MessageRole::Assistant, "场零答\n\n---\n\n新场"), 1),
        message(3, MessageRole::User, "进行中问"),
    ];

    let messages = assemble_base(&roster, &scenes, &history);

    let system = &messages[0].content;
    assert!(system.contains("被清空的场"), "空段（行在消息无）仍出编年史行：{system}");
    assert!(!system.contains("场零摘要"), "近景中的段不进编年史：{system}");
    let rows = system.lines().filter(|l| l.starts_with("场")).count();
    assert_eq!(rows, 1, "远景恰好一行：{system}");
}

/// 欠账段滑出近景即丢（仍接受的残余）：预算淘汰欠账段后无行可接——既不在
/// 近景（丢叙事有预算理由）也无编年史行对冲（无场景行，模块注释已记）。
#[test]
fn evicted_debt_span_leaves_no_chronicle_row() {
    let roster = solo_roster("人设");
    let scenes = vec![
        anchor_scene("场零摘要"),
        scene(1, "场二摘要"),
        scene(2, "（进行中）"),
    ];
    let history = vec![
        stamped(message(1, MessageRole::User, "场零问"), 1),
        stamped(message(2, MessageRole::Assistant, "场零答\n\n---\n\n新场"), 1),
        // 超大欠账段（约 26k 字）：入选即超预算 → 整段淘汰
        message(3, MessageRole::User, &format!("欠账{}", "巨".repeat(13_000))),
        message(4, MessageRole::Assistant, &format!("{}\n\n---\n\n新场", "巨".repeat(13_000))),
        stamped(message(5, MessageRole::User, "场二问"), 2),
        stamped(message(6, MessageRole::Assistant, "场二答"), 2),
        message(7, MessageRole::User, "进行中问"),
    ];

    let messages = assemble_base(&roster, &scenes, &history);

    // 近景 = 场二段 + 进行中（欠账段整场出局，无「巨」残留）。
    let near: Vec<&str> = messages[1..].iter().map(|m| m.content.as_str()).collect();
    assert_eq!(near.len(), 3, "近景 = 场二段（2 条）+ 进行中（1 条）");
    assert!(near.iter().all(|s| !s.contains('巨')), "超大欠账段整场淘汰");
    // 远景 = 仅锚行：欠账段淘汰后无行可接，不产生编年史行。
    let system = &messages[0].content;
    assert!(system.contains("场零摘要"), "锚行照常出行：{system}");
    assert!(!system.contains("场二摘要"), "近景段不进编年史：{system}");
    let rows = system.lines().filter(|l| l.starts_with("场")).count();
    assert_eq!(rows, 1, "欠账段滑出近景即丢，无行可接：{system}");
}

// ---- 多角色群像：多实例装配（方案 §3 第 1 步，D1/D2/D3）----

/// 多 LLM 位 + 用户位带人设的完整 system 形态：LLM 位逐个分节（【角色名】+
/// persona）→ 群像语境声明（v1.5 简化的诚实标注：单次生成、roster 序登场）→
/// 用户位「对话对手设定」段（「用户扮演的角色：{name}——{persona}」）。
#[test]
fn multi_llm_roster_sections_with_user_position() {
    let roster = vec![
        llm_instance(1, "苏鸢", "守夜人，沉默寡言。"),
        llm_instance(2, "阿烬", "灯匠学徒，性子急。"),
        user_instance(3, "旅人", "老练的旅人"),
    ];
    let history = vec![message(1, MessageRole::User, "在吗？")];
    let messages = assemble_base(&roster, &[], &history);
    let system = &messages[0].content;

    let expected_head = "【苏鸢】\n守夜人，沉默寡言。\n\n【阿烬】\n灯匠学徒，性子急。\n\n【群像语境】本会话有 2 位由模型扮演的角色：苏鸢、阿烬。当前版本对整段对话单次生成，请让各角色在回复中按名单顺序依次登场、以角色名区分发言。\n\n用户扮演的角色：旅人——老练的旅人";
    assert!(
        system.starts_with(expected_head),
        "多实例 system 头部形态，实际：{system}"
    );
    // 分节顺序：苏鸢 < 阿烬 < 群像声明 < 用户位（无场景行 → 无虚时行）。
    let suyuan = system.find("【苏鸢】").unwrap();
    let aji = system.find("【阿烬】").unwrap();
    let ensemble = system.find("【群像语境】").unwrap();
    let user_at = system.find("用户扮演的角色：旅人").unwrap();
    assert!(suyuan < aji && aji < ensemble && ensemble < user_at);
}

/// 多 LLM 位下空 persona 的实例仍出【角色名】标头（多角色语境中名字即身份）；
/// 用户位 persona 空白时只报名字不带破折号。
#[test]
fn multi_llm_blank_persona_keeps_name_header() {
    let roster = vec![
        llm_instance(1, "苏鸢", ""),
        llm_instance(2, "阿烬", "灯匠学徒。"),
        user_instance(3, "旅人", "  "),
    ];
    let history = vec![message(1, MessageRole::User, "在吗？")];
    let messages = assemble_base(&roster, &[], &history);
    let system = &messages[0].content;
    assert!(
        system.starts_with("【苏鸢】\n\n【阿烬】\n灯匠学徒。"),
        "空 persona 出裸标头：{system}"
    );
    assert!(
        system.ends_with("用户扮演的角色：旅人"),
        "用户位 persona 空白只报名字（段尾）：{system}"
    );
    assert!(!system.contains("——"), "无 persona 不产生悬空破折号：{system}");
}

/// 状态快照多实例分组：多实例持有状态时逐实例分节「【实例名 · 组名】」,
/// 实例分组序 = roster 序；单实例持有状态时保持 v1 两小组形态（等价改造）。
#[test]
fn state_snapshot_groups_by_instance_when_multiple_owners() {
    let roster = vec![
        llm_instance(1, "苏鸢", "守夜人"),
        llm_instance(2, "阿烬", "灯匠学徒"),
        user_instance(3, "旅人", ""),
    ];
    let states = vec![
        CharacterState {
            id: 1,
            instance_id: 2,
            scope: CharacterStateScope::State,
            key: "情绪".into(),
            value: "焦躁".into(),
            expiry: None,
            source_scene: None,
            updated_at: 0,
            deleted_at: None,
            superseded_at: None,
        },
        CharacterState {
            id: 2,
            instance_id: 1,
            scope: CharacterStateScope::State,
            key: "情绪".into(),
            value: "释然".into(),
            expiry: None,
            source_scene: None,
            updated_at: 0,
            deleted_at: None,
            superseded_at: None,
        },
        CharacterState {
            id: 3,
            instance_id: 3,
            scope: CharacterStateScope::Relation,
            key: "对苏鸢".into(),
            value: "信任".into(),
            expiry: None,
            source_scene: None,
            updated_at: 0,
            deleted_at: None,
            superseded_at: None,
        },
    ];
    let history = vec![message(1, MessageRole::User, "在吗？")];
    let messages = assemble(&AssembleInputs {
        instances: &roster,
        scenes: &[],
        history: &history,
        calendar: &DEFAULT_CALENDAR,
        states: &states,
        dossier: None,
        near_scenes: context::SETTLED_SCENES_IN_NEAR,
        system_prompt: "",
        world: None,
    });
    let system = &messages[0].content;
    // roster 序（苏鸢 → 阿烬 → 旅人）分组，空组（阿烬 · 关系）省略。
    let expected = "【苏鸢 · 当前状态】\n- 情绪：释然\n\n【阿烬 · 当前状态】\n- 情绪：焦躁\n\n【旅人 · 关系】\n- 对苏鸢：信任";
    assert!(
        system.contains(expected),
        "多实例状态分组形态，实际：{system}"
    );
    assert!(
        !system.contains("【当前状态】\n-"),
        "多实例形态不再出无主【当前状态】组：{system}"
    );
}
