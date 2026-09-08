//! 内联 `<think>` 流式标签状态机（CMP-002 / INT-002，FR-003 思考双通道的路由半）。
//!
//! 字段型 `reasoning_content` 不经过本模块（客户端直通思考通道）；只有正文 `content`
//! 里内联的 `<think>…</think>` 由本状态机实时拆分：
//! - 标签内文本 → 思考通道，标签本身不进正文；
//! - 半标签跨包缓存：`<thi` 与 `ink>` 分包到达时，尾巴攒着不输出，凑齐再判；
//! - 误判安全：`<thinking>` 这类不是标签的前缀按普通文本原样放行；
//! - 流结束仍未闭合/仍攒着尾巴时，按当前通道路由冲刷，不丢字。

/// 拆分输出：本轮喂入产生的正文与思考增量。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ThinkOutput {
    pub body: String,
    pub think: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// 正文态：等待 `<think>`。
    Body,
    /// 思考态：等待 `</think>`。
    InsideThink,
}

const OPEN: &str = "<think>";
const CLOSE: &str = "</think>";

/// 流式标签拆分器。逐 `feed` 增量喂入，`flush` 收尾。
#[derive(Debug, Clone)]
pub struct ThinkSplitter {
    state: State,
    /// 疑似标签前缀的尾巴，攒着等后续字节定夺。
    pending: String,
}

impl ThinkSplitter {
    pub fn new() -> Self {
        Self { state: State::Body, pending: String::new() }
    }

    /// 喂入一段正文增量，返回本轮可安全输出的（正文, 思考）增量。
    pub fn feed(&mut self, chunk: &str) -> ThinkOutput {
        let mut out = ThinkOutput::default();
        for ch in chunk.chars() {
            let tag = match self.state {
                State::Body => OPEN,
                State::InsideThink => CLOSE,
            };
            // 候选 = 现有尾巴 + 新字符。
            let candidate = format!("{}{}", self.pending, ch);
            if tag.starts_with(candidate.as_str()) {
                self.pending = candidate;
                if self.pending == tag {
                    // 标签闭合：切态，标签本身不进任何通道。
                    self.state = match self.state {
                        State::Body => State::InsideThink,
                        State::InsideThink => State::Body,
                    };
                    self.pending.clear();
                }
                // 仍是前缀：继续攒着。
                continue;
            }
            // 误判：旧尾巴按当前通道放行（不含新字符），随后让新字符自寻出路
            //（可能是新标签的开头 `<`，继续攒）。
            self.flush_pending_into(&mut out);
            self.pending.clear();
            if tag.starts_with(ch) {
                self.pending.push(ch);
            } else {
                self.push_char(ch, &mut out);
            }
        }
        out
    }

    /// 流结束：攒着的尾巴按当前通道路由冲刷（无法再判定，绝不丢字）。
    pub fn flush(self) -> ThinkOutput {
        let mut out = ThinkOutput::default();
        self.flush_pending_into(&mut out);
        out
    }

    /// 把攒着的尾巴按当前状态写入输出通道。
    fn flush_pending_into(&self, out: &mut ThinkOutput) {
        for ch in self.pending.chars() {
            self.push_char(ch, out);
        }
    }

    /// 按当前状态写入单字符。
    fn push_char(&self, ch: char, out: &mut ThinkOutput) {
        match self.state {
            State::Body => out.body.push(ch),
            State::InsideThink => out.think.push(ch),
        }
    }
}

impl Default for ThinkSplitter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 拼接多次 feed 的输出，模拟客户端累积视角。
    fn run(chunks: &[&str]) -> (String, String) {
        let mut s = ThinkSplitter::new();
        let mut body = String::new();
        let mut think = String::new();
        for c in chunks {
            let out = s.feed(c);
            body.push_str(&out.body);
            think.push_str(&out.think);
        }
        let out = s.flush();
        body.push_str(&out.body);
        think.push_str(&out.think);
        (body, think)
    }

    #[test]
    fn plain_body_passes_through() {
        assert_eq!(run(&["你好，世界"]), ("你好，世界".into(), String::new()));
    }

    #[test]
    fn full_tag_routes_to_think_channel() {
        let (body, think) = run(&["你好<think>深度思考</think>世界"]);
        assert_eq!(body, "你好世界");
        assert_eq!(think, "深度思考");
    }

    /// 验收 3：半标签跨包——`<thi` + `ink>` 到达时尾巴攒着不输出。
    #[test]
    fn half_tag_across_chunks_is_held_then_routed() {
        let mut s = ThinkSplitter::new();
        let out = s.feed("正文<thi");
        assert_eq!(out.body, "正文", "半标签尾巴必须攒住，不能混入正文");
        let out = s.feed("nk>思考中");
        assert_eq!(out.body, "", "标签未闭合前正文应为空");
        assert_eq!(out.think, "思考中");
        let out = s.feed("</thi");
        assert_eq!(out.think, "", "半闭合尾巴攒住");
        let out = s.feed("nk>收尾");
        assert_eq!(out.think, "", "闭合后思考通道不再增长");
        assert_eq!(out.body, "收尾");
        let out = s.flush();
        assert!(out.body.is_empty() && out.think.is_empty());
    }

    #[test]
    fn multibyte_split_inside_think_is_preserved() {
        let (body, think) = run(&["<think>深", "度", "思", "考</think>完"]);
        assert_eq!(body, "完");
        assert_eq!(think, "深度思考");
    }

    /// 误判安全：`<thinking>` 不是标签，按普通文本放行。
    #[test]
    fn similar_longer_tag_is_literal_text() {
        let (body, think) = run(&["<thinking>abc"]);
        assert_eq!(body, "<thinking>abc");
        assert_eq!(think, "");
    }

    /// 流结束时标签未闭合：内容按思考通道冲刷，不丢字。
    #[test]
    fn unclosed_tag_flushes_to_think_channel() {
        let (body, think) = run(&["开头<think>忘了闭合"]);
        assert_eq!(body, "开头");
        assert_eq!(think, "忘了闭合");
    }

    /// 流结束时仍攒着疑似标签尾巴：按正文冲刷。
    #[test]
    fn dangling_partial_tag_flushes_to_body() {
        let (body, think) = run(&["abc<thi"]);
        assert_eq!(body, "abc<thi");
        assert_eq!(think, "");
    }

    /// 正文里的孤立 `</think>` 不触发切态，按字面输出。
    #[test]
    fn stray_close_tag_in_body_is_literal() {
        let (body, think) = run(&["</think>孤立闭合"]);
        assert_eq!(body, "</think>孤立闭合");
        assert_eq!(think, "");
    }

    /// 思考段内再次出现 `<think>` 不嵌套，按思考文本输出。
    #[test]
    fn open_tag_inside_think_is_literal() {
        let (body, think) = run(&["<think>嵌套<think>测试</think>尾"]);
        assert_eq!(body, "尾");
        assert_eq!(think, "嵌套<think>测试");
    }

    /// 多轮往返：两段思考夹一段正文。
    #[test]
    fn alternating_segments() {
        let (body, think) = run(&["一<think>思一</think>二<think>思二</think>三"]);
        assert_eq!(body, "一二三");
        assert_eq!(think, "思一思二");
    }
}
