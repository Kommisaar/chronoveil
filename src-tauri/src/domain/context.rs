//! 上下文窗口纯函数（ADR-004 场景对齐近景/远景，替换 ADR-002 条数滑窗）。
//!
//! 近景 = 最近 N 个已结算场景的整场逐字消息 + 进行中场景全量；远景（编年史）由
//! 装配层用场景行压缩（services/prompt.rs）。本模块只做窗口数学：输入是**已按
//! 场景边界切好的分段**（盖章段按库内 scene_id 归属分组、NULL 段按内容场景线
//! 兜底切分，切分属 services 层知识，见 services::director::contains_scene_line），
//! 不触 StoragePort / IO。
//!
//! 字符预算兜底：无 tokenizer，用字符数近似（中文一字 ≈ 一 token 量级，量级正确
//! 即可，常量可调）。近景超预算时先按**整场**淘汰最旧的已结算场（淘汰的场由
//! 调用方按保留段锚定 id 推算，自动落入远景编年史）；仅当进行中场景**自身**
//! 超预算才对它做头截断（丢最旧消息，保底保留最新一条，不产生空上下文）。

use crate::domain::models::Message;

/// 近景携带的已结算场景数**默认值**（ADR-004 / §7.8：旧场景压成一行编年史，只有
/// 最近几场吃全量上下文——聊一百场不糊）。窗口可选化后此值 = config.json 缺键时
/// 的回落值（infra::config::near_scenes，用户可配 1–6），经装配层穿入
/// [`near_view`]，常量本身仍是窗口数学的单一默认出处。
pub const SETTLED_SCENES_IN_NEAR: usize = 2;

/// 近景字符预算。无 tokenizer 下的粗近似：中文一字 ≈ 一 token 量级，宁可量级
/// 正确也不为本地个人应用引 tokenizer 依赖；超限由整场淘汰 / 头截断兜底。可调。
pub const NEAR_VIEW_CHAR_BUDGET: usize = 24_000;

/// 单个已收束场景段：连续消息切片 + 锚定的场景行 id。
#[derive(Debug, Clone, Copy)]
pub struct SceneSpan<'a> {
    /// 段内消息（保持对话顺序；盖章段末条是触发该场结算的场景线消息）。
    pub messages: &'a [Message],
    /// 锚定的场景行 id（scenes.id）：盖章段 = 库内归属，行 / 段 id 精确对应；
    /// None = 内容兜底切出的欠账段（场景线已出现但结算未落库，无行可锚，
    /// 不占编年史行，滑出近景即丢）。
    pub scene_id: Option<i64>,
}

/// 场景分段：调用方按场景边界在原历史上切好的连续片段（保持对话顺序）。
pub struct SceneSpans<'a> {
    /// 已收束场景，从旧到新；盖章段（scene_id 有值）按首现顺序排列，与场景行
    /// idx 同序；欠账段（None）夹在其间对应的位置上。
    pub closed: Vec<SceneSpan<'a>>,
    /// 进行中场景：最近一道场景线之后 / 最新盖章段之后的全量消息（结算只回填到
    /// 触发行，之后的消息 scene_id 仍为 NULL，逻辑上属于最新场景行）。
    pub ongoing: &'a [Message],
}

/// 近景窗口结果。
pub struct NearView<'a> {
    /// 入选消息（已结算场整场 + 进行中场，保持对话顺序、逐字原文）。
    pub messages: Vec<&'a Message>,
    /// 近景实际保留的已收束段（从旧到新，可能因预算淘汰少于请求值）。编年史据
    /// 此做 id 精确对应：远景行 = 场景行 −（保留段锚定的行 ∪ 末尾进行中行）——
    /// 被淘汰的段不占锚，其行自动落入远景；欠账段（None 锚）不排除任何行，
    /// 滑出近景即丢（无行可接，现行接受条款）。
    pub kept: Vec<SceneSpan<'a>>,
}

