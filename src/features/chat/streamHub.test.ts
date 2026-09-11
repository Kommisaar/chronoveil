/**
 * streamHub 单测（TASK-006 / FR-007 / ADR-007）：流状态机、终态回调、多会话
 * 隔离与订阅面（subscribe / getVersion / onEvent）。
 *
 * hub 是模块级单例：每个用例 vi.resetModules() + 动态 import 取全新实例，
 * 用例间零共享状态（比手工清理更稳健）。api/events 整体 vi.mock：捕获
 * subscribeStream 注册的 handler，测试直接投递合成 StreamEvent 驱动
 * （封闭，不依赖 Tauri）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent, StreamEventHandler } from '../../api/events';
import type { ActivityPhase } from '../../api/generated/bindings';
import type { StreamState } from './streamHub';

const mocks = vi.hoisted(() => ({
  subscribeStream: vi.fn(),
}));

vi.mock('../../api/events', () => ({
  subscribeStream: mocks.subscribeStream,
}));

/** subscribeStream mock 捕获的每会话 handler：测试用它直接投递合成事件 */
const handlers = new Map<number, StreamEventHandler>();

type StreamHubModule = typeof import('./streamHub');

/** 每个用例独立的全新 hub 模块（resetModules 后动态 import） */
let mod: StreamHubModule;

beforeEach(async () => {
  vi.clearAllMocks();
  handlers.clear();
  mocks.subscribeStream.mockImplementation((sessionId: number, handler: StreamEventHandler) => {
    handlers.set(sessionId, handler);
    return () => {
      handlers.delete(sessionId);
    };
  });
  vi.resetModules();
  mod = await import('./streamHub');
});

// —— 合成事件构造（形状对齐 src/api/events.ts 的 StreamEvent）——
const tok = (sessionId: number, text: string, messageId = -1, reset = false): StreamEvent => ({
  type: 'token',
  sessionId,
  messageId,
  text,
  reset,
});
const think = (sessionId: number, text: string, messageId = -1, reset = false): StreamEvent => ({
  type: 'reasoning',
  sessionId,
  messageId,
  text,
  reset,
});
const fin = (sessionId: number, thinkMs: number | null = null): StreamEvent => ({
  type: 'done',
  sessionId,
  messageId: -1,
  thinkMs,
});
const err = (sessionId: number, reason: string, interrupted = false): StreamEvent => ({
  type: 'error',
  sessionId,
  messageId: -1,
  reason,
  interrupted,
});
const act = (sessionId: number, phase: ActivityPhase, detail: string | null, messageId = -1): StreamEvent => ({
  type: 'activity',
  sessionId,
  messageId,
  phase,
  detail,
});

function emit(sessionId: number, event: StreamEvent): void {
  const handler = handlers.get(sessionId);
  if (!handler) throw new Error(`会话 ${sessionId} 未登记订阅，无法投递事件`);
  handler(event);
}

function begin(sessionId: number): void {
  mod.streamHub.begin(sessionId);
}

/** 断言版 stateOf：会话应有流状态，否则用例自身失败 */
function stateOf(sessionId: number): StreamState {
  const state = mod.streamHub.stateOf(sessionId);
  if (!state) throw new Error(`会话 ${sessionId} 应有流状态`);
  return state;
}

