// useRevealOnScroll 行为补盲（审计盲区：此前仅有 motion.test.ts 的源码
// 文本断言，无直接行为测试）。从消费契约出发（CharacterCollectCard /
// WorldGalleryCard 等消费方：revealDelay === undefined → 透明占位，
// 数字 → 动画批内错峰 delay），
// 全部断言公开行为而非内部实现：登记即订阅、IO 判交按批错峰下发、
// 首屏手动判交、批内封顶、resetKey 重播、仅 count 增长只播新元素、
// 节点更换反注册、卸载 disconnect。
// 桩与环境说明：
// - jsdom 无布局：getBoundingClientRect 全零 → inViewport 恒 false，
//   默认全走「折叠线以下」IO 路径；需要「首屏」语义的用例按 data-index
//   桩矩形（视口基准 jsdom 默认 1024×768）。
// - IntersectionObserver 用可编程 fake 桩（jsdom 缺省无此 API）：
//   observe/unobserve/disconnect 只记录调用，判交回调由用例显式
//   trigger 驱动——时序可控收敛，不靠真实 IO 的异步调度碰运气；条目
//   仅携带 hook 消费的 target / isIntersecting 两字段。
// - 错峰是数据载荷（reveal 表里的 ms 数值，动画端才消费），不是运行时
//   定时器——无需 fake timers，直接断言 DOM 文本即可。
// - 无样式表扫描断言（不遍历 document.styleSheets/cssRules），无需登记
//   vitest.config.ts 的 isolated-styles 组，按默认落入 shared 组。
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENTER_STAGGER_CAP_MS, ENTER_STAGGER_MS } from './motion';
import { useRevealOnScroll } from './useRevealOnScroll';

/** 最小判交条目：hook 只消费 target / isIntersecting 两字段。 */
interface FakeEntry {
  target: Element;
  isIntersecting: boolean;
}

/**
 * 可编程 IntersectionObserver 桩：observe/unobserve/disconnect 仅记录
 * 调用，判交通知由用例显式 trigger；threshold 等构造参数不在此锁值
 * （属实现细节，行为测试不锁）。
 */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed: Element[] = [];
  readonly unobserved: Element[] = [];
  disconnectCount = 0;
  private readonly callback: (entries: FakeEntry[]) => void;

  constructor(callback: (entries: FakeEntry[]) => void) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(el: Element): void {
    this.observed.push(el);
  }

  unobserve(el: Element): void {
    this.unobserved.push(el);
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }

  /** 显式驱动一次判交通知（真实 IO 为异步派发，时序由用例掌握）。 */
  trigger(entries: FakeEntry[]): void {
    this.callback(entries);
  }
}

/** 把 fake 构造器顶到全局：hook 侧的 typeof 探测与 new 走同一全局。 */
function stubIO(): void {
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
}

/** 按 data-index 桩矩形：谓词为真判视口内，否则折叠线以下（top=5000）。 */
function stubRects(inViewport: (index: number) => boolean): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function rect(this: Element): DOMRect {
      const index = Number(this.getAttribute('data-index'));
      // DOMRect(x, y, w, h)：视口内矩形在 jsdom 默认视口（1024×768）内；
      // 折叠线以下 top=5000 使 inViewport 的 top < innerHeight 不成立。
      return inViewport(index) ? new DOMRect(0, 0, 100, 100) : new DOMRect(0, 5000, 100, 100);
    },
  );
}

interface RevealGridProps {
  count: number;
  resetKey: string;
  /** 变更即换节点（key 变化重挂：旧 ref(null)、新 ref(el)），测反注册。 */
  nodeKey?: string;
}

/**
 * 复刻消费方形态的最小网格（CharacterCollectCard 的载荷语义）：
 * 文本 'pending' = 载荷 undefined（透明占位），'delay:N' = 数字载荷。
 */
function RevealGrid({ count, resetKey, nodeKey = 'a' }: RevealGridProps) {
  const { reveal, register } = useRevealOnScroll(count, resetKey);
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={`${nodeKey}-${i}`} data-index={i} ref={register(i)}>
          {reveal[i] === undefined ? 'pending' : `delay:${reveal[i]}`}
        </div>
      ))}
    </>
  );
}

/** 取当前用例创建的 IO 桩实例；缺失即测试前提破裂，显式失败不静默。 */
function theObserver(): FakeIntersectionObserver {
  const io = FakeIntersectionObserver.instances[0];
  if (!io) throw new Error('用例未创建 IntersectionObserver 实例');
  return io;
}

