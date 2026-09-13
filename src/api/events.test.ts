/**
 * 事件层单测（TASK-006 验收 7）：走纯浏览器 mock 路径，不需 Tauri 运行时。
 * - `fromWireEvent`：防御式解析——未知 type 忽略（INT-001 只增不改）、done 补 thinkMs、
 *   字段缺失 / 类型不符 / 非对象输入一律拒收（返回 null）；
 * - `subscribeStream`：按 session_id 过滤（ADR-007 多路并发路由）——stub
 *   `__TAURI_INTERNALS__` 使运行环境探测为 Tauri 壳，并 mock 生成的 bindings 捕获
 *   监听回调，直接以 wire 负载驱动（INT-001 snake_case 形态）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  listeners: [] as Array<(event: unknown) => void>,
}));

vi.mock('./generated/bindings', () => ({
  events: {
    streamEvent: {
      listen: (cb: (event: unknown) => void) => {
        captured.listeners.push(cb);
        return Promise.resolve(() => {
          const index = captured.listeners.indexOf(cb);
          if (index >= 0) captured.listeners.splice(index, 1);
        });
      },
    },
  },
}));

/** 以「Tauri 壳内」环境重新载入 events 模块（isTauri 在模块求值时探测）。 */
async function importEvents() {
  vi.resetModules();
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  return import('./events');
}

/** 合法 wire trace 负载（透明化功能；camelCase call；sessionId 可空：历史起草调用遗留形态，防御性保留）。 */
function wireTrace(sessionId: number | null, overrides: Record<string, unknown> = {}) {
  return {
    type: 'trace',
    call: {
      id: 12,
      sessionId,
      kind: 'dialogue',
      model: 'mock-model',
      startedAt: 1_000,
      durationMs: 250,
      promptJson: '[{"role":"user","content":"你好"}]',
      responseText: '在。',
      reasoningText: null,
      toolCallsJson: null,
      promptTokens: 11,
      completionTokens: 7,
      status: 'ok',
      errorText: null,
      ...overrides,
    },
  };
}

describe('fromWireEvent 防御式解析（INT-001 / 验收 7）', () => {
  it('token/reasoning/done/error 合法负载 → camelCase 事件（done 补 thinkMs）', async () => {
    const { fromWireEvent } = await importEvents();
    expect(
      fromWireEvent({ type: 'token', session_id: 1, message_id: 7, text: '夜', reset: false }),
    ).toEqual({ type: 'token', sessionId: 1, messageId: 7, text: '夜', reset: false });
    expect(
      fromWireEvent({ type: 'reasoning', session_id: 1, message_id: 7, text: '想', reset: true }),
    ).toEqual({ type: 'reasoning', sessionId: 1, messageId: 7, text: '想', reset: true });
    expect(fromWireEvent({ type: 'done', session_id: 2, message_id: 8, think_ms: 1800 })).toEqual({
      type: 'done',
      sessionId: 2,
      messageId: 8,
      thinkMs: 1800,
    });
    expect(fromWireEvent({ type: 'done', session_id: 2, message_id: 8, think_ms: null })).toEqual({
      type: 'done',
      sessionId: 2,
      messageId: 8,
      thinkMs: null,
    });
    expect(
      fromWireEvent({ type: 'error', session_id: 3, message_id: 9, reason: '超时', interrupted: true }),
    ).toEqual({ type: 'error', sessionId: 3, messageId: 9, reason: '超时', interrupted: true });
  });

  it('未知 type 忽略（向前兼容，INT-001 只增不改）', async () => {
    const { fromWireEvent } = await importEvents();
    expect(fromWireEvent({ type: 'audio', session_id: 1, message_id: 7, text: 'x' })).toBeNull();
    expect(fromWireEvent({ type: undefined, session_id: 1, message_id: 7 })).toBeNull();
  });

  it('activity 合法负载 → camelCase 事件（Task-06 记忆探索透出）', async () => {
    const { fromWireEvent } = await importEvents();
    expect(
      fromWireEvent({ type: 'activity', session_id: 4, message_id: -3, phase: 'researchStart', detail: null }),
    ).toEqual({ type: 'activity', sessionId: 4, messageId: -3, phase: 'researchStart', detail: null });
    expect(
      fromWireEvent({
        type: 'activity',
        session_id: 4,
        message_id: -3,
        phase: 'toolCall',
        detail: 'search_memory(q=雨夜)',
      }),
    ).toEqual({
      type: 'activity',
      sessionId: 4,
      messageId: -3,
      phase: 'toolCall',
      detail: 'search_memory(q=雨夜)',
    });
  });

  it('activity 未知 phase 或 detail 类型不符 → 拒收（向前兼容不变量保持）', async () => {
    const { fromWireEvent } = await importEvents();
    // phase 未知值：未来新增阶段旧前端静默跳过（bindings ActivityPhase 注释契约）
    expect(
      fromWireEvent({ type: 'activity', session_id: 1, message_id: -3, phase: 'quantumLeap', detail: null }),
    ).toBeNull();
    expect(fromWireEvent({ type: 'activity', session_id: 1, message_id: -3, detail: null })).toBeNull();
    // detail 只允许 string | null
    expect(fromWireEvent({ type: 'activity', session_id: 1, message_id: -3, phase: 'toolCall', detail: 7 })).toBeNull();
  });

  // ---- 调用轨迹事件（透明化功能）----

  it('trace 合法负载 → { type: trace, call }（无顶层路由键，会话定位在 call 内）', async () => {
    const { fromWireEvent } = await importEvents();
    const wire = wireTrace(3) as { call: Record<string, unknown> };
    expect(fromWireEvent(wire)).toEqual({ type: 'trace', call: wire.call });
    // sessionId null（历史起草调用的无会话形态）同样合法透传。
    const noSession = wireTrace(null) as { call: Record<string, unknown> };
    expect(fromWireEvent(noSession)).toEqual({ type: 'trace', call: noSession.call });
  });

  it('trace 负载缺字段 / 字段类型不符 / kind·status 未知 → 拒收（防御式解析不变量保持）', async () => {
    const { fromWireEvent } = await importEvents();
    expect(fromWireEvent({ type: 'trace' })).toBeNull();
    expect(fromWireEvent({ type: 'trace', call: 'garbage' })).toBeNull();
    expect(fromWireEvent(wireTrace(3, { id: 'x' }))).toBeNull();
    expect(fromWireEvent(wireTrace(3, { kind: 'quantumLeap' }))).toBeNull();
    expect(fromWireEvent(wireTrace(3, { status: 'pending' }))).toBeNull();
    expect(fromWireEvent(wireTrace(3, { promptJson: 42 }))).toBeNull();
    expect(fromWireEvent(wireTrace(3, { promptTokens: '11' }))).toBeNull();
    expect(fromWireEvent(wireTrace(3, { sessionId: '3' }))).toBeNull();
  });

  it('缺路由键 / 字段类型不符 / 非对象输入一律拒收', async () => {
    const { fromWireEvent } = await importEvents();
    // 缺 session_id / message_id（路由键，INT-001 身份字段）
    expect(fromWireEvent({ type: 'token', message_id: 7, text: '夜', reset: false })).toBeNull();
    expect(fromWireEvent({ type: 'token', session_id: 1, text: '夜', reset: false })).toBeNull();
    // 字段类型不符
    expect(
      fromWireEvent({ type: 'token', session_id: '1', message_id: 7, text: '夜', reset: false }),
    ).toBeNull();
    expect(fromWireEvent({ type: 'token', session_id: 1, message_id: 7, text: 3, reset: false })).toBeNull();
    expect(fromWireEvent({ type: 'token', session_id: 1, message_id: 7, text: '夜', reset: 1 })).toBeNull();
    expect(fromWireEvent({ type: 'done', session_id: 1, message_id: 7, think_ms: 'x' })).toBeNull();
    expect(
      fromWireEvent({ type: 'error', session_id: 1, message_id: 7, reason: 'r', interrupted: 'yes' }),
    ).toBeNull();
    // 非对象输入
    expect(fromWireEvent(null)).toBeNull();
    expect(fromWireEvent('garbage')).toBeNull();
    expect(fromWireEvent(42)).toBeNull();
    expect(fromWireEvent(undefined)).toBeNull();
  });
});

