//! SSE 行解析（CMP-002 / INT-002）：字节流 → 完整行 → OpenAI 兼容 chat delta。
//!
//! 设计约定：
//! - 字节缓冲只在凑齐完整行（`\n` 结尾）后才解码——UTF-8 多字节字符跨包被切断时
//!   不会因 `from_utf8_lossy` 损坏（UTF-8 续字节不会是 `\n`，整行解码必安全）；
//! - 只认 `data:` 行；`event:` / `id:` / 注释（`:`）与空行全部忽略（验收 2：未知事件优雅忽略）；
//! - `data: [DONE]` 为终止哨兵；
//! - delta 的 `content` 走正文、`reasoning_content`（兼容别名 `reasoning`）走思考，
//!   未知字段（finish_reason、role 等）一律忽略；
//! - 顶层 `usage` 对象（透明化功能，调用轨迹用）单独产出 [`SseItem::Usage`]：
//!   OpenAI 兼容网关在流末尾直发 usage 终帧（choices 空数组）时捕获；请求侧
//!   **不追加** `stream_options: {"include_usage": true}`（部分中转不认识该参数，
//!   保守兼容——有则记，无则调用轨迹的 usage 为 NULL）。

use serde_json::Value;

/// 一个 delta 里的两路增量；None = 该字段本轮无内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatDelta {
    pub content: Option<String>,
    pub reasoning: Option<String>,
}

/// 流内捕获的 usage 终帧（透明化功能：调用轨迹的 token 用量）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SseUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

/// 解析产物：`[DONE]` 哨兵、一个有效 delta、或一帧 usage（无效行在解析层即被忽略，
/// 不上抛）。同一帧同时带 usage 与有效 delta 时产出两个条目（Usage 在前）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseItem {
    Delta(ChatDelta),
    Usage(SseUsage),
    Done,
}

/// 解析器：跨 chunk 攒字节，逐完整行解析。
#[derive(Debug, Default)]
pub struct SseParser {
    buf: Vec<u8>,
}

impl SseParser {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// 喂入一段原始字节，返回其中凑齐的所有行解析出的条目。
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<SseItem> {
        self.buf.extend_from_slice(bytes);
        let mut items = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            // 整行（不含换行）——完整行内的多字节字符解码必安全。
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let line = &line[..line.len() - 1]; // 去掉 \n
            let line = String::from_utf8_lossy(line);
            let line = line.strip_suffix('\r').unwrap_or(&line);
            items.extend(parse_line(line));
        }
        items
    }

    /// 流结束：冲刷残行（未换行的尾巴）。正常 SSE 以 `\n` 结尾，此处通常为空。
    pub fn finish(&mut self) -> Vec<SseItem> {
        if self.buf.is_empty() {
            return Vec::new();
        }
        let line = String::from_utf8_lossy(&self.buf).into_owned();
        self.buf.clear();
        parse_line(&line)
    }
}

/// 单行解析：非 `data:` 行一律忽略；`data: [DONE]` 为哨兵；其余按帧解析
/// （usage 终帧与 delta 可在同帧并存，各自产出）。
fn parse_line(line: &str) -> Vec<SseItem> {
    let Some(payload) = line.strip_prefix("data:").map(str::trim_start) else {
        return Vec::new();
    };
    if payload == "[DONE]" {
        return vec![SseItem::Done];
    }
    parse_frame(payload)
}

/// 单帧解析：顶层 usage 对象 → [`SseItem::Usage`]；choices[0].delta 有效增量 →
/// [`SseItem::Delta`]。非 JSON、两者皆缺 → 空（本帧忽略）。
fn parse_frame(payload: &str) -> Vec<SseItem> {
    let Ok(value) = serde_json::from_str::<Value>(payload) else {
        return Vec::new();
    };
    let mut items = Vec::new();
    if let Some(usage) = usage_of(&value) {
        items.push(SseItem::Usage(usage));
    }
    if let Some(delta) = delta_of(&value) {
        items.push(SseItem::Delta(delta));
    }
    items
}

