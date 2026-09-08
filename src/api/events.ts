/**
 * INT-001 类型化流式事件通道（token / reasoning / done / error，携 session_id + message_id）。
 * 阶段 3 接入 tauri-specta 生成的 listen 封装；当前浏览器模式下为空实现。
 */

export type StreamEvent =
  | { type: 'token'; sessionId: number; messageId: number; text: string }
  | { type: 'reasoning'; sessionId: number; messageId: number; text: string }
  | { type: 'done'; sessionId: number; messageId: number }
  | { type: 'error'; sessionId: number; messageId: number; message: string };

export type StreamEventHandler = (event: StreamEvent) => void;

/** 订阅某会话的流式事件，返回取消函数。多路并发生成靠 sessionId 路由（ADR-007）。 */
export function subscribeStream(_sessionId: number, _handler: StreamEventHandler): () => void {
  return () => {
    /* 阶段 3：listen('stream://event', e => e.session_id === sessionId && handler(...)) */
  };
}