/// ADR-004 近景窗口：最近 `settled_scenes` 个已结算场**整场** + 进行中场全量。
/// 超预算先整场淘汰最旧已结算场；仅当进行中场自身超预算才对它头截断。
/// `settled_scenes` 为 0 或没有已结算场时退化为纯进行中场（同样受预算约束）。
pub fn near_view<'a>(
    spans: SceneSpans<'a>,
    settled_scenes: usize,
    char_budget: usize,
) -> NearView<'a> {
    let span_chars = |span: &SceneSpan<'_>| {
        span.messages
            .iter()
            .map(|m| m.content.chars().count())
            .sum::<usize>()
    };
    let take = settled_scenes.min(spans.closed.len());
    let kept: &[SceneSpan<'a>] = &spans.closed[spans.closed.len() - take..];
    let ongoing_chars = spans
        .ongoing
        .iter()
        .map(|m| m.content.chars().count())
        .sum::<usize>();
    let mut total = kept.iter().map(span_chars).sum::<usize>() + ongoing_chars;

    // 整场淘汰：从最旧的**入选**已结算场起整场丢弃，直到预算内或已结算场用尽。
    let mut evicted = 0;
    while evicted < kept.len() && total > char_budget {
        total -= span_chars(&kept[evicted]);
        evicted += 1;
    }
    let kept = &kept[evicted..];

    // 头截断只发生在「进行中场自身超预算」（此时已结算场已全部淘汰、余量为 0）；
    // 正常情况余量 = 预算 − 保留场字符，进行中场原样全量。
    let ongoing = truncate_head(
        spans.ongoing,
        char_budget.saturating_sub(total - ongoing_chars),
    );

    NearView {
        messages: kept
            .iter()
            .flat_map(|span| span.messages.iter())
            .chain(ongoing.iter())
            .collect(),
        kept: kept.to_vec(),
    }
}

