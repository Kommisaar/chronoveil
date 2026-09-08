//! 测试专用本地 mock HTTP 服务（验收 8）：`std::net::TcpListener` 手写请求解析与 SSE 字节流，
//! 不新增任何依赖。连接顺序处理（客户端重试逐次新建连接，与 `Connection: close` 响应头配套）。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// 被测客户端发来的 HTTP 请求快照。
#[derive(Debug, Clone)]
pub struct MockRequest {
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl MockRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap_or(serde_json::Value::Null)
    }
}

/// 一次性 mock 服务：每条连接解析出请求后交给 handler 写响应。
pub struct MockServer {
    port: u16,
    connections: Arc<AtomicUsize>,
}

impl MockServer {
    pub fn start(handler: impl Fn(&MockRequest, &mut TcpStream) + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock 绑定端口失败");
        let port = listener.local_addr().expect("mock 取端口失败").port();
        let connections = Arc::new(AtomicUsize::new(0));
        let counter = connections.clone();
        let handler = Arc::new(handler);
        // 线程随测试进程退出而消亡，无需显式停机。
        std::thread::spawn(move || {
            for incoming in listener.incoming() {
                let Ok(mut stream) = incoming else { break };
                counter.fetch_add(1, Ordering::SeqCst);
                if let Some(req) = read_request(&mut stream) {
                    handler(&req, &mut stream);
                }
            }
        });
        Self { port, connections }
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// 已接受的连接数（= 客户端尝试次数，断流重试与错误映射测试用）。
    pub fn connection_count(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }
}

/// 读取完整请求：头（\r\n\r\n 截止）+ Content-Length 定长 body。
fn read_request(stream: &mut TcpStream) -> Option<MockRequest> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?;
    let path = request_line.split_whitespace().nth(1)?.to_owned();
    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_owned(), v.trim().to_owned()));
        }
    }
    let content_length: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    while buf.len() < header_end + content_length {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = String::from_utf8_lossy(&buf[header_end..]).into_owned();
    Some(MockRequest { path, headers, body })
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

// ---- 响应辅助 ----

fn write_head(stream: &mut TcpStream, status_line: &str, content_type: &str) -> std::io::Result<()> {
    stream.write_all(
        format!(
            "{status_line}\r\ncontent-type: {content_type}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
        )
        .as_bytes(),
    )
}

/// SSE 响应头（content-length: 0 仅为占位头；SSE body 直接随后写入并以关连接收尾）。
/// 注：多数客户端不依赖 SSE 的 content-length；reqwest 按 connection: close 读到 EOF。
pub fn sse_head(stream: &mut TcpStream) -> std::io::Result<()> {
    stream.write_all(
        b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n",
    )
}

pub fn status_head(stream: &mut TcpStream, code: u16, reason: &str) -> std::io::Result<()> {
    write_head(stream, &format!("HTTP/1.1 {code} {reason}"), "text/plain")
}

/// 非流式 JSON 响应（结构化调用 helper 测试用）。
pub fn json_body(stream: &mut TcpStream, content: &str) -> std::io::Result<()> {
    let payload = serde_json::json!({
        "choices": [{ "message": { "role": "assistant", "content": content } }]
    });
    let body = payload.to_string();
    stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    )
}

/// SSE `data:` 事件行。
pub fn sse_data(payload: &str) -> String {
    format!("data: {payload}\n\n")
}

/// 构造 OpenAI 兼容 delta JSON（content / reasoning_content 可选）。
pub fn delta_json(content: Option<&str>, reasoning: Option<&str>) -> String {
    let mut delta = serde_json::Map::new();
    if let Some(c) = content {
        delta.insert("content".into(), serde_json::Value::String(c.into()));
    }
    if let Some(r) = reasoning {
        delta.insert("reasoning_content".into(), serde_json::Value::String(r.into()));
    }
    serde_json::json!({ "choices": [{ "delta": serde_json::Value::Object(delta) }] }).to_string()
}
