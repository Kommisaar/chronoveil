// 角色编辑器表单逻辑单测（useEditorForm 公开出口全覆盖）：挂载基线（打开不
// 自动保存）、canSave 名称必填、修改即保存（防抖窗口 / 还原取消在途拍 /
// 串行链在途窗口纠正拍：还原+挂机 / 还原+关闭卸载 / 纠正拍未到即 flushSave /
// 名称必填挂起 / flushSave 补存 / 失败不推进基线下拍重试 / 卸载补存）、
// 模型覆写三扁平字段（列值直读预填、空白 trim 归一 null 经上送载荷断言）、
// live 派生（强调色/风格标签）、预览动画（遗留风格串回落 fade）。
// 挂 hook 用 renderHook（不挂 Fluent UI，逻辑层无组件依赖）；文案断言走 zh
// 资源；防抖时序用 fake timers 推进。
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterInput, CharacterSummary } from '../../../api/types';
import '../../../i18n';
import { gradientPairOf } from '../../../components/posterGradient';
import { useEditorForm } from './useEditorForm';

const EDIT_CHARACTER: CharacterSummary = {
  id: 2,
  name: '林深',
  avatar: 'data:image/png;base64,QQ==',
  persona: '旧书店老板',
  gender: '男',
  age: '31',
  titles: ['雨夜守夜人', '  '],
  renderStyle: 'ink',
  modelProviderId: 'p1',
  modelName: 'm1',
  modelTemperature: null,
  modelTopP: null,
  modelFrequencyPenalty: null,
  modelPresencePenalty: null,
  accentColor: '#3322ff',
  animDurationMs: null,
  animRhythmMs: null,
  animPunctPause: null,
  updatedAt: 100,
  sessionCount: 3,
};

function renderForm(character: CharacterSummary = EDIT_CHARACTER) {
  const onAutosave = vi.fn().mockResolvedValue(undefined);
  // 本文件测「修改即保存」机制，autosave 开true（create 模式的静默形态在
  // 编辑器交互测试覆盖）。
  const rendered = renderHook(() => useEditorForm({ character, onAutosave, autosave: true }));
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

/** 手动放行的 deferred：让首拍 onAutosave 停在在途，测试控制其完成时机。 */
function makeGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useEditorForm 挂载与基线', () => {
  it('全量字段预填：模型覆写三扁平字段直读列值', () => {
    const { result } = renderForm();
    expect(result.current.name).toBe('林深');
    expect(result.current.gender).toBe('男');
    expect(result.current.age).toBe('31');
    expect(result.current.persona).toBe('旧书店老板');
    expect(result.current.renderStyle).toBe('ink');
    expect(result.current.accentColor).toBe('#3322ff');
    expect(result.current.modelProviderId).toBe('p1');
    expect(result.current.modelName).toBe('m1');
    expect(result.current.modelTemperature).toBeNull();
    expect(result.current.titles).toEqual(['雨夜守夜人', '  ']);
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
    act(() => result.current.setName(' 乌鸦 '));
    expect(result.current.canSave).toBe(true);
  });
});