/// 头截断（丢最旧消息）：从最新条往旧累加字符，超过余量即停。最新一条无条件
/// 保留——预算极小也不产生空上下文（生成请求至少要带上最新一轮对话）。
/// Task-05 起探索器 read_scene 的超长场截断复用本函数（pub(crate)，同款语义）。
pub(crate) fn truncate_head(messages: &[Message], budget: usize) -> &[Message] {
    let mut total = 0usize;
    let mut start = messages.len();
    for (index, message) in messages.iter().enumerate().rev() {
        let chars = message.content.chars().count();
        if start < messages.len() && total + chars > budget {
            break;
        }
        total += chars;
        start = index;
    }
    &messages[start..]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::MessageRole;

    fn msg(id: usize, content: &str) -> Message {
        Message {
            id: id as i64,
            session_id: 1,
            role: MessageRole::User,
            content: content.to_string(),
            reasoning: None,
            think_ms: None,
            instance_id: None,
            tokens: None,
            created_at: id as i64,
            interrupt_flag: None,
            scene_id: None,
            deleted_at: None,
        }
    }

    /// 无锚段构造（窗口数学不关心锚定值，只透传给调用方做 id 对应）。
    fn span(messages: &[Message]) -> SceneSpan<'_> {
        SceneSpan {
            messages,
            scene_id: None,
        }
    }

    fn anchors(view: &NearView<'_>) -> Vec<Option<i64>> {
        view.kept.iter().map(|span| span.scene_id).collect()
    }

    fn contents<'a>(view: &'a NearView<'a>) -> Vec<&'a str> {
        view.messages.iter().map(|m| m.content.as_str()).collect()
    }

    /// 3 个已收束场（各 2 条）+ 进行中场（2 条）：默认取最近 2 场整场 + 进行中
    /// 全量，逐字、顺序不变；最旧一场不入选。
    #[test]
    fn near_view_keeps_last_two_settled_scenes_whole() {
        let all: Vec<Message> = (0..8).map(|i| msg(i, &format!("m{i}"))).collect();
        let spans = SceneSpans {
            closed: vec![span(&all[0..2]), span(&all[2..4]), span(&all[4..6])],
            ongoing: &all[6..],
        };

        let view = near_view(spans, SETTLED_SCENES_IN_NEAR, NEAR_VIEW_CHAR_BUDGET);
        assert_eq!(
            contents(&view),
            vec!["m2", "m3", "m4", "m5", "m6", "m7"],
            "最近 2 场整场 + 进行中全量，顺序不变"
        );
        assert_eq!(view.kept.len(), 2);
    }

    /// 已结算场不足请求数：有几场取几场，全部保留。
    #[test]
    fn near_view_takes_fewer_when_less_settled_available() {
        let all: Vec<Message> = (0..3).map(|i| msg(i, &format!("m{i}"))).collect();
        let spans = SceneSpans {
            closed: vec![span(&all[0..2])],
            ongoing: &all[2..],
        };
        let view = near_view(spans, SETTLED_SCENES_IN_NEAR, NEAR_VIEW_CHAR_BUDGET);
        assert_eq!(contents(&view), vec!["m0", "m1", "m2"]);
        assert_eq!(view.kept.len(), 1);

        // 无已结算场：纯进行中场。
        let spans = SceneSpans {
            closed: vec![],
            ongoing: &all[..],
        };
        let view = near_view(spans, SETTLED_SCENES_IN_NEAR, NEAR_VIEW_CHAR_BUDGET);
        assert_eq!(contents(&view), vec!["m0", "m1", "m2"]);
        assert_eq!(view.kept.len(), 0);
    }

    /// 窗口可选化（近景场景数 1–6）：同一 6 场历史下请求 1 / 3 / 6 场的窗口数学
    /// ——取的是**最新** N 场整场，请求超出存量时退化为全部存量。
    #[test]
    fn near_view_honors_configurable_settled_scene_counts() {
        fn build<'a>(
            closed: &[&'a [Message]],
            ongoing: &'a [Message],
        ) -> SceneSpans<'a> {
            SceneSpans {
                closed: closed.iter().map(|ms| span(ms)).collect(),
                ongoing,
            }
        }
        let all: Vec<Message> = (0..14).map(|i| msg(i, &format!("m{i}"))).collect();
        // 6 个已收束场（各 2 条）+ 进行中场（2 条）。
        let closed: Vec<&[Message]> = (0..6).map(|s| &all[s * 2..s * 2 + 2]).collect();

        // 请求 1 场：只带最新一场（场六）+ 进行中，最省 token 形态。
        let view = near_view(build(&closed, &all[12..]), 1, NEAR_VIEW_CHAR_BUDGET);
        assert_eq!(contents(&view), vec!["m10", "m11", "m12", "m13"]);
        assert_eq!(view.kept.len(), 1);

        // 请求 3 场：场四 + 场五 + 场六 + 进行中。
        let view = near_view(build(&closed, &all[12..]), 3, NEAR_VIEW_CHAR_BUDGET);
        assert_eq!(
            contents(&view),
            vec!["m6", "m7", "m8", "m9", "m10", "m11", "m12", "m13"]
        );
        assert_eq!(view.kept.len(), 3);

        // 请求 6 场：存量恰好 6 场 → 全部整场 + 进行中。
        let view = near_view(build(&closed, &all[12..]), 6, NEAR_VIEW_CHAR_BUDGET);
        assert_eq!(
            contents(&view),
            all.iter().map(|m| m.content.as_str()).collect::<Vec<_>>()
        );
        assert_eq!(view.kept.len(), 6);

        // 请求超出存量（9 > 6）→ 退化为全部存量，不 panic。
        let view = near_view(build(&closed, &all[12..]), 9, NEAR_VIEW_CHAR_BUDGET);
        assert_eq!(view.kept.len(), 6);
    }

    /// 预算触发**整场**淘汰：最旧的入选场整体出局（场内消息要么全在要么全不在），
    /// 保留段随之减少（编年史据锚定 id 多收一行）。
    #[test]
    fn near_view_evicts_oldest_settled_scene_whole_under_budget() {
        let all: Vec<Message> = vec![
            msg(0, &"旧".repeat(1_000)),
            msg(1, &"旧".repeat(1_000)), // 场 A（默认窗口外）
            msg(2, &"贝".repeat(1_000)),
            msg(3, &"贝".repeat(1_000)), // 场 B（预算淘汰）
            msg(4, &"新".repeat(1_000)),
            msg(5, &"新".repeat(1_000)), // 场 C（保留）
            msg(6, "进行中"),
        ];
        let spans = SceneSpans {
            closed: vec![span(&all[0..2]), span(&all[2..4]), span(&all[4..6])],
            ongoing: &all[6..],
        };

        // 预算 2500：B+C（4000）超限 → 淘汰 B → C（2000）+ 进行中（3）= 2003 ≤ 2500。
        let view = near_view(spans, SETTLED_SCENES_IN_NEAR, 2_500);
        assert_eq!(view.kept.len(), 1);
        let got = contents(&view);
        assert_eq!(got.len(), 3, "近景 = 场 C（2 条）+ 进行中（1 条）");
        assert!(
            got[0].chars().all(|c| c == '新') && got[1].chars().all(|c| c == '新'),
            "场 C 整场保留"
        );
        assert_eq!(got[2], "进行中");
        assert!(
            !got.iter().any(|c| c.contains('旧') || c.contains('贝')),
            "被淘汰的场 B（连同默认窗口外的场 A）不得残留半场消息"
        );
    }

    /// 保留段的锚定 id 原样透传（欠账段 None 夹在盖章段中间同样进窗口）：
    /// 编年史据此做 id 精确对应，窗口数学本身不解释锚定值。
    #[test]
    fn near_view_passes_span_anchors_through() {
        let all: Vec<Message> = (0..5).map(|i| msg(i, &format!("m{i}"))).collect();
        let spans = SceneSpans {
            closed: vec![
                SceneSpan {
                    messages: &all[0..2],
                    scene_id: Some(11),
                },
                SceneSpan {
                    messages: &all[2..4],
                    scene_id: None,
                },
                SceneSpan {
                    messages: &all[4..5],
                    scene_id: Some(13),
                },
            ],
            ongoing: &all[5..5], // 空：本用例只看 closed 侧锚定透传
        };

        let view = near_view(spans, SETTLED_SCENES_IN_NEAR, NEAR_VIEW_CHAR_BUDGET);
        assert_eq!(
            anchors(&view),
            vec![None, Some(13)],
            "最近两段（欠账段 + 盖章段）入选，锚定值原样透传"
        );
    }

    /// 进行中场自身超预算：先淘汰全部已结算场，再对进行中场头截断（丢最旧、
    /// 留最新）；截断后总字符不超过预算。
    #[test]
    fn near_view_head_truncates_ongoing_when_it_alone_exceeds_budget() {
        let settled: Vec<Message> = (0..2).map(|i| msg(i, &format!("场{i}"))).collect();
        let ongoing: Vec<Message> = (0..30).map(|i| msg(100 + i, &"字".repeat(1_000))).collect();
        let spans = SceneSpans {
            closed: vec![span(&settled[..])],
            ongoing: &ongoing[..],
        };

        let view = near_view(spans, SETTLED_SCENES_IN_NEAR, 24_000);
        assert_eq!(view.kept.len(), 0, "进行中场自身超限 → 已结算场全部淘汰");
        let got = contents(&view);
        assert_eq!(got.len(), 24, "留最新 24 条（每条 1000 字）");
        assert_eq!(got[0], "字".repeat(1_000), "每条内容原样（截断按条不切字）");
        assert_eq!(view.messages.last().unwrap().id, 129, "最新一条必须在");
        assert_eq!(view.messages[0].id, 106, "最旧 6 条被丢弃（头截断）");
    }

    /// 保底：最新一条自身超预算时仍保留（不产生空上下文）。
    #[test]
    fn near_view_keeps_newest_message_even_if_it_alone_exceeds_budget() {
        let ongoing = vec![msg(0, "旧的长消息"), msg(1, &"巨".repeat(3_000))];
        let spans = SceneSpans {
            closed: vec![],
            ongoing: &ongoing[..],
        };
        let view = near_view(spans, 0, 10);
        assert_eq!(
            contents(&view),
            vec!["巨".repeat(3_000)],
            "头截断保留最新条：超预算的巨条（最新）保留，更旧的小条被丢"
        );
        // 反过来：只有一条且超预算 → 仍保留。
        let spans = SceneSpans {
            closed: vec![],
            ongoing: &ongoing[1..],
        };
        let view = near_view(spans, 0, 10);
        assert_eq!(view.messages.len(), 1, "唯一消息超预算也不得清空上下文");
    }
}
