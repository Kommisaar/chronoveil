// 世界卡编辑器表单逻辑单测（useWorldForm 公开出口全覆盖）：挂载基线（打开不
// 自动保存）、canSave 名称必填、修改即保存（防抖窗口 / 还原取消在途拍 /
// flushSave 补存 / 失败不推进基线下拍重试）、历法改选落整份预设 DTO、
// matchPreset 回显（null = default、四预设结构匹配、外来历法不抹值——未改选
// 时载荷原样带回）。
// 挂 hook 用 renderHook（不挂 Fluent UI，逻辑层无组件依赖）；防抖时序用
// fake timers 推进。
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorldInput, WorldSummary } from '../../api/types';
import { CALENDAR_PRESETS } from '../../components/calendarPresets';
import { matchPreset, useWorldForm } from './useWorldForm';

const EDIT_WORLD: WorldSummary = {
  id: 2,
  name: '雾灯航线',
  worldbook: '灯雾与航路的世界',
  calendar: CALENDAR_PRESETS.fantasy,
  updatedAt: 100,
};

function renderForm(world: WorldSummary = EDIT_WORLD) {
  const onAutosave = vi.fn().mockResolvedValue(undefined);
  // 本文件测「修改即保存」机制，autosave 开true（create 模式的静默形态在
  // 编辑器交互测试覆盖）。
  const rendered = renderHook(() => useWorldForm({ world, onAutosave, autosave: true }));
  return { ...rendered, onAutosave };
}

/** 推进假时钟（包裹 act：定时器回调触发渲染）。 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 冲刷微任务：串行保存链经 Promise.then 派发，断言前需排空。 */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('matchPreset（历法 → 五选项键回显）', () => {
  it('null = default；四预设按结构匹配（值等即可，不依赖对象引用 / JSON 键序）', () => {
    expect(matchPreset(null)).toBe('default');
    expect(matchPreset(CALENDAR_PRESETS.modern)).toBe('modern');
    expect(matchPreset(CALENDAR_PRESETS.seven)).toBe('seven');
    expect(matchPreset(CALENDAR_PRESETS.ganzhi)).toBe('ganzhi');
    expect(matchPreset(CALENDAR_PRESETS.fantasy)).toBe('fantasy');
    // 深拷（键序无关）：festivals 逐键值等
    expect(
      matchPreset({
        name: '旧都历（抄本）',
        months: [...CALENDAR_PRESETS.fantasy.months],
        daysPerMonth: 30,
        dayNames: [...CALENDAR_PRESETS.fantasy.dayNames],
        festivals: { 360: '守夜', 45: '灯节' },
      }),
    ).toBe('fantasy');
  });

  it('外来历法（不匹配任何预设）回 default 显示但不抹值——表单未改选不触发保存', async () => {
    const foreign: WorldSummary = {
      ...EDIT_WORLD,
      calendar: {
        name: '双月历',
        months: ['盈月', '亏月'],
        daysPerMonth: 40,
        dayNames: [],
        festivals: null,
      },
    };
    const { result, onAutosave } = renderForm(foreign);
    expect(result.current.preset).toBe('default');
    // 打开 2s 无改动：不自动保存（外来历法不被选中态意外覆盖为 null）
    await advance(2000);
    expect(onAutosave).not.toHaveBeenCalled();
  });
});

describe('useWorldForm 挂载与基线', () => {
  it('全量字段预填：名称 / 世界观 / 历法选中键派生自卡值', () => {
    const { result } = renderForm();
    expect(result.current.name).toBe('雾灯航线');
    expect(result.current.worldbook).toBe('灯雾与航路的世界');
    expect(result.current.preset).toBe('fantasy');
    expect(result.current.canSave).toBe(true);
  });

  it('打开即基线：未改动不自动保存（防抖窗口过后仍无上送）', async () => {
    const { onAutosave } = renderForm();
    await advance(2000);
    expect(onAutosave).not.toHaveBeenCalled();
  });

  it('canSave 只看名称 trim 非空', () => {
    const { result } = renderForm();
    expect(result.current.canSave).toBe(true);
    act(() => result.current.setName('   '));
    expect(result.current.canSave).toBe(false);
    act(() => result.current.setName(' 回声荒原 '));
    expect(result.current.canSave).toBe(true);
  });
});

describe('useWorldForm 修改即保存', () => {
  it('改动经防抖上送整卡载荷（名称 trim、历法原值直传）', async () => {
    const { result, onAutosave } = renderForm();
    act(() => result.current.setWorldbook('改写后的世界'));
    await advance(599);
    expect(onAutosave).not.toHaveBeenCalled();
    await advance(1);
    expect(onAutosave).toHaveBeenCalledTimes(1);
    expect(onAutosave).toHaveBeenCalledWith({
      name: '雾灯航线',
      worldbook: '改写后的世界',
      calendar: CALENDAR_PRESETS.fantasy,
    });
  });

  it('防抖窗口内改回原值：在途拍取消，不产生上送', async () => {
    const { result, onAutosave } = renderForm();
    act(() => result.current.setName('改名'));
    act(() => result.current.setName(EDIT_WORLD.name));
    await advance(2000);
    expect(onAutosave).not.toHaveBeenCalled();
  });

  it('名称必填挂起：清空期间不上送，恢复有效名后随下一拍落库', async () => {
    const { result, onAutosave } = renderForm();
    act(() => result.current.setName('  '));
    await advance(2000);
    expect(onAutosave).not.toHaveBeenCalled();
    act(() => result.current.setName('回声荒原'));
    await advance(600);
    expect(onAutosave).toHaveBeenCalledTimes(1);
    expect(onAutosave).toHaveBeenCalledWith(
      expect.objectContaining({ name: '回声荒原' }),
    );
  });

  it('改选历法：default 落 null、预设落整份 wire DTO', async () => {
    const { result, onAutosave } = renderForm();
    act(() => result.current.setPreset('seven'));
    await advance(600);
    expect(onAutosave).toHaveBeenCalledWith({
      name: '雾灯航线',
      worldbook: '灯雾与航路的世界',
      calendar: CALENDAR_PRESETS.seven,
    });
    act(() => result.current.setPreset('default'));
    await advance(600);
    expect(onAutosave).toHaveBeenLastCalledWith({
      name: '雾灯航线',
      worldbook: '灯雾与航路的世界',
      calendar: null,
    });
  });

  it('flushSave 补存在途防抖的最后一拍', async () => {
    const { result, onAutosave } = renderForm();
    act(() => result.current.setName('改名'));
    await advance(300);
    act(() => result.current.flushSave());
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenCalledTimes(1);
    expect(onAutosave).toHaveBeenCalledWith(
      expect.objectContaining({ name: '改名' }),
    );
  });

  it('保存失败不推进基线：下一拍改动自然重试', async () => {
    const onAutosave = vi
      .fn<(input: WorldInput) => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useWorldForm({ world: EDIT_WORLD, onAutosave, autosave: true }));
    act(() => result.current.setName('改名'));
    await advance(600);
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenCalledTimes(1);
    // 同值不再重发（基线未推进也不重复轰炸）；新改动重试
    await advance(2000);
    expect(onAutosave).toHaveBeenCalledTimes(1);
    act(() => result.current.setName('再改名'));
    await advance(600);
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenCalledTimes(2);
    expect(onAutosave).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: '再改名' }),
    );
  });
});