describe('subscribeStream 按 session_id 过滤（ADR-007 / 验收 7）', () => {
  beforeEach(() => {
    captured.listeners.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function dispatch(payload: unknown): void {
    for (const listener of [...captured.listeners]) listener({ payload });
  }

  it('只把属于目标会话的事件交给 handler；其他会话 / 非法负载被过滤', async () => {
    const { subscribeStream } = await importEvents();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const offA = subscribeStream(1, handlerA);
    subscribeStream(2, handlerB);

    dispatch({ type: 'token', session_id: 1, message_id: -1, text: 'A', reset: false });
    dispatch({ type: 'token', session_id: 2, message_id: -2, text: 'B', reset: false });
    dispatch({ type: 'audio', session_id: 1, message_id: -1 }); // 未知类型：忽略
    dispatch({ type: 'done', session_id: 1, message_id: -1, think_ms: 100 });
    dispatch('garbage');

    expect(handlerA.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual(['token', 'done']);
    expect(handlerB.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual(['token']);

    offA();
    await Promise.resolve(); // 退订走 microtask
    dispatch({ type: 'token', session_id: 1, message_id: -1, text: 'A2', reset: false });
    expect(handlerA).toHaveBeenCalledTimes(2);
  });

  it('subscribeStream 不投递轨迹事件（语义另路，既有消费方穷尽 switch 不受影响）', async () => {
    const { subscribeStream } = await importEvents();
    const handlerA = vi.fn();
    subscribeStream(1, handlerA);

    dispatch(wireTrace(1)); // 即使会话匹配也不投递：轨迹经 subscribeTrace 消费
    dispatch({ type: 'token', session_id: 1, message_id: -1, text: 'A', reset: false });

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect((handlerA.mock.calls[0]![0] as { type: string }).type).toBe('token');
  });

  it('subscribeTrace 按 call.sessionId 路由；null（无会话调用）与非法负载被过滤', async () => {
    const { subscribeTrace } = await importEvents();
    const handler = vi.fn();
    subscribeTrace(1, handler);

    dispatch(wireTrace(1));
    dispatch(wireTrace(2)); // 其他会话：丢弃
    dispatch(wireTrace(null)); // 无会话调用：不属于任何会话，丢弃
    dispatch({ type: 'trace' }); // 非法负载：忽略
    dispatch({ type: 'token', session_id: 1, message_id: -1, text: 'A', reset: false }); // 非轨迹：忽略

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toMatchObject({ id: 12, sessionId: 1, kind: 'dialogue' });
  });
});