describe('useEditorForm 修改即保存', () => {
  it('改动经防抖上送整卡载荷：avatar 原样带回、模型覆写列值直传、称号原样直传', async () => {
    const { result, onAutosave } = renderForm();
    act(() => result.current.setPersona('夜航西飞'));
    await advance(599);
    expect(onAutosave).not.toHaveBeenCalled();
    await advance(1);
    expect(onAutosave).toHaveBeenCalledTimes(1);
    expect(onAutosave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '林深',
        avatar: 'data:image/png;base64,QQ==',
        persona: '夜航西飞',
        gender: '男',
        age: '31',
        renderStyle: 'ink',
        modelProviderId: 'p1',
        modelName: 'm1',
        modelTemperature: null,
        modelTopP: null,
        modelFrequencyPenalty: null,
        modelPresencePenalty: null,
        // 载荷侧逐项 trim 过滤空项（表单态 '  ' 空白项不落库）
        titles: ['雨夜守夜人'],
      }),
    );
  });

  it('连续改动只送最后一拍（防抖重置）', async () => {
    const { result, onAutosave } = renderForm();
    act(() => result.current.setPersona('第一拍'));
    await advance(400);
    act(() => result.current.setPersona('第二拍'));
    await advance(400);
    expect(onAutosave).not.toHaveBeenCalled();
    await advance(200);
    expect(onAutosave).toHaveBeenCalledTimes(1);
    expect(onAutosave).toHaveBeenCalledWith(
      expect.objectContaining({ persona: '第二拍' }),
    );
  });

  it('防抖窗口内改回已保存原值：取消在途拍，不上送', async () => {
    const { result, onAutosave } = renderForm();
    act(() => result.current.setPersona('临时改动'));
    await advance(300);
    act(() => result.current.setPersona('旧书店老板'));
    await advance(2000);
    expect(onAutosave).not.toHaveBeenCalled();
  });

  it('串行链在途期间改回已保存原值：过期拍落库后排纠正拍补送原值', async () => {
    const gate = makeGate();
    const { result, onAutosave } = renderForm();
    onAutosave.mockImplementationOnce(() => gate.promise);
    act(() => result.current.setPersona('在途改动'));
    await advance(700); // 防抖到点，首拍入链并停在在途
    expect(onAutosave).toHaveBeenCalledTimes(1);
    act(() => result.current.setPersona('旧书店老板')); // 在途窗口内还原为基线
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenCalledTimes(1); // 还原只取消防抖，不动在途拍
    gate.resolve(); // 过期载荷（A）落库
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenCalledTimes(1); // 纠正拍经防抖排布，尚未上送
    await advance(700); // 纠正拍防抖到点
    expect(onAutosave).toHaveBeenCalledTimes(2);
    expect(onAutosave).toHaveBeenLastCalledWith(
      expect.objectContaining({ persona: '旧书店老板' }),
    );
    await flushMicrotasks();
    await advance(2000);
    expect(onAutosave).toHaveBeenCalledTimes(2); // 收敛：基线已推进，不再多拍
  });

  it('在途期间还原后关闭（flushSave + 卸载）：过期拍落库即直入链补送原值，不等防抖', async () => {
    const gate = makeGate();
    const { result, onAutosave, unmount } = renderForm();
    onAutosave.mockImplementationOnce(() => gate.promise);
    act(() => result.current.setPersona('在途改动'));
    await advance(700);
    act(() => result.current.setPersona('旧书店老板'));
    act(() => result.current.flushSave()); // 无防抖拍可补（no-op），不产生上送
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenCalledTimes(1);
    unmount();
    gate.resolve(); // 过期拍此时才落库
    await flushMicrotasks();
    // 纠正直入串行链（未推进任何时钟即上送）——挂机等防抖会留下关闭后丢拍窗口
    expect(onAutosave).toHaveBeenCalledTimes(2);
    expect(onAutosave).toHaveBeenLastCalledWith(
      expect.objectContaining({ persona: '旧书店老板' }),
    );
    await advance(2000);
    expect(onAutosave).toHaveBeenCalledTimes(2);
  });

  it('纠正拍防抖未到即 flushSave：取消纠正拍立即直送（关闭落在落库与纠正之间）', async () => {
    const gate = makeGate();
    const { result, onAutosave } = renderForm();
    onAutosave.mockImplementationOnce(() => gate.promise);
    act(() => result.current.setPersona('在途改动'));
    await advance(700);
    act(() => result.current.setPersona('旧书店老板'));
    gate.resolve();
    await flushMicrotasks(); // 过期拍落库，纠正拍已入防抖
    expect(onAutosave).toHaveBeenCalledTimes(1);
    act(() => result.current.flushSave()); // 取消纠正拍，立即直送原值
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenCalledTimes(2);
    expect(onAutosave).toHaveBeenLastCalledWith(
      expect.objectContaining({ persona: '旧书店老板' }),
    );
    await advance(2000);
    expect(onAutosave).toHaveBeenCalledTimes(2);
  });

  it('名称清空挂起（不发送无效载荷），恢复有效名后随下一拍上送', async () => {
    const { result, onAutosave } = renderForm();
    act(() => result.current.setName('   '));
    await advance(2000);
    expect(onAutosave).not.toHaveBeenCalled();
    act(() => result.current.setName('乌鸦'));
    await advance(700);
    expect(onAutosave).toHaveBeenCalledTimes(1);
    expect(onAutosave).toHaveBeenCalledWith(
      expect.objectContaining({ name: '乌鸦' }),
    );
  });

  it('flushSave：防抖未到也立即补存；无在途改动时 no-op', async () => {
    const { result, onAutosave } = renderForm();
    // 无改动：flush 不发送
    act(() => result.current.flushSave());
    await flushMicrotasks();
    expect(onAutosave).not.toHaveBeenCalled();
    // 有改动：flush 立即上送，不再等防抖（上送经串行链微任务派发）
    act(() => result.current.setPersona('关闭前补存'));
    act(() => result.current.flushSave());
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenCalledTimes(1);
    expect(onAutosave).toHaveBeenCalledWith(
      expect.objectContaining({ persona: '关闭前补存' }),
    );
    // 补存后基线推进：同一载荷不再重发
    await advance(2000);
    expect(onAutosave).toHaveBeenCalledTimes(1);
  });

  it('上送失败不推进基线：下一拍改动按最新载荷重试', async () => {
    const { result, onAutosave } = renderForm();
    onAutosave.mockRejectedValueOnce(new Error('backend down'));
    act(() => result.current.setPersona('失败的一拍'));
    await advance(700);
    expect(onAutosave).toHaveBeenCalledTimes(1);
    act(() => result.current.setPersona('重试的一拍'));
    await advance(700);
    expect(onAutosave).toHaveBeenCalledTimes(2);
    expect(onAutosave).toHaveBeenLastCalledWith(
      expect.objectContaining({ persona: '重试的一拍' }),
    );
  });

  it('卸载补存：切换目标（unmount）时在途防抖立即上送', async () => {
    const { result, onAutosave, unmount } = renderForm();
    act(() => result.current.setPersona('卸载前的最后一拍'));
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(onAutosave).toHaveBeenCalledTimes(1);
    expect(onAutosave).toHaveBeenCalledWith(
      expect.objectContaining({ persona: '卸载前的最后一拍' }),
    );
  });
});