/// 帧内 usage 提取（透明化功能）：顶层 `usage` 对象的 prompt_tokens /
/// completion_tokens 皆须为整数，缺一即视为无 usage（不猜不补）。
fn usage_of(value: &Value) -> Option<SseUsage> {
    let usage = value.get("usage")?;
    Some(SseUsage {
        prompt_tokens: usage.get("prompt_tokens")?.as_i64()?,
        completion_tokens: usage.get("completion_tokens")?.as_i64()?,
    })
}

/// choices[0].delta 的两路增量提取。容错策略（INT-002 兼容退化）：缺 choices、
/// 缺 delta、字段为 null、空串——都视为「本轮无增量」返回 None，不让怪异
/// provider 的杂音炸掉整条流。
fn delta_of(value: &Value) -> Option<ChatDelta> {
    let choice = value.get("choices")?.as_array()?.first()?;
    let delta = choice.get("delta")?;
    // 字段型 reasoning：reasoning_content 为主，兼容别名 reasoning（部分网关用后者）。
    let reasoning = delta
        .get("reasoning_content")
        .or_else(|| delta.get("reasoning"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let content = delta
        .get("content")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if content.is_none() && reasoning.is_none() {
        return None;
    }
    Some(ChatDelta { content, reasoning })
}

/// OpenAI 兼容 delta 解析（公开形态，测试与既有消费方沿用）。
pub fn parse_delta(data: &str) -> Option<ChatDelta> {
    let value: Value = serde_json::from_str(data).ok()?;
    delta_of(&value)
}

/// OpenAI 兼容 usage 帧解析（透明化功能，测试沿用）。
pub fn parse_usage(data: &str) -> Option<SseUsage> {
    let value: Value = serde_json::from_str(data).ok()?;
    usage_of(&value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(parser: &mut SseParser, chunks: &[&[u8]]) -> Vec<SseItem> {
        let mut items = Vec::new();
        for c in chunks {
            items.extend(parser.feed(c));
        }
        items.extend(parser.finish());
        items
    }

    #[test]
    fn single_chunk_normal_flow() {
        let mut p = SseParser::new();
        let items = feed_all(
            &mut p,
            &["data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n\
               data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n\
               data: [DONE]\n\n"
                .as_bytes()],
        );
        assert_eq!(items.len(), 3);
        assert_eq!(items[0], SseItem::Delta(ChatDelta {
            content: Some("你".into()), reasoning: None,
        }));
        assert_eq!(items[2], SseItem::Done);
    }

    /// 字节按任意边界切块（含 UTF-8 多字节字符被拦腰切断），解析结果不受影响。
    #[test]
    fn byte_chunks_split_at_arbitrary_boundaries() {
        let payload = "data: {\"choices\":[{\"delta\":{\"content\":\"深度·思考\"}}]}\n\ndata: [DONE]\n\n";
        let bytes = payload.as_bytes();
        for step in 1..=7 {
            let mut p = SseParser::new();
            let chunks: Vec<&[u8]> = bytes.chunks(step).collect();
            let items = feed_all(&mut p, &chunks);
            assert_eq!(items.len(), 2, "step={step}");
            assert_eq!(
                items[0],
                SseItem::Delta(ChatDelta { content: Some("深度·思考".into()), reasoning: None }),
                "step={step}"
            );
            assert_eq!(items[1], SseItem::Done, "step={step}");
        }
    }

    /// CRLF 行尾同样支持。
    #[test]
    fn crlf_line_endings() {
        let mut p = SseParser::new();
        let items = feed_all(&mut p, &[b"data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n"]);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], SseItem::Delta(ChatDelta { content: Some("a".into()), reasoning: None }));
    }

    /// 未知事件类型、注释、空行、event/id 行全部优雅忽略。
    #[test]
    fn unknown_lines_are_ignored() {
        let mut p = SseParser::new();
        let items = feed_all(
            &mut p,
            &[b": keep-alive\n\n\
               event: ping\n\
               data: {\"unexpected\":true}\n\n\
               id: 42\n\n\
               data: {\"choices\":[{\"delta\":{\"content\":\"x\"},\"finish_reason\":null}]}\n\n\
               data: [DONE]\n\n"],
        );
        // event: ping 之下的 data 行虽是合法 JSON 但缺 choices → 忽略；只留正文 delta 与 DONE。
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], SseItem::Delta(ChatDelta { content: Some("x".into()), reasoning: None }));
    }

    /// 验收 2：字段型 reasoning 直通思考通道；两字段同现时各自就位。
    #[test]
    fn field_reasoning_routes_to_think() {
        let mut p = SseParser::new();
        let items = feed_all(
            &mut p,
            &["data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"想\",\"content\":\"写\"}}]}\n\ndata: [DONE]\n\n".as_bytes()],
        );
        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0],
            SseItem::Delta(ChatDelta { content: Some("写".into()), reasoning: Some("想".into()) })
        );
    }

    /// 兼容别名 `reasoning`（部分网关）同样直通。
    #[test]
    fn reasoning_alias_field_supported() {
        let delta = parse_delta("{\"choices\":[{\"delta\":{\"reasoning\":\"R\"}}]}").unwrap();
        assert_eq!(delta.reasoning.as_deref(), Some("R"));
    }

    /// finish_reason 收尾块、空串、null、缺 delta：全部视为无增量。
    #[test]
    fn empty_and_terminal_deltas_are_dropped() {
        assert_eq!(parse_delta("{\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}"), None);
        assert_eq!(parse_delta("{\"choices\":[{\"delta\":{\"content\":\"\"}}]}"), None);
        assert_eq!(parse_delta("{\"choices\":[{\"delta\":{\"content\":null}}]}"), None);
        assert_eq!(parse_delta("{\"choices\":[]}"), None);
        assert_eq!(parse_delta("not-json"), None);
        assert_eq!(parse_delta(""), None);
    }

    /// 残行冲刷：流在行中间被掐断时，残行按原始文本忽略，不误报。
    #[test]
    fn trailing_partial_line_is_flushed_safely() {
        let mut p = SseParser::new();
        let items = feed_all(&mut p, &[b"data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\ndata: {\"choi"]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0], SseItem::Delta(ChatDelta { content: Some("a".into()), reasoning: None }));
    }

    /// `data:` 冒号后空格可省略（SSE 规范只认冒号定界）：`data:{json}` 与 `data:[DONE]` 同样生效。
    #[test]
    fn data_field_without_space_after_colon_is_parsed() {
        let mut p = SseParser::new();
        let items = feed_all(
            &mut p,
            &["data:{\"choices\":[{\"delta\":{\"content\":\"无空格\"}}]}\n\ndata:[DONE]\n\n".as_bytes()],
        );
        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0],
            SseItem::Delta(ChatDelta { content: Some("无空格".into()), reasoning: None })
        );
        assert_eq!(items[1], SseItem::Done);
    }

    /// 冒号后多个空格同样被 trim_start 吞掉，不影响负载解析。
    #[test]
    fn extra_spaces_after_colon_are_trimmed() {
        let delta = parse_delta("   {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}");
        assert!(delta.is_some(), "parse_delta 层容忍前导空白");
        let mut p = SseParser::new();
        let items = feed_all(&mut p, &[b"data:   [DONE]\n\n"]);
        assert_eq!(items, vec![SseItem::Done]);
    }

    /// 同一事件的多条 `data:` 行按「每行独立解析」处理（非 SSE 规范的拼接语义）：
    /// JSON 被拆到两行时两行均非法 → 全部忽略，不炸流；各自完整的行各自产出。
    #[test]
    fn json_split_across_two_data_lines_is_ignored_per_line() {
        let mut p = SseParser::new();
        let items = feed_all(
            &mut p,
            &["data: {\"choices\":[{\"delta\":\n\
               data: {\"content\":\"拆开\"}}]}\n\n\
               data: {\"choices\":[{\"delta\":{\"content\":\"完整\"}}]}\n\n"
                .as_bytes()],
        );
        assert_eq!(items.len(), 1, "拆开的半截 JSON 两行都忽略，只留完整行");
        assert_eq!(items[0], SseItem::Delta(ChatDelta { content: Some("完整".into()), reasoning: None }));
    }

    /// 空负载（`data:` / `data: ` 行）忽略，不产出也不报错。
    #[test]
    fn empty_data_payload_is_ignored() {
        let mut p = SseParser::new();
        let items = feed_all(
            &mut p,
            &[b"data:\n\ndata: \n\ndata: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n"],
        );
        assert_eq!(items.len(), 1);
    }

    /// 字段名大小写敏感（SSE 规范）：`DATA:` 不是 data 行，整行忽略。
    #[test]
    fn uppercase_data_field_is_ignored() {
        let mut p = SseParser::new();
        let items = feed_all(
            &mut p,
            &["DATA: {\"choices\":[{\"delta\":{\"content\":\"大写\"}}]}\n\ndata: [DONE]\n\n".as_bytes()],
        );
        assert_eq!(items, vec![SseItem::Done]);
    }

    /// `data: [DONE]` 恰好无换行收尾：feed 不产出，finish 冲刷出哨兵。
    #[test]
    fn done_without_trailing_newline_is_flushed_by_finish() {
        let mut p = SseParser::new();
        assert_eq!(p.feed(b"data: [DONE]"), Vec::new(), "无换行不成行");
        assert_eq!(p.finish(), vec![SseItem::Done]);
        assert!(p.finish().is_empty(), "冲刷后缓冲清空，二次 finish 为空");
    }

    /// 空 chunk 喂入是无害 no-op。
    #[test]
    fn empty_feed_is_noop() {
        let mut p = SseParser::new();
        assert_eq!(p.feed(b""), Vec::new());
        assert_eq!(p.finish(), Vec::new());
    }

    // ---- usage 终帧（透明化功能：调用轨迹的 token 用量）----

    /// OpenAI 兼容 usage 终帧（choices 空数组 + 顶层 usage）单独产出 Usage 条目。
    #[test]
    fn usage_terminal_frame_is_captured() {
        let mut p = SseParser::new();
        let payload =
            r#"{"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}"#;
        let items = feed_all(
            &mut p,
            &[format!("data: {payload}\n\ndata: [DONE]\n\n").as_bytes()],
        );
        assert_eq!(
            items,
            vec![
                SseItem::Usage(SseUsage { prompt_tokens: 11, completion_tokens: 7 }),
                SseItem::Done,
            ]
        );
        assert_eq!(parse_usage(payload).unwrap(), SseUsage { prompt_tokens: 11, completion_tokens: 7 });
    }

    /// 同帧既有有效 delta 又带 usage（部分网关末帧形态）：两个条目都产出（Usage 在前）。
    #[test]
    fn usage_and_delta_in_same_frame_yield_both_items() {
        let mut p = SseParser::new();
        let items = feed_all(
            &mut p,
            &[format!(
                "data: {}\n\ndata: [DONE]\n\n",
                r#"{"choices":[{"delta":{"content":"终"}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}"#
            )
            .as_bytes()],
        );
        assert_eq!(
            items,
            vec![
                SseItem::Usage(SseUsage { prompt_tokens: 1, completion_tokens: 2 }),
                SseItem::Delta(ChatDelta { content: Some("终".into()), reasoning: None }),
                SseItem::Done,
            ]
        );
    }

    /// usage 字段缺失 / 非整数 / 非对象：按无 usage 忽略，不影响 delta 解析。
    #[test]
    fn malformed_usage_is_ignored() {
        assert_eq!(parse_usage(r#"{"choices":[]}"#), None, "无 usage 对象");
        assert_eq!(parse_usage(r#"{"usage":{"prompt_tokens":1}}"#), None, "缺 completion_tokens");
        assert_eq!(parse_usage(r#"{"usage":{"prompt_tokens":"11","completion_tokens":7}}"#), None, "非整数");
        assert_eq!(parse_usage(r#"{"usage":null}"#), None);
        // 杂音帧（无 delta 无 usage）整帧忽略，不产出条目。
        let mut p = SseParser::new();
        let items = feed_all(&mut p, &[b"data: {\"usage\":{\"prompt_tokens\":1}}\n\n"]);
        assert_eq!(items, Vec::<SseItem>::new());
    }
}