describe('begin()：订阅登记与流状态重置', () => {
  it('begin 登记按会话路由的订阅，并给出全新流状态', () => {
    begin(1);
    expect(mocks.subscribeStream).toHaveBeenCalledTimes(1);
    expect(mocks.subscribeStream).toHaveBeenCalledWith(1, expect.any(Function));
    expect(stateOf(1)).toEqual({
      sessionId: 1,
      messageId: null,
      content: '',
      reasoning: '',
      status: 'streaming',
      errorReason: null,
      activity: [],
      activityYielded: false,
    });
    expect(mod.streamHub.stateOf(null)).toBeNull();
    expect(mod.streamHub.stateOf(42)).toBeNull(); // 未 begin 的会话无状态
  });

  it('token / reasoning 增量累积，messageId 随最新事件更新', () => {
    begin(1);
    emit(1, tok(1, '你', -7));
    emit(1, tok(1, '好', -7));
    emit(1, think(1, '思', -8));
    emit(1, think(1, '考', -8));
    const state = stateOf(1);
    expect(state.content).toBe('你好');
    expect(state.reasoning).toBe('思考');
    expect(state.messageId).toBe(-8); // reasoning 后到也更新
    expect(state.status).toBe('streaming');
    expect(state.errorReason).toBeNull();
  });

  it('重复 begin 不重复订阅，流状态从头重置（重新生成场景）', () => {
    begin(1);
    emit(1, tok(1, '上一轮'));
    begin(1);
    expect(mocks.subscribeStream).toHaveBeenCalledTimes(1); // 订阅复用，不重复登记
    const state = stateOf(1);
    expect(state.content).toBe('');
    expect(state.reasoning).toBe('');
    expect(state.messageId).toBeNull();
    expect(state.status).toBe('streaming');
    // 原订阅仍在路由：后续事件照常累积
    emit(1, tok(1, '新'));
    expect(stateOf(1).content).toBe('新');
  });

  it('reset 标志清空已累积的 content 与 reasoning（TASK-002 重发重来）', () => {
    begin(1);
    emit(1, tok(1, '旧正文'));
    emit(1, think(1, '旧思考'));
    emit(1, tok(1, '重发正文', -9, true));
    let state = stateOf(1);
    expect(state.content).toBe('重发正文');
    expect(state.reasoning).toBe('');
    expect(state.messageId).toBe(-9);

    // reasoning 携 reset 同样双清
    begin(2);
    emit(2, tok(2, '正文'));
    emit(2, think(2, '重发思考', -5, true));
    state = stateOf(2);
    expect(state.content).toBe('');
    expect(state.reasoning).toBe('重发思考');
  });
});

describe('markStopping()：仅 streaming 可转入 stopping', () => {
  it('streaming → stopping', () => {
    begin(1);
    emit(1, tok(1, '生成中'));
    mod.streamHub.markStopping(1);
    expect(stateOf(1).status).toBe('stopping');
  });

  it('done / error 状态与未知会话不被 markStopping 改动', () => {
    begin(1);
    mod.streamHub.markStopping(1);
    emit(1, fin(1));
    mod.streamHub.markStopping(1); // 终态后不得改写
    expect(stateOf(1).status).toBe('done');

    begin(2);
    emit(2, err(2, 'boom'));
    mod.streamHub.markStopping(2);
    expect(stateOf(2).status).toBe('error');

    mod.streamHub.markStopping(3); // 从未 begin：静默不动
    expect(mod.streamHub.stateOf(3)).toBeNull();
  });

  it('非 streaming 状态下 markStopping 不通知 store（守卫拦下）', () => {
    const listener = vi.fn();
    const off = mod.streamHub.subscribe(listener);
    begin(1);
    listener.mockClear();
    mod.streamHub.markStopping(1);
    mod.streamHub.markStopping(1); // 已是 stopping：幂等，不重复通知
    expect(listener).toHaveBeenCalledTimes(1);
    emit(1, fin(1));
    expect(listener).toHaveBeenCalledTimes(2);
    mod.streamHub.markStopping(1); // done：不动、不通知
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });
});

