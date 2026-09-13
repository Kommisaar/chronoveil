/**
 * INT-001 类型化流式事件通道（token / reasoning / done / error，携 session_id + message_id）。
 *
 * - wire 负载与 INT-001 一致（snake_case，type 判别），类型同源生成于
 *   `./generated/bindings.ts`（事件名 `stream-event`）；此处转换为前端 camelCase。
 * - token / reasoning 另携 `reset`（INT-001「只增不改」增字段，TASK-002）：true 表示
 *   重发尝试首事件，消费方应清空该 message_id 已累积内容后重新累积。
 * - activity（Task-06 记忆探索透出）：非流式生命周期事件，先于主对话首条
 *   reasoning / token 到达；phase 枚举同源自 `ActivityPhase`。
 * - 订阅按 session_id 过滤（多路并发路由，FR-007）；未知事件类型忽略（向前兼容）。
 * - trace（透明化功能，LLM 调用轨迹）：无顶层路由键，经 `subscribeTrace` 单独
 *   订阅（按 call.sessionId 过滤）——既有 subscribeStream 消费方不受新类型影响。
 */

import { events, type ActivityPhase, type LlmCallDto } from './generated/bindings';
import { isTauri } from './client';

/**
 * 前端形态的流式事件（wire → camelCase；done 补 thinkMs，FR-001）。
 *
 * 注意：本联合只含既有五态（token / reasoning / done / error / activity）——既有
 * 消费方（chat feature 的穷尽 switch）不因轨迹事件类型扩张；轨迹事件走独立的
 * [`TraceEvent`] / [`subscribeTrace`]（透明化功能，面板消费方接线时再按需并入）。
 */
export type StreamEvent =
  | { type: 'token'; sessionId: number; messageId: number; text: string; reset: boolean }
  | { type: 'reasoning'; sessionId: number; messageId: number; text: string; reset: boolean }
  | { type: 'done'; sessionId: number; messageId: number; thinkMs: number | null }
  | { type: 'error'; sessionId: number; messageId: number; reason: string; interrupted: boolean }
  | { type: 'activity'; sessionId: number; messageId: number; phase: ActivityPhase; detail: string | null };

/** LLM 调用轨迹事件（透明化功能）：无顶层路由键——会话定位在 call.sessionId（可空）。 */
export type TraceEvent = { type: 'trace'; call: LlmCallDto };

/** wire stream-event 全集：既有五态 + 轨迹（fromWireEvent 的返回形态）。 */
export type AnyStreamEvent = StreamEvent | TraceEvent;

/** wire activity 阶段合法值（与生成端 ActivityPhase 同源，Task-06）：未知值拒收（向前兼容）。 */
const ACTIVITY_PHASES = new Set<string>([
  'researchStart',
  'toolCall',
  'toolResult',
  'dossierReady',
  'researchSkipped',
]);

/** wire kind 合法值（与生成端 LlmCallKindDto 三值同源，透明化功能）。历史「draft」
 * （历法起草 2026-09-13 裁撤）不再合法：Rust from_db 判后端数据损坏，前端同口径拒收。 */
const LLM_CALL_KINDS = new Set<string>(['dialogue', 'explorer', 'director']);

/** wire status 合法值（ok | error）。 */
const LLM_CALL_STATUSES = new Set<string>(['ok', 'error']);

function isActivityPhase(value: unknown): value is ActivityPhase {
  return typeof value === 'string' && ACTIVITY_PHASES.has(value);
}

