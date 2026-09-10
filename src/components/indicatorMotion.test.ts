// moveIndicator 缓动路径补测（审计批次 C）。jsdom 限制（已实测）：
// - getComputedStyle 原样透传行内 transform 字符串、不合成矩阵——
//   readTranslate 只认 matrix(...) 形态，用例行内 matrix 摆位；
// - Element.animate 未实现——在元素上打桩观察关键帧与计时参数；
// - window.matchMedia 未实现且源码此处无可选链——reduced-motion 分支
//   必须 stub 才能走到（不打桩时该分支在 jsdom 下会 TypeError，本测试
//   顺带钉住「命中 reduce 只就位不播动画」的输入输出）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INDICATOR_DURATION,
  INDICATOR_EASING,
  INDICATOR_STRETCH,
  moveIndicator,
} from './indicatorMotion';

type Keyframes = Array<{ transform?: string }>;
type AnimationOptions = { duration?: number; easing?: string };

function makeIndicator(transform?: string): {
  el: HTMLElement;
  animate: ReturnType<typeof vi.fn>;
} {
  const el = document.createElement('div');
  document.body.appendChild(el);
  if (transform !== undefined) el.style.transform = transform;
  const animate = vi.fn(() => ({}));
  el.animate = animate as unknown as typeof el.animate;
  return { el, animate };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('moveIndicator 定位分支（读不出当前位置 → 直接就位）', () => {
  it('初次定位（无 transform）：写入目标位移，不播动画', () => {
    const { el, animate } = makeIndicator();
    moveIndicator(el, { x: 10, y: 20 });
    expect(el.style.transform).toBe('translate(10px, 20px)');
    expect(animate).not.toHaveBeenCalled();
  });

  it('非 matrix 形态的残留 transform 读不出位移：按初次定位处理', () => {
    // jsdom 不合成矩阵，translate(...) 透传后不匹配 /matrix.*\((.+)\)/
    const { el, animate } = makeIndicator('translate(3px, 4px)');
    moveIndicator(el, { x: 10, y: 20 });
    expect(el.style.transform).toBe('translate(10px, 20px)');
    expect(animate).not.toHaveBeenCalled();
  });

  it('残缺矩阵（不足 6 元素）同样视为未定位', () => {
    const { el, animate } = makeIndicator('matrix(1, 0, 0, 1)');
    moveIndicator(el, { x: 0, y: 0 });
    expect(animate).not.toHaveBeenCalled();
  });
});

describe('moveIndicator 缓动分支（读得出当前位置）', () => {
  it('从旧位移到新目标：三帧关键帧（中点拉长 INDICATOR_STRETCH）+ 计时参数，transform 先行落位', () => {
    // jsdom 无 matchMedia 且源码此处无可选链：不打桩到不了动画分支
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    );
    const { el, animate } = makeIndicator('matrix(1, 0, 0, 1, 0, 0)');
    moveIndicator(el, { x: 100, y: 40 });
    // 就位值同步写入行内样式（动画结束/中断时视觉终点一致）
    expect(el.style.transform).toBe('translate(100px, 40px)');
    expect(animate).toHaveBeenCalledTimes(1);
    const call = animate.mock.calls[0] as unknown as [Keyframes, AnimationOptions];
    const [keyframes, options] = call;
    expect(keyframes).toHaveLength(3);
    expect(keyframes[0]?.transform).toBe('translate(0px, 0px) scaleY(1)');
    expect(keyframes[1]?.transform).toBe(
      `translate(50px, 20px) scaleY(${INDICATOR_STRETCH})`,
    );
    expect(keyframes[2]?.transform).toBe('translate(100px, 40px) scaleY(1)');
    expect(options).toEqual({ duration: INDICATOR_DURATION, easing: INDICATOR_EASING });
  });

  it('目标与当前一致：就位即返回，不播动画', () => {
    const { el, animate } = makeIndicator('matrix(1, 0, 0, 1, 10, 20)');
    moveIndicator(el, { x: 10, y: 20 });
    expect(el.style.transform).toBe('translate(10px, 20px)');
    expect(animate).not.toHaveBeenCalled();
  });

  it('系统开启「减弱动态效果」：跳过动画只就位（reduce 查询命中）', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    const { el, animate } = makeIndicator('matrix(1, 0, 0, 1, 0, 0)');
    moveIndicator(el, { x: 5, y: 6 });
    expect(el.style.transform).toBe('translate(5px, 6px)');
    expect(animate).not.toHaveBeenCalled();
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });
});