describe('useEditorForm 称号载荷归一（经 flushSave 载荷断言）', () => {
  it('逐项 trim、过滤空项；清空归空数组（0016 恒落 "[]" 语义）', async () => {
    const { result, onAutosave } = renderForm();
    act(() => {
      result.current.setTitles([' 布拉维坎的屠夫 ', '  ', '利维亚的战士']);
    });
    act(() => result.current.flushSave());
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenLastCalledWith(
      expect.objectContaining({ titles: ['布拉维坎的屠夫', '利维亚的战士'] }),
    );
    act(() => result.current.setTitles([]));
    act(() => result.current.flushSave());
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenLastCalledWith(
      expect.objectContaining({ titles: [] }),
    );
    await advance(2000);
  });
});

describe('useEditorForm 模型覆写序列化出口（经 flushSave 载荷断言）', () => {
  it('覆写值带空白：上送载荷 trim；全空归一 null（跟随全局）', async () => {
    // 无覆写基线：序列化结果只含本次填值
    const { result, onAutosave } = renderForm({
      ...EDIT_CHARACTER,
      modelProviderId: null,
      modelName: null,
    });
    act(() => {
      result.current.setModelProviderId(' p1 ');
      result.current.setModelName(' m2 ');
    });
    act(() => result.current.flushSave());
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelProviderId: 'p1', modelName: 'm2' }),
    );
    // 清空 → 归一 null（列语义 NULL = 跟随全局），不落空串
    act(() => {
      result.current.setModelProviderId('  ');
      result.current.setModelName('');
    });
    act(() => result.current.flushSave());
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelProviderId: null, modelName: null }),
    );
    await advance(2000);
  });

  it('温度覆写：自定义写数值，回 null 即跟随全局（列语义直传，无 JSON 键拼装）', async () => {
    const { result, onAutosave } = renderForm({
      ...EDIT_CHARACTER,
      modelProviderId: null,
      modelName: null,
    });
    act(() => result.current.setModelTemperature(1.2));
    act(() => result.current.flushSave());
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelTemperature: 1.2 }),
    );
    act(() => result.current.setModelTemperature(null));
    act(() => result.current.flushSave());
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelTemperature: null }),
    );
    await advance(2000);
  });

  it('采样参数三覆写（2026-09-16）：自定义写数值，回 null 即跟随全局', async () => {
    const { result, onAutosave } = renderForm();
    act(() => {
      result.current.setModelTopP(0.85);
      result.current.setModelFrequencyPenalty(-1.5);
      result.current.setModelPresencePenalty(0.5);
    });
    act(() => result.current.flushSave());
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modelTopP: 0.85,
        modelFrequencyPenalty: -1.5,
        modelPresencePenalty: 0.5,
      }),
    );
    act(() => {
      result.current.setModelTopP(null);
      result.current.setModelFrequencyPenalty(null);
      result.current.setModelPresencePenalty(null);
    });
    act(() => result.current.flushSave());
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modelTopP: null,
        modelFrequencyPenalty: null,
        modelPresencePenalty: null,
      }),
    );
    await advance(2000);
  });
});

