//! 上下文窗口纯函数（ADR-004 场景对齐近景/远景，替换 ADR-002 条数滑窗）。
//!
//! 近景 = 最近 N 个已结算场景的整场逐字消息 + 进行中场景全量；远景（编年史）由
//! 装配层用场景行压缩（services/prompt.rs）。本模块只做窗口数学：输入是**已按
//! 场景边界切好的分段**（切分依赖场景线判定，属 services 层知识，见
//! services::director::contains_scene_line），不触 StoragePort / IO。
//!
//! 字符预算兜底：无 tokenizer，用字符数近似（中文一字 ≈ 一 token 量级，量级正确
//! 即可，常量可调）。近景超预算时先按**整场**淘汰最旧的已结算场（淘汰的场由
//! 调用方按 `kept_settled` 推算，自动落入远景编年史）；仅当进行中场景**自身**
//! 超预算才对它做头截断（丢最旧消息，保底保留最新一条，不产生空上下文）。

use crate::domain::models::Message;

/// 近景携带的已结算场景数（ADR-004 / §7.8：旧场景压成一行编年史，只有最近
/// 几场吃全量上下文——聊一百场不糊）。
pub const SETTLED_SCENES_IN_NEAR: usize = 2;

/// 近景字符预算。无 tokenizer 下的粗近似：中文一字 ≈ 一 token 量级，宁可量级
/// 正确也不为本地个人应用引 tokenizer 依赖；超限由整场淘汰 / 头截断兜底。可调。
pub const NEAR_VIEW_CHAR_BUDGET: usize = 24_000;

/// 场景分段：调用方按场景边界在原历史上切好的连续片段（保持对话顺序）。
pub struct SceneSpans<'a> {
    /// 已收束场景，从旧到新；每段末条是触发该场结算的场景线消息（与结算归属
    /// 半开区间「(上一道场景线, 触发行]」一致，触发行归收束场）。
    pub closed: Vec<&'a [Message]>,
    /// 进行中场景：最近一道场景线之后的全量消息（结算只回填到触发行，之后的
    /// 消息 scene_id 仍为 NULL，逻辑上属于最新场景行）。
    pub ongoing: &'a [Message],
}

/// 近景窗口结果。
pub struct NearView<'a> {
    /// 入选消息（已结算场整场 + 进行中场，保持对话顺序、逐字原文）。
    pub messages: Vec<&'a Message>,
    /// 近景实际保留的已结算场数（可能因预算淘汰少于请求值）。编年史据此收录
    /// 更早的场：远景行数 = 场景行总数 − 进行中 header 行(1) − kept_settled——
    /// 被淘汰的场因此自动落入远景，不出现「既不逐字也无摘要」的盲区。
    pub kept_settled: usize,
}

/// ADR-004 近景窗口：最近 `settled_scenes` 个已结算场**整场** + 进行中场全量。
/// 超预算先整场淘汰最旧已结算场；仅当进行中场自身超预算才对它头截断。
/// `settled_scenes` 为 0 或没有已结算场时退化为纯进行中场（同样受预算约束）。
pub fn near_view<'a>(
    spans: SceneSpans<'a>,
    settled_scenes: usize,
    char_budget: usize,
) -> NearView<'a> {
    let span_chars = |span: &[Message]| {
        span.iter()
            .map(|m| m.content.chars().count())
            .sum::<usize>()
    };
    let take = settled_scenes.min(spans.closed.len());
    let kept: &[&[Message]] = &spans.closed[spans.closed.len() - take..];
    let ongoing_chars = span_chars(spans.ongoing);
    let mut total = kept.iter().map(|span| span_chars(span)).sum::<usize>() + ongoing_chars;

    // 整场淘汰：从最旧的**入选**已结算场起整场丢弃，直到预算内或已结算场用尽。
    let mut evicted = 0;
    while evicted < kept.len() && total > char_budget {
        total -= span_chars(kept[evicted]);
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
            .flat_map(|span| span.iter())
            .chain(ongoing.iter())
            .collect(),
        kept_settled: kept.len(),
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
            tokens: None,
            created_at: id as i64,
            interrupt_flag: None,
            deleted_at: None,
        }
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
            closed: vec![&all[0..2], &all[2..4], &all[4..6]],
            ongoing: &all[6..],
        };

        let view = near_view(spans, SETTLED_SCENES_IN_NEAR, NEAR_VIEW_CHAR_BUDGET);
        assert_eq!(
            contents(&view),
            vec!["m2", "m3", "m4", "m5", "m6", "m7"],
            "最近 2 场整场 + 进行中全量，顺序不变"
        );
        assert_eq!(view.kept_settled, 2);
    }

    /// 已结算场不足请求数：有几场取几场，全部保留。
    #[test]
    fn near_view_takes_fewer_when_less_settled_available() {
        let all: Vec<Message> = (0..3).map(|i| msg(i, &format!("m{i}"))).collect();
        let spans = SceneSpans {
            closed: vec![&all[0..2]],
            ongoing: &all[2..],
        };
        let view = near_view(spans, SETTLED_SCENES_IN_NEAR, NEAR_VIEW_CHAR_BUDGET);
        assert_eq!(contents(&view), vec!["m0", "m1", "m2"]);
        assert_eq!(view.kept_settled, 1);

        // 无已结算场：纯进行中场。
        let spans = SceneSpans {
            closed: vec![],
            ongoing: &all[..],
        };
        let view = near_view(spans, SETTLED_SCENES_IN_NEAR, NEAR_VIEW_CHAR_BUDGET);
        assert_eq!(contents(&view), vec!["m0", "m1", "m2"]);
        assert_eq!(view.kept_settled, 0);
    }

    /// 预算触发**整场**淘汰：最旧的入选场整体出局（场内消息要么全在要么全不在），
    /// kept_settled 随之下降（编年史据此多收一行）。
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
            closed: vec![&all[0..2], &all[2..4], &all[4..6]],
            ongoing: &all[6..],
        };

        // 预算 2500：B+C（4000）超限 → 淘汰 B → C（2000）+ 进行中（3）= 2003 ≤ 2500。
        let view = near_view(spans, SETTLED_SCENES_IN_NEAR, 2_500);
        assert_eq!(view.kept_settled, 1);
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

    /// 进行中场自身超预算：先淘汰全部已结算场，再对进行中场头截断（丢最旧、
    /// 留最新）；截断后总字符不超过预算。
    #[test]
    fn near_view_head_truncates_ongoing_when_it_alone_exceeds_budget() {
        let settled: Vec<Message> = (0..2).map(|i| msg(i, &format!("场{i}"))).collect();
        let ongoing: Vec<Message> = (0..30).map(|i| msg(100 + i, &"字".repeat(1_000))).collect();
        let spans = SceneSpans {
            closed: vec![&settled[..]],
            ongoing: &ongoing[..],
        };

        let view = near_view(spans, SETTLED_SCENES_IN_NEAR, 24_000);
        assert_eq!(view.kept_settled, 0, "进行中场自身超限 → 已结算场全部淘汰");
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
