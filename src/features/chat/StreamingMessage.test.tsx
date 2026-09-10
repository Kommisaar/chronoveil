/**
 * StreamingMessage 单测（TASK-006 / FR-001 / FR-003 / ADR-007）：流式行组件
 * 把 hub 流状态接到渲染引擎的逐分支行为——
 * - 挂载回放积压（正文同步上屏 / 思考胶囊重建）；
 * - 流式中事件驱动引擎（reasoning → 收拢 → 正文；reset 从零重来）；
 * - 终态收尾（done 排空定格后 onSettled 恰一次；error / 取消立即冻结）；
 * - stopping 本地静止不收尾，等取消终态事件；
 * - 后台已终态重挂：无演出直接收尾；
 * - 卸载：摘订阅停引擎，hub 继续独立累积（切走不取消）。
 *
 * 引擎为真实 DOM 实现，jsdom 下直接断言容器内容；api/events 整体 vi.mock，
 * 经 subscribeStream 捕获的 handler 投递合成事件（封闭，不依赖 Tauri）。
 * hub 是模块级单例：每用例独立会话 id，afterEach 统一 end 清理（同
 * sessionActivity.test.tsx 的卫生策略）。
 */
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, render, type RenderResult } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { StreamEvent, StreamEventHandler } from '../../api/events';
import { StreamingMessage, type RendererTuning } from './StreamingMessage';
import { CANCEL_REASON, streamHub, type StreamState } from './streamHub';

const mocks = vi.hoisted(() => ({
  subscribeStream: vi.fn(),
}));

vi.mock('../../api/events', () => ({
  subscribeStream: mocks.subscribeStream,
}));

/** subscribeStream mock 捕获的每会话 handler：测试用它直接投递合成事件 */
const handlers = new Map<number, StreamEventHandler>();

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  mocks.subscribeStream.mockImplementation((sessionId: number, handler: StreamEventHandler) => {
    handlers.set(sessionId, handler);
    return () => {
      handlers.delete(sessionId);
    };
  });
});

afterEach(() => {
  cleanup();
  // hub 是模块级单例：摘掉本文件登记的路由订阅与流状态，避免跨用例泄漏
  for (const sessionId of [...handlers.keys()]) streamHub.end(sessionId);
});