describe('终态 done / error 与 onTerminal', () => {
  it('done：status 收束、内容保留、终态监听者收到会话 id', () => {
    const onTerminal = vi.fn();
    const offT = mod.streamHub.onTerminal(onTerminal);
    begin(1);
    emit(1, tok(1, '最终答案'));
    emit(1, fin(1, 120));
    const state = stateOf(1);
    expect(state.status).toBe('done');
    expect(state.errorReason).toBeNull();
    expect(state.content).toBe('最终答案');
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(1);
    offT();
  });

  it('error：errorReason 记录原因；cancelled 是稳定取消标记', () => {
    const onTerminal = vi.fn();
    const offT = mod.streamHub.onTerminal(onTerminal);
    begin(1);
    emit(1, err(1, 'provider 超时'));
    begin(2);
    emit(2, err(2, mod.CANCEL_REASON, true));
    expect(stateOf(1).status).toBe('error');
    expect(stateOf(1).errorReason).toBe('provider 超时');
    // 用户主动取消：稳定的 'cancelled' 标记（UI 不作为失败提示）
    expect(stateOf(2).errorReason).toBe('cancelled');
    expect(onTerminal).toHaveBeenCalledTimes(2); // 每个终态各通知一次
    offT();
  });

  it('onTerminal 退订后不再通知；token / reasoning 增量不触发终态回调', () => {
    const onTerminal = vi.fn();
    const offT = mod.streamHub.onTerminal(onTerminal);
    offT();
    begin(1);
    emit(1, tok(1, '增量'));
    emit(1, think(1, '思考'));
    emit(1, fin(1));
    expect(onTerminal).not.toHaveBeenCalled();
  });
});

describe('end()：收尾摘除', () => {
  it('end 摘订阅、删状态、不触发终态回调；迟到事件被忽略；再 begin 重新订阅', () => {
    const onTerminal = vi.fn();
    mod.streamHub.onTerminal(onTerminal);
    begin(1);
    emit(1, tok(1, '已累积'));
    const lateHandler = handlers.get(1);

    mod.streamHub.end(1);
    expect(handlers.has(1)).toBe(false); // 路由订阅已摘
    expect(mod.streamHub.stateOf(1)).toBeNull(); // 流状态已删
    expect(onTerminal).not.toHaveBeenCalled(); // end 不触发终态回调
    const versionAfterEnd = mod.streamHub.getVersion(); // end 删状态本身会 bump 版本

    // end 之后的迟到事件（重试尾巴等）：handle 直接返回，无任何副作用
    expect(() => lateHandler?.(tok(1, '迟到'))).not.toThrow();
    expect(mod.streamHub.stateOf(1)).toBeNull();
    expect(mod.streamHub.getVersion()).toBe(versionAfterEnd); // 迟到事件未通知 store

    // 重新 begin：重新登记路由订阅
    begin(1);
    expect(mocks.subscribeStream).toHaveBeenCalledTimes(2);
    expect(handlers.has(1)).toBe(true);
  });

  it('end 未知会话不抛', () => {
    expect(() => mod.streamHub.end(99)).not.toThrow();
  });
});

describe('多会话隔离（FR-007 多路并发）', () => {
  it('两会话各自状态互不串扰，end 其一不影响另一', () => {
    begin(1);
    begin(2);
    emit(1, tok(1, '甲的正文', -11));
    emit(2, tok(2, '乙的正文', -22));
    emit(1, think(1, '甲的思考', -11));
    expect(stateOf(1).content).toBe('甲的正文');
    expect(stateOf(1).reasoning).toBe('甲的思考');
    expect(stateOf(1).messageId).toBe(-11);
    expect(stateOf(2).content).toBe('乙的正文');
    expect(stateOf(2).reasoning).toBe('');
    expect(stateOf(2).messageId).toBe(-22);

    // 终态各归各：甲 done 不波及乙，乙 error 不波及甲
    emit(1, fin(1));
    emit(2, err(2, 'boom'));
    expect(stateOf(1).status).toBe('done');
    expect(stateOf(2).status).toBe('error');

    // end 甲：乙的订阅与状态原样保留
    mod.streamHub.end(1);
    expect(mod.streamHub.stateOf(1)).toBeNull();
    expect(stateOf(2).status).toBe('error');
    expect(handlers.has(1)).toBe(false);
    expect(handlers.has(2)).toBe(true);
  });
});