/** LlmCallDto 防御式校验（负载来自另一进程）：字段缺失 / 类型不符 / 未知 kind / status 拒收。 */
function isLlmCallDto(value: unknown): value is LlmCallDto {
  if (typeof value !== 'object' || value === null) return false;
  const call = value as Record<string, unknown>;
  return (
    asNumber(call.id) !== null &&
    (call.sessionId === null || asNumber(call.sessionId) !== null) &&
    typeof call.kind === 'string' &&
    LLM_CALL_KINDS.has(call.kind) &&
    typeof call.model === 'string' &&
    asNumber(call.startedAt) !== null &&
    asNumber(call.durationMs) !== null &&
    typeof call.promptJson === 'string' &&
    (call.responseText === null || typeof call.responseText === 'string') &&
    (call.reasoningText === null || typeof call.reasoningText === 'string') &&
    (call.toolCallsJson === null || typeof call.toolCallsJson === 'string') &&
    (call.promptTokens === null || asNumber(call.promptTokens) !== null) &&
    (call.completionTokens === null || asNumber(call.completionTokens) !== null) &&
    typeof call.status === 'string' &&
    LLM_CALL_STATUSES.has(call.status) &&
    (call.errorText === null || typeof call.errorText === 'string')
  );
}

export type StreamEventHandler = (event: StreamEvent) => void;

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * wire 事件 → 前端事件。防御式解析（负载来自另一进程，INT-001 只增不改）：
 * 字段缺失 / 类型不符 / 未知 type 一律返回 null，调用方忽略（向前兼容）。
 */
export function fromWireEvent(raw: unknown): AnyStreamEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const wire = raw as Record<string, unknown>;
  // 轨迹事件（透明化功能）先于公共路由键提取：它没有顶层 session_id / message_id，
  // 会话定位在 call.sessionId（可空：历史起草调用遗留形态，现行写入方恒有会话）。
  if (wire.type === 'trace') {
    return isLlmCallDto(wire.call) ? { type: 'trace', call: wire.call } : null;
  }
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
    case 'activity':
      return isActivityPhase(wire.phase) && (wire.detail === null || typeof wire.detail === 'string')
        ? { type: 'activity', sessionId, messageId, phase: wire.phase, detail: wire.detail }
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
    // 轨迹事件不投递给流式消费方（语义另路）：轨迹经 subscribeTrace 消费，
    // 既有 chat 消费方的穷尽 switch 不受新事件类型影响。
    if (streamEvent !== null && streamEvent.type !== 'trace' && streamEvent.sessionId === sessionId) {
      handler(streamEvent);
    }
  });
  return () => {
    void unlisten.then((off) => off());
  };
}

/**
 * 订阅某会话的 LLM 调用轨迹事件（透明化功能），返回取消函数。按 `call.sessionId`
 * 过滤——不匹配即丢弃；null（历史起草调用的无会话形态）不属于任何会话，同样不投递。
 * 与 `listLlmCalls` 同源同序：事件里的轨迹行已落库（携带库内 id，可与查询结果对齐）。
 */
export function subscribeTrace(sessionId: number, handler: (call: LlmCallDto) => void): () => void {
  if (!isTauri) {
    // 纯浏览器 mock：无真实生成流，无轨迹事件。
    return () => {
      /* mock 环境无事件 */
    };
  }
  const unlisten = events.streamEvent.listen((event) => {
    const streamEvent = fromWireEvent(event.payload);
    if (streamEvent !== null && streamEvent.type === 'trace' && streamEvent.call.sessionId === sessionId) {
      handler(streamEvent.call);
    }
  });
  return () => {
    void unlisten.then((off) => off());
  };
}

/**
 * 应用级轨迹订阅（不过滤会话）：消费方（账本面板的 streamHub 桥）自行按
 * `call.sessionId` 过滤当前会话。与 [`subscribeTrace`] 的差别仅在无会话过滤——
 * null（无会话调用）也投递，消费方不需要时可忽略。
 */
export function subscribeTraces(handler: (call: LlmCallDto) => void): () => void {
  if (!isTauri) {
    // 纯浏览器 mock：无真实生成流，无轨迹事件。
    return () => {
      /* mock 环境无事件 */
    };
  }
  const unlisten = events.streamEvent.listen((event) => {
    const streamEvent = fromWireEvent(event.payload);
    if (streamEvent !== null && streamEvent.type === 'trace') {
      handler(streamEvent.call);
    }
  });
  return () => {
    void unlisten.then((off) => off());
  };
}