/** 按 data-index 取网格节点；缺节点即测试前提破裂，显式失败不静默。 */
function gridNode(container: HTMLElement, index: number): Element {
  const el = container.querySelector(`[data-index="${index}"]`);
  if (!el) throw new Error(`网格缺少 data-index=${index} 节点`);
  return el;
}

/** 全部节点的载荷文本（data-index 顺序 = 消费方拿到的载荷序列）。 */
function gridTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-index]')).map(
    (el) => el.textContent ?? '',
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
});

describe('useRevealOnScroll 无 IntersectionObserver 环境', () => {
  it('缺 IO 的宿主（SSR 等）不阻塞首屏：全部元素立即揭示且载荷 0', () => {
    // 显式置缺而非依赖 jsdom 现状：jsdom 某天内建 IO 时本用例仍覆盖回退分支
    vi.stubGlobal('IntersectionObserver', undefined);
    const { container } = render(<RevealGrid count={3} resetKey="k" />);
    expect(gridTexts(container)).toEqual(['delay:0', 'delay:0', 'delay:0']);
  });
});

describe('useRevealOnScroll IO 路径：登记、订阅与错峰下发', () => {
  it('挂载即订阅全部元素（callback ref 登记 → 统一观察），揭示前载荷为 undefined 占位', () => {
    stubIO();
    // 不桩矩形：jsdom 零矩形判折叠线以下，全部交给 IO
    const { container } = render(<RevealGrid count={3} resetKey="k" />);
    expect(gridTexts(container)).toEqual(['pending', 'pending', 'pending']);
    const io = theObserver();
    expect(io.observed).toEqual([
      gridNode(container, 0),
      gridNode(container, 1),
      gridNode(container, 2),
    ]);
  });

  it('判交按批错峰下发（批内位次 × 档步进）；已揭示与非相交条目被过滤', () => {
    stubIO();
    const { container } = render(<RevealGrid count={3} resetKey="k" />);
    const io = theObserver();

    act(() => {
      io.trigger([
        { target: gridNode(container, 0), isIntersecting: true },
        { target: gridNode(container, 1), isIntersecting: true },
      ]);
    });
    expect(gridTexts(container)).toEqual(['delay:0', `delay:${ENTER_STAGGER_MS}`, 'pending']);

    // 非相交条目与已揭示元素都不进批：不重播、不重置既有错峰
    act(() => {
      io.trigger([
        { target: gridNode(container, 2), isIntersecting: false },
        { target: gridNode(container, 0), isIntersecting: true },
        { target: gridNode(container, 1), isIntersecting: true },
      ]);
    });
    expect(gridTexts(container)).toEqual(['delay:0', `delay:${ENTER_STAGGER_MS}`, 'pending']);

    // 新元素自成一批从头起档：错峰按批内位次而非全局序号
    act(() => {
      io.trigger([{ target: gridNode(container, 2), isIntersecting: true }]);
    });
    expect(gridTexts(container)).toEqual(['delay:0', `delay:${ENTER_STAGGER_MS}`, 'delay:0']);
  });

  it('首屏元素手动判交立即揭示、不入 IO 观察；滚入元素由 IO 接管且按批起档', () => {
    stubIO();
    stubRects((i) => i === 0);
    const { container } = render(<RevealGrid count={3} resetKey="k" />);
    expect(gridTexts(container)).toEqual(['delay:0', 'pending', 'pending']);
    const io = theObserver();
    expect(io.observed).toEqual([gridNode(container, 1), gridNode(container, 2)]);

    act(() => {
      io.trigger([
        { target: gridNode(container, 1), isIntersecting: true },
        { target: gridNode(container, 2), isIntersecting: true },
      ]);
    });
    // IO 批独立起档：首屏批不影响后续批的位次
    expect(gridTexts(container)).toEqual(['delay:0', 'delay:0', `delay:${ENTER_STAGGER_MS}`]);
  });

  it('同批位次超封顶档时钳在封顶（封顶是批内错峰的上界）', () => {
    stubIO();
    stubRects(() => true); // 全部视口内 → 挂载即一批 20 个
    const { container } = render(<RevealGrid count={20} resetKey="k" />);
    const texts = gridTexts(container);
    expect(texts[0]).toBe('delay:0');
    expect(texts[14]).toBe(`delay:${14 * ENTER_STAGGER_MS}`); // 336 < 封顶
    expect(texts[15]).toBe(`delay:${ENTER_STAGGER_CAP_MS}`); // 恰在封顶档
    expect(texts[19]).toBe(`delay:${ENTER_STAGGER_CAP_MS}`); // 超出部分钳在封顶
  });
});

