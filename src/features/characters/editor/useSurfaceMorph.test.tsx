// useSurfaceMorph 关闭→卸载链路行为测试（审计补盲：此前该 hook 全仓仅
// CharacterEditorDialog 消费且零测试）。断言公开时点契约——open=false 表示
// 「退场中」：EXIT_MS 到点回调 onClosed、父级据此真正卸载；不锁 FLIP 变换
// 细节（内联 style 形态属实现，行为契约只看回调时点与次数）。
// 环境与前提说明：
// - 计时用 vi.useFakeTimers 推进，不碰真实时序；三个用例均为纯时点断言。
// - jsdom 无布局：surfaceRef 绑定的 div 矩形全零，且用例不给 getTriggerRect
//   （消费方现测不到触发元素时走同一路径）——FLIP 钉制/缩回分支提前返回，
//   退场退化为「纯计时器」路径，恰是本契约依赖的最小前提，行为确定。
// - jsdom 缺 window.matchMedia：morphable() 的可选链整链短路为 undefined，
//   取反后 morphable() 实为 true（非 false）；但卸载计时器排布与该布尔无关
//   （setTimeout 无条件执行），时点契约不受影响——勿据此断言形变样式。
// - 无「遍历 document.styleSheets」断言，按默认落入 shared 组，无需登记
//   vitest.config.ts 的 isolated-styles。
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// EXIT_MS 与实现（useSurfaceMorph.ts 私有常量）同式互指：卸载计时 =
// 退场形变档 MORPH_OUT_MS + 冲刷余量。实现改推导式时此处必须同步。
import { MORPH_OUT_MS } from '../../../components/motion';
import { useSurfaceMorph } from './useSurfaceMorph';

const EXIT_MS = MORPH_OUT_MS + 10;

/** 最小宿主：surfaceRef 绑到真实 div（复刻消费方形态，Fluent 插槽同位）。 */
function MorphHarness(props: { open: boolean; onClosed: () => void }) {
  const { surfaceRef } = useSurfaceMorph(props);
  return <div ref={surfaceRef} />;
}

/** 推进假时钟（包裹 act：到点回调走宿主生命周期路径）。 */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useSurfaceMorph 关闭→卸载链路（onClosed 时点契约）', () => {
  it('open=true 挂载：不排卸载计时，推进远超 EXIT_MS 仍不回调 onClosed', () => {
    const onClosed = vi.fn();
    render(<MorphHarness open onClosed={onClosed} />);
    advance(EXIT_MS * 10);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('open 置 false：EXIT_MS-1 未回调，EXIT_MS 恰回调一次且不重复', () => {
    const onClosed = vi.fn();
    const { rerender } = render(<MorphHarness open onClosed={onClosed} />);
    rerender(<MorphHarness open={false} onClosed={onClosed} />);
    advance(EXIT_MS - 1);
    expect(onClosed).not.toHaveBeenCalled();
    advance(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
    // 到点后不再多发：卸载回调是一次性契约
    advance(EXIT_MS * 5);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('退场中途重开（EXIT_MS 前 false→true）：cleanup 取消挂起卸载，onClosed 永不回调', () => {
    const onClosed = vi.fn();
    const { rerender } = render(<MorphHarness open onClosed={onClosed} />);
    rerender(<MorphHarness open={false} onClosed={onClosed} />);
    advance(Math.floor(EXIT_MS / 2));
    expect(onClosed).not.toHaveBeenCalled();
    // 重开同一目标：effect cleanup 清掉挂起的卸载计时（重开取消路径）
    rerender(<MorphHarness open onClosed={onClosed} />);
    advance(EXIT_MS * 10);
    expect(onClosed).not.toHaveBeenCalled();
  });
});