describe('幕后活动轨迹（Task-07 活动条数据源）', () => {
  it('activity 事件按到达顺序累积为轨迹，不改状态机与 messageId', () => {
    begin(1);
    emit(1, act(1, 'researchStart', null, -3));
    emit(1, act(1, 'toolCall', 'search_memory(q=雨夜)', -3));
    emit(1, act(1, 'toolResult', '命中 3 条', -3));
    const state = stateOf(1);
    expect(state.activity.map((s) => s.phase)).toEqual(['researchStart', 'toolCall', 'toolResult']);
    expect(state.activity.map((s) => s.detail)).toEqual([null, 'search_memory(q=雨夜)', '命中 3 条']);
    // 只追加轨迹：非流式语义，不触碰 token / reasoning / 终态状态机
    expect(state.messageId).toBeNull();
    expect(state.content).toBe('');
    expect(state.reasoning).toBe('');
    expect(state.status).toBe('streaming');
    expect(state.activityYielded).toBe(false);
  });

  it('首个 token / reasoning 置让位标记；reset 重发不回退（探索不重跑）', () => {
    begin(1);
    emit(1, act(1, 'researchStart', null));
    emit(1, think(1, '想想'));
    expect(stateOf(1).activityYielded).toBe(true);

    begin(2);
    emit(2, act(2, 'researchStart', null));
    emit(2, tok(2, '正文'));
    emit(2, tok(2, '重发正文', -9, true)); // reset 双清内容，但让位标记不回退
    const state = stateOf(2);
    expect(state.activityYielded).toBe(true);
    expect(state.content).toBe('重发正文');
    expect(state.activity).toHaveLength(1); // 轨迹本身不受 reset 影响
  });

  it('done / error 终态清空轨迹；重新 begin 从头重置', () => {
    begin(1);
    emit(1, act(1, 'researchStart', null));
    emit(1, act(1, 'dossierReady', '卷宗前若干字'));
    emit(1, tok(1, '正文'));
    emit(1, fin(1, 10));
    expect(stateOf(1).activity).toEqual([]); // 终态清空：回看入口随收尾消失

    begin(2);
    emit(2, act(2, 'researchStart', null));
    emit(2, err(2, 'boom'));
    expect(stateOf(2).activity).toEqual([]);

    // 重新生成：begin 给出全新轨迹与让位标记
    begin(1);
    expect(stateOf(1).activity).toEqual([]);
    expect(stateOf(1).activityYielded).toBe(false);
  });
});

describe('订阅面：subscribe / getVersion / onEvent', () => {
  it('subscribe 收到每次状态变更通知，getVersion 单调递增；退订后静默', () => {
    const listener = vi.fn();
    const off = mod.streamHub.subscribe(listener);
    expect(mod.streamHub.getVersion()).toBe(0);
    begin(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(mod.streamHub.getVersion()).toBe(1);
    emit(1, tok(1, '字'));
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    emit(1, fin(1));
    expect(listener).toHaveBeenCalledTimes(2); // 退订后不再通知
    expect(mod.streamHub.getVersion()).toBe(3); // 版本仍随状态推进（useSyncExternalStore 面语义）
  });

  it('onEvent 按会话派发原始事件，退订即停；多监听者互不影响', () => {
    begin(1);
    begin(2);
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    const offA = mod.streamHub.onEvent(1, listenerA);
    mod.streamHub.onEvent(1, listenerB);

    const event = tok(1, '甲');
    emit(1, event);
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerA).toHaveBeenCalledWith(event); // 原始事件对象原样透传（渲染引擎驱动依赖）
    expect(listenerB).toHaveBeenCalledTimes(1);

    emit(2, tok(2, '乙')); // 其他会话的事件不串
    expect(listenerA).toHaveBeenCalledTimes(1);

    offA();
    emit(1, fin(1)); // done 也派发给在册监听者
    expect(listenerA).toHaveBeenCalledTimes(1); // 已退订
    expect(listenerB).toHaveBeenCalledTimes(2);
  });
});