describe('useRevealOnScroll callback ref 登记契约', () => {
  it('register 按 index 记忆化：引用跨渲染稳定，不同 index 各自独立', () => {
    const { result, rerender } = renderHook(() => useRevealOnScroll(2, 'k'));
    const ref0 = result.current.register(0);
    rerender();
    expect(result.current.register(0)).toBe(ref0);
    expect(result.current.register(1)).not.toBe(ref0);
  });

  it('重复登记同一元素幂等（不反注册）；更换元素时旧元素退出观察', () => {
    stubIO();
    const { result } = renderHook(() => useRevealOnScroll(1, 'k'));
    const ref = result.current.register(0);
    const first = document.createElement('div');
    const second = document.createElement('div');
    // 纯函数调用（无 state 更新），不经 React 生命周期，无需 act
    ref(first);
    ref(first);
    ref(second);
    const io = theObserver();
    expect(io.unobserved).toEqual([first]);
  });
});

describe('useRevealOnScroll 生命周期与重播', () => {
  it('卸载断开 observer（disconnect），不再有活跃订阅', () => {
    stubIO();
    const { unmount } = render(<RevealGrid count={2} resetKey="k" />);
    const io = theObserver();
    expect(io.disconnectCount).toBe(0);
    unmount();
    expect(io.disconnectCount).toBe(1);
  });

  it('resetKey 变化：揭示立即清零、全量重订阅，随后错峰可重播', () => {
    stubIO();
    const { container, rerender } = render(<RevealGrid count={2} resetKey="a" />);
    const io = theObserver();
    act(() => {
      io.trigger([
        { target: gridNode(container, 0), isIntersecting: true },
        { target: gridNode(container, 1), isIntersecting: true },
      ]);
    });
    expect(gridTexts(container)).toEqual(['delay:0', `delay:${ENTER_STAGGER_MS}`]);

    rerender(<RevealGrid count={2} resetKey="b" />);
    expect(gridTexts(container)).toEqual(['pending', 'pending']);
    expect(io.observed).toHaveLength(4); // 2（初挂）+ 2（重置后重订阅）

    act(() => {
      io.trigger([
        { target: gridNode(container, 0), isIntersecting: true },
        { target: gridNode(container, 1), isIntersecting: true },
      ]);
    });
    expect(gridTexts(container)).toEqual(['delay:0', `delay:${ENTER_STAGGER_MS}`]); // 重播
  });

  it('仅 count 增长（列表增删）：既有揭示不重置，只订阅并揭示新元素', () => {
    stubIO();
    const { container, rerender } = render(<RevealGrid count={2} resetKey="k" />);
    const io = theObserver();
    act(() => {
      io.trigger([
        { target: gridNode(container, 0), isIntersecting: true },
        { target: gridNode(container, 1), isIntersecting: true },
      ]);
    });

    rerender(<RevealGrid count={3} resetKey="k" />);
    expect(gridTexts(container)).toEqual(['delay:0', `delay:${ENTER_STAGGER_MS}`, 'pending']);
    expect(io.observed).toEqual([
      gridNode(container, 0),
      gridNode(container, 1),
      gridNode(container, 2),
    ]); // 只新增第三个的订阅

    act(() => {
      io.trigger([{ target: gridNode(container, 2), isIntersecting: true }]);
    });
    expect(gridTexts(container)).toEqual(['delay:0', `delay:${ENTER_STAGGER_MS}`, 'delay:0']);
    expect(FakeIntersectionObserver.instances).toHaveLength(1); // observer 复用不重建
  });

  it('节点更换（key 变化重挂）：旧节点反注册，按 index 键控的揭示状态保留', () => {
    stubIO();
    const { container, rerender } = render(<RevealGrid count={1} resetKey="k" />);
    const io = theObserver();
    const original = gridNode(container, 0);
    expect(io.observed).toEqual([original]);
    act(() => {
      io.trigger([{ target: original, isIntersecting: true }]);
    });
    expect(gridTexts(container)).toEqual(['delay:0']);

    rerender(<RevealGrid count={1} resetKey="k" nodeKey="b" />);
    expect(io.unobserved).toEqual([original]);
    expect(gridTexts(container)).toEqual(['delay:0']);
  });
});