// —— 合成事件构造（形状对齐 src/api/events.ts 的 StreamEvent）——
const tok = (sessionId: number, text: string, messageId = -1, reset = false): StreamEvent => ({
  type: 'token',
  sessionId,
  messageId,
  text,
  reset,
});
const think = (sessionId: number, text: string, messageId = -1): StreamEvent => ({
  type: 'reasoning',
  sessionId,
  messageId,
  text,
  reset: false,
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

function emit(sessionId: number, event: StreamEvent): void {
  const handler = handlers.get(sessionId);
  if (!handler) throw new Error(`会话 ${sessionId} 未登记订阅，无法投递事件`);
  handler(event);
}

/** begin 会话并返回流状态对象（组件以同一引用接收，markStopping 原地改 status） */
function beginSession(sessionId: number): StreamState {
  streamHub.begin(sessionId);
  const state = streamHub.stateOf(sessionId);
  if (!state) throw new Error('begin 后流状态应存在');
  return state;
}

const SPEAKER = '织星者';

function messageTree(state: StreamState, onSettled: () => void): ReactElement {
  return (
    <FluentProvider theme={webLightTheme}>
      {/* msPerChar 压到下限附近，缩短节奏队列排空耗时 */}
      <StreamingMessage state={state} speaker={SPEAKER} tuning={{ msPerChar: 10 }} onSettled={onSettled} />
    </FluentProvider>
  );
}

function mountMessage(state: StreamState): { view: RenderResult; onSettled: ReturnType<typeof vi.fn> } {
  const onSettled = vi.fn();
  const view = render(messageTree(state, onSettled));
  return { view, onSettled };
}

/** 容器内已上屏正文（tok 文本按 DOM 顺序拼接） */
function bodyText(view: RenderResult): string {
  return [...view.container.querySelectorAll('.tok')].map((t) => t.textContent).join('');
}

describe('挂载回放积压（切回会话重挂）', () => {
  it('积压正文同步上屏（不经节奏队列），不触发收尾', () => {
    const state = beginSession(1);
    emit(1, tok(1, '积压的第一段\n\n第二段', -11));
    const { view, onSettled } = mountMessage(state);

    // replayInstant 同步渲染：无需等待节奏 tick
    const paras = view.container.querySelectorAll('.para');
    expect(paras).toHaveLength(2);
    expect(paras[0]?.textContent).toBe('积压的第一段');
    expect(paras[1]?.textContent).toBe('第二段');
    expect(view.container.textContent).toContain(SPEAKER); // 说话人头部
    // tuning 未给 style → 引擎默认 fade（非法/缺省回落，FR-005）
    expect(view.container.querySelector('[data-anim]')?.getAttribute('data-anim')).toBe('fade');
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('仅思考积压重挂：重建思考胶囊（快滚追上积压）', () => {
    const state = beginSession(2);
    emit(2, think(2, '积压的思考'));
    const { view, onSettled } = mountMessage(state);
    expect(view.container.querySelector('.think')).not.toBeNull();
    expect(view.container.querySelectorAll('.tok')).toHaveLength(0); // 正文未开演
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('积压回放后新 token 走节奏队列，done 排空定格后 onSettled 恰一次', async () => {
    const state = beginSession(3);
    emit(3, tok(3, '回放'));
    const { view, onSettled } = mountMessage(state);

    emit(3, tok(3, '新词'));
    emit(3, fin(3, 42));
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));

    expect(bodyText(view)).toBe('回放新词');
    expect(view.container.querySelector('.stream-cursor')).toBeNull(); // 定格摘光标
    expect(onSettled).toHaveBeenCalledTimes(1); // 收尾闸门：不重复
  });
});

describe('流式中事件驱动引擎', () => {
  it('reasoning 先行：思考胶囊流式，正文 token 显式收拢开演，done 收尾', async () => {
    const state = beginSession(4);
    const { view, onSettled } = mountMessage(state);

    emit(4, think(4, '想一想'));
    expect(view.container.querySelector('.think')).not.toBeNull(); // 胶囊同步建立

    emit(4, tok(4, '答')); // 思考通道收拢 → 自动开演正文
    emit(4, fin(4, 100));
    // 收拢链路（落定 380ms → 收拢 → 520ms 开演）走真实时序
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1), { timeout: 4000 });

    expect(view.container.querySelector('.think.done.collapsed')).not.toBeNull(); // 收拢胶囊保留
    expect(bodyText(view)).toBe('答');
  });

  it('done 落在思考中（无正文）：等胶囊收拢动画走完再异步收尾，胶囊保留（发现 4 修复）', async () => {
    const state = beginSession(5);
    const { view, onSettled } = mountMessage(state);

    emit(5, think(5, '没有正文的思考'));
    expect(view.container.querySelector('.think')).not.toBeNull();

    emit(5, fin(5, 0));
    // 引擎 finish() 在思考通道活跃时不再同步收尾（旧行为：胶囊被瞬时拆除）：
    // 胶囊仍在且未收拢，等落定 380ms + 收拢，开演后 tick 排空才 onFinish → onSettled
    expect(onSettled).not.toHaveBeenCalled();
    expect(view.container.querySelector('.think')).not.toBeNull();
    expect(view.container.querySelector('.think.done')).toBeNull(); // 落定中，未收拢

    // 收拢链路（落定 380ms → 收拢 → 520ms 开演）走真实时序，随后排空收尾
    await vi.waitFor(
      () => expect(view.container.querySelector('.think.done.collapsed')).not.toBeNull(),
      { timeout: 4000 },
    );
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(view.container.querySelector('.think.done.collapsed')).not.toBeNull(); // 胶囊保留可回看
  });

  it('reset 事件：清空该回合已排队内容，从零重来（TASK-002）', async () => {
    const state = beginSession(6);
    const { view, onSettled } = mountMessage(state);

    emit(6, tok(6, '第一次尝试'));
    emit(6, tok(6, '重试', -2, true)); // 重发尝试首事件
    emit(6, fin(6, null));
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(bodyText(view)).toBe('重试'); // 旧内容不残留
  });
});

describe('终态与静止（FR-001 界面立即静止）', () => {
  it('error：立即冻结（清队列保已上屏），onSettled 恰一次', () => {
    const state = beginSession(7);
    emit(7, tok(7, '半条'));
    const { view, onSettled } = mountMessage(state);

    emit(7, tok(7, '没来得及上屏的后续'));
    emit(7, err(7, 'provider 崩了'));
    expect(bodyText(view)).toBe('半条'); // 冻结：排队内容不播
    expect(view.container.querySelector('.stream-cursor')).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('取消终态（CANCEL_REASON）同样冻结收尾：驱动层不把取消当特殊失败', () => {
    const state = beginSession(8);
    emit(8, tok(8, '取消前已上屏'));
    const { view, onSettled } = mountMessage(state);

    emit(8, tok(8, '取消后排队'));
    emit(8, err(8, CANCEL_REASON, true));
    expect(bodyText(view)).toBe('取消前已上屏');
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('stopping：立即冻结不收尾，随后取消终态事件触发收尾', async () => {
    const state = beginSession(9);
    emit(9, tok(9, '已上屏'));
    const { view, onSettled } = mountMessage(state);

    emit(9, tok(9, '排队未上屏'));
    // 用户点停：hub 状态原地改写，父组件随 store 版本重渲染传入同一状态对象
    streamHub.markStopping(9);
    view.rerender(messageTree(state, onSettled));

    expect(view.container.querySelector('.stream-cursor')).toBeNull(); // 冻结摘光标
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(bodyText(view)).toBe('已上屏'); // 排队内容不再播出
    expect(onSettled).not.toHaveBeenCalled(); // 静止 ≠ 收尾：等取消终态

    emit(9, err(9, CANCEL_REASON, true));
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(bodyText(view)).toBe('已上屏');
  });
});

describe('后台已终态重挂（切回会话）', () => {
  it('done 状态挂载：无演出直接收尾，不建渲染器', () => {
    const state = beginSession(10);
    emit(10, tok(10, '后台完成的正文'));
    emit(10, fin(10, 30));
    expect(state.status).toBe('done');

    const { view, onSettled } = mountMessage(state);
    expect(onSettled).toHaveBeenCalledTimes(1); // 挂载即收尾（重拉列表替换流式行）
    expect(view.container.querySelector('.tok')).toBeNull(); // 不回放
    expect(view.container.querySelector('[data-anim]')).toBeNull(); // 未创建渲染器
  });

  it('error 状态挂载：直接收尾且只一次（挂载 effect 与 status effect 不重复）', () => {
    const state = beginSession(11);
    emit(11, err(11, '后台失败'));
    const { view, onSettled } = mountMessage(state);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[data-anim]')).toBeNull();
  });
});

describe('卸载与 hub 解耦（切走不取消，ADR-007）', () => {
  it('卸载：摘事件订阅、停引擎；hub 仍独立累积并收束终态', () => {
    const state = beginSession(12);
    emit(12, tok(12, '正文'));
    const { view, onSettled } = mountMessage(state);

    view.unmount();
    expect(() => {
      emit(12, tok(12, '迟到'));
      emit(12, fin(12, 5));
    }).not.toThrow();

    expect(onSettled).not.toHaveBeenCalled(); // 卸载后不再驱动/收尾
    expect(streamHub.stateOf(12)?.content).toBe('正文迟到'); // hub 照常累积
    expect(streamHub.stateOf(12)?.status).toBe('done');
  });
});

describe('tuning 中途热更（TASK-12 / 审计问题 8）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function treeWithTuning(state: StreamState, tuning: RendererTuning, onSettled: () => void): ReactElement {
    return (
      <FluentProvider theme={webLightTheme}>
        <StreamingMessage state={state} speaker={SPEAKER} tuning={tuning} onSettled={onSettled} />
      </FluentProvider>
    );
  }

  it('风格中途变化：data-anim 即时切换，已上屏内容不重播不丢失', () => {
    const state = beginSession(20);
    emit(20, tok(20, '已上屏的积压')); // 挂载时经 replayInstant 同步上屏
    const onSettled = vi.fn();
    const view = render(treeWithTuning(state, { style: 'fade', msPerChar: 10 }, onSettled));
    expect(view.container.querySelector('[data-anim]')?.getAttribute('data-anim')).toBe('fade');

    view.rerender(treeWithTuning(state, { style: 'rise', msPerChar: 10 }, onSettled));
    expect(view.container.querySelector('[data-anim]')?.getAttribute('data-anim')).toBe('rise');
    expect(bodyText(view)).toBe('已上屏的积压'); // 不重播不丢失
  });

  it('非法风格串不剥离 data-anim（setStyle 前先过注册表守卫）', () => {
    const state = beginSession(21);
    const onSettled = vi.fn();
    const view = render(treeWithTuning(state, { style: 'fade' }, onSettled));

    view.rerender(treeWithTuning(state, { style: 'not-a-style' }, onSettled));
    // 引擎 setStyle 不校验：组件侧守卫拦下，保持挂载时的回落风格不被剥掉
    expect(view.container.querySelector('[data-anim]')?.getAttribute('data-anim')).toBe('fade');
  });

  it('动效时长中途变化：容器内联 --dur 即时更新', () => {
    const state = beginSession(22);
    const onSettled = vi.fn();
    const view = render(treeWithTuning(state, { durationMs: 600 }, onSettled));
    expect(view.container.querySelector<HTMLElement>('[data-anim]')?.style.getPropertyValue('--dur')).toBe('600ms');

    view.rerender(treeWithTuning(state, { durationMs: 900 }, onSettled));
    expect(view.container.querySelector<HTMLElement>('[data-anim]')?.style.getPropertyValue('--dur')).toBe('900ms');
  });

  it('节奏中途变化：下一拍按新 ms/字消费，排空定格收尾（fake timers）', () => {
    // toFake 列表同 engine/index.test.ts 思考用例的 idiom（含 performance，
    // 信用钟按 performance.now 记账）
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    const state = beginSession(23);
    const onSettled = vi.fn();
    // 慢节奏 160ms/字开演
    const view = render(treeWithTuning(state, { msPerChar: 160, punctPause: false }, onSettled));
    emit(23, tok(23, '一二三四五六七八九十')); // beginTurn 开演，16ms tick 消费

    vi.advanceTimersByTime(320); // 慢节奏下仅约 2 个粒度块（4 字）上屏
    expect(bodyText(view)).toBe('一二三四');

    // 热更到 10ms/字：余下内容迅速排空，done 定格收尾
    view.rerender(treeWithTuning(state, { msPerChar: 10, punctPause: false }, onSettled));
    emit(23, fin(23, null));
    vi.advanceTimersByTime(200);
    expect(bodyText(view)).toBe('一二三四五六七八九十');
    expect(view.container.querySelector('.stream-cursor')).toBeNull(); // 定格摘光标
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});

describe('流式容器排版（TASK-12 / 审计问题 3）', () => {
  /** 汇集 jsdom 已注入的全部 CSS 文本（Griffel 经 style 元素 insertRule 注入） */
  function injectedCssText(): string {
    const parts: string[] = [];
    for (const el of [...document.head.querySelectorAll('style')]) parts.push(el.textContent ?? '');
    for (const sheet of [...document.styleSheets]) {
      try {
        parts.push([...sheet.cssRules].map((rule) => rule.cssText).join('\n'));
      } catch {
        // 不可读的样式表（本仓无跨源，理论不可达）：跳过
      }
    }
    return parts.join('\n');
  }

  it('body 样式带 white-space:pre-wrap：解析器保留的块内单换行不被折叠', () => {
    const state = beginSession(30);
    render(messageTree(state, vi.fn()));
    expect(injectedCssText()).toMatch(/white-space:\s*pre-wrap/);
  });
});