describe('useEditorForm live 派生（2026-09-16 抽屉化后仅剩取色器基础色）', () => {
  it('显式强调色：基础色原色直出；清 null 跟随 id 派生亮端', () => {
    const { result } = renderForm();
    act(() => result.current.setAccentColor('#00ff00'));
    expect(result.current.live.baseColor).toBe('#00ff00');
    act(() => result.current.setAccentColor(null));
    expect(result.current.live.baseColor).toBe(gradientPairOf(2)[1]);
  });

  it('编辑角色无强调色：按角色 id 取模亮端（非新建的 id=0 色）', () => {
    const { result } = renderForm({ ...EDIT_CHARACTER, accentColor: null });
    expect(result.current.live.baseColor).toBe(gradientPairOf(2)[1]);
  });
});

describe('useEditorForm 预览动画', () => {
  it('playPreview：容器绑定后可播，遗留风格串自校验回落 fade，选合法风格按 id 播', () => {
    const { result } = renderForm();
    const container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      result.current.previewRef(container);
      result.current.playPreview();
    });
    expect(result.current.previewed).toBe(true);
    // 该角色 renderStyle 'ink'（水墨）命中 18 风格表
    expect(container.getAttribute('data-anim')).toBe('ink');
    act(() => result.current.setRenderStyle('typewriter'));
    act(() => result.current.playPreview());
    expect(container.getAttribute('data-anim')).toBe('fade');
    container.remove();
  });

  it('playPreview：未绑定容器时安全空转（不置 previewed）', () => {
    const { result } = renderForm();
    act(() => result.current.playPreview());
    expect(result.current.previewed).toBe(false);
  });

  it('演出参数（2026-09-13）：预览消费生效值——卡覆写优先，留空跟随全局基准', () => {
    const onAutosave = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useEditorForm({
        character: { ...EDIT_CHARACTER, animDurationMs: 700, animRhythmMs: 120, animPunctPause: false },
        onAutosave,
        autosave: true,
        animDefaults: { durationMs: 300, msPerChar: 20, punctPause: true, renderStyle: 'type', temperature: 0.7, topP: 1.0, frequencyPenalty: 0, presencePenalty: 0, defaultProviderId: '', defaultModelId: '' },
      }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      result.current.previewRef(container);
      result.current.playPreview();
    });
    // 覆写优先：--dur 与节奏取卡值（--dur 由 setDuration 同步写入容器内联）
    expect(container.style.getPropertyValue('--dur')).toBe('700ms');

    // 清覆写 → 跟随全局基准（300ms）
    act(() => result.current.setAnimDurationMs(null));
    act(() => result.current.playPreview());
    expect(container.style.getPropertyValue('--dur')).toBe('300ms');
    container.remove();
  });

  it('演出参数进整卡载荷：覆写随上送，null 即跟随全局（迁移 0013 wire）', async () => {
    const onAutosave = vi.fn().mockResolvedValue(undefined);
    const rendered = renderHook(() => useEditorForm({ character: EDIT_CHARACTER, onAutosave, autosave: true }));
    const { result } = rendered;
    act(() => {
      result.current.setAnimDurationMs(900);
      result.current.setAnimPunctPause(false);
    });
    await advance(700); // 防抖 600ms + 余量
    await flushMicrotasks();
    expect(onAutosave).toHaveBeenCalledTimes(1);
    const payload = onAutosave.mock.calls[0]![0] as CharacterInput;
    expect(payload.animDurationMs).toBe(900);
    expect(payload.animRhythmMs).toBeNull();
    expect(payload.animPunctPause).toBe(false);
  });
});
