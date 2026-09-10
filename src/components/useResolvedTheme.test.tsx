// useResolvedTheme 补测（审计批次 C）：system 档 prefers-color-scheme 的
// 挂载解析 / change 实时跟随 / 卸载退订。jsdom 缺省无 matchMedia（已实测
// 为 undefined）——hook 的可选链回落亮色分支直接可测；监听行为用可编程
// 的 MediaQueryList 桩驱动 change 事件（vi.stubGlobal 覆盖 window.matchMedia）。
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useResolvedTheme } from './useResolvedTheme';

type ChangeListener = (event: { matches: boolean }) => void;

/** 可编程 matchMedia 桩：记录 change 监听者，测试内驱动事件。 */
function stubMatchMedia(initialMatches: boolean) {
  const listeners = new Set<ChangeListener>();
  const mql = {
    matches: initialMatches,
    addEventListener: vi.fn((_type: string, listener: ChangeListener) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: ChangeListener) => {
      listeners.delete(listener);
    }),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => mql));
  return {
    /** 变更 matches 并向所有已注册监听者派发 change 事件 */
    emit(matches: boolean): void {
      mql.matches = matches;
      for (const listener of [...listeners]) listener({ matches });
    },
    addEventListener: mql.addEventListener,
    removeEventListener: mql.removeEventListener,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useResolvedTheme 固定档', () => {
  it('dark / light 直接映射，系统明暗变化不影响固定档', () => {
    const mql = stubMatchMedia(false);
    const light = renderHook(() => useResolvedTheme('light'));
    expect(light.result.current).toBe('light');
    // 系统切到暗色：固定亮色档纹丝不动
    act(() => mql.emit(true));
    expect(light.result.current).toBe('light');
    light.unmount();
    const dark = renderHook(() => useResolvedTheme('dark'));
    act(() => mql.emit(false));
    expect(dark.result.current).toBe('dark');
  });
});

describe('useResolvedTheme system 档', () => {
  it('按挂载时 matches 解析：暗色系统 → dark', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useResolvedTheme('system'));
    expect(result.current).toBe('dark');
  });

  it('实时跟随：change 事件驱动 light ↔ dark 切换', () => {
    const mql = stubMatchMedia(false);
    const { result } = renderHook(() => useResolvedTheme('system'));
    expect(result.current).toBe('light');
    act(() => mql.emit(true));
    expect(result.current).toBe('dark');
    act(() => mql.emit(false));
    expect(result.current).toBe('light');
  });

  it('卸载退订：移除的正是注册的同一个监听者', () => {
    const mql = stubMatchMedia(false);
    const { unmount } = renderHook(() => useResolvedTheme('system'));
    expect(mql.addEventListener).toHaveBeenCalledTimes(1);
    unmount();
    expect(mql.removeEventListener).toHaveBeenCalledTimes(1);
    expect(mql.removeEventListener.mock.calls[0]?.[1]).toBe(
      mql.addEventListener.mock.calls[0]?.[1],
    );
  });

  it('缺 matchMedia 的环境（本项目 jsdom 缺省）：视为亮色且不订阅', () => {
    expect(window.matchMedia).toBeUndefined();
    const { result } = renderHook(() => useResolvedTheme('system'));
    expect(result.current).toBe('light');
  });
});
