/**
 * INT-001 类型化流式事件通道（token / reasoning / done / error，携 session_id + message_id）。
 *
 * - wire 负载与 INT-001 一致（snake_case，type 判别），类型同源生成于
 *   `./generated/bindings.ts`（事件名 `stream-event`）；此处转换为前端 camelCase。
 * - token / reasoning 另携 `reset`（INT-001「只增不改」增字段，TASK-002）：true 表示
 *   重发尝试首事件，消费方应清空该 message_id 已累积内容后重新累积。
 * - 订阅按 session_id 过滤（多路并发路由，FR-007）；未知事件类型忽略（向前兼容）。
 */

import { events } from './generated/bindings';
import { isTauri } from './client';

/** 前端形态的流式事件（wire → camelCase；done 补 thinkMs，FR-001）。 */
export type StreamEvent =
  | { type: 'token'; sessionId: number; messageId: number; text: string; reset: boolean }
  | { type: 'reasoning'; sessionId: number; messageId: number; text: string; reset: boolean }
  | { type: 'done'; sessionId: number; messageId: number; thinkMs: number | null }
  | { type: 'error'; sessionId: number; messageId: number; reason: string; interrupted: boolean };

export type StreamEventHandler = (event: StreamEvent) => void;

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * wire 事件 → 前端事件。防御式解析（负载来自另一进程，INT-001 只增不改）：
 * 字段缺失 / 类型不符 / 未知 type 一律返回 null，调用方忽略（向前兼容）。
 */
export function fromWireEvent(raw: unknown): StreamEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const wire = raw as Record<string, unknown>;
  const sessionId = asNumber(wire.session_id);
  const messageId = asNumber(wire.message_id);
  if (sessionId === null || messageId === null) return null;

  switch (wire.type) {
    case 'token':
    case 'reasoning':
      return typeof wire.text === 'string' && typeof wire.reset === 'boolean'
        ? { type: wire.type, sessionId, messageId, text: wire.text, reset: wire.reset }
        : null;
    case 'done':
      return (wire.think_ms === null || asNumber(wire.think_ms) !== null)
        ? { type: 'done', sessionId, messageId, thinkMs: (wire.think_ms as number | null) ?? null }
        : null;
    case 'error':
      return typeof wire.reason === 'string' && typeof wire.interrupted === 'boolean'
        ? { type: 'error', sessionId, messageId, reason: wire.reason, interrupted: wire.interrupted }
        : null;
    default:
      // 未知事件类型忽略（INT-001：只增不改，旧前端遇新事件静默跳过）。
      return null;
  }
}

/** 订阅某会话的流式事件，返回取消函数。多路并发生成靠 sessionId 路由（ADR-007）。 */
export function subscribeStream(sessionId: number, handler: StreamEventHandler): () => void {
  if (!isTauri) {
    // 纯浏览器 mock：无真实生成流，返回空取消函数。
    return () => {
      /* mock 环境无事件 */
    };
  }
  const unlisten = events.streamEvent.listen((event) => {
    const streamEvent = fromWireEvent(event.payload);
    if (streamEvent !== null && streamEvent.sessionId === sessionId) {
      handler(streamEvent);
    }
  });
  return () => {
    void unlisten.then((off) => off());
  };
}
