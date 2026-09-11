// 角色编辑器表单逻辑单测（useEditorForm 公开出口全覆盖）：新建默认值、
// 编辑态回填、canSave 名称必填、脏比对（onDirtyChange 时序）、model_config
// 覆写解析/序列化（未知键往返、非法 JSON 回落、trim 归一）、历法编辑
// （FR-014 二期：回填/脏比对/校验拦截/AI 草稿应用/buildInput 契约携带）、
// live 派生（强调色/风格标签）、预览演出（遗留风格串回落 fade）。
// 挂 hook 用 renderHook（不挂 Fluent UI，逻辑层无组件依赖）；文案断言走 zh 资源。
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CharacterSummary } from '../../../api/types';
import { CALENDAR_PRESETS } from '../../../components/calendarPresets';
import { ANIM_STYLES } from '../../../engine';
import '../../../i18n';
import { gradientOf, gradientPairOf } from '../posterGradient';
import { useEditorForm } from './useEditorForm';

const EDIT_CHARACTER: CharacterSummary = {
  id: 2,
  name: '林深',
  avatar: 'data:image/png;base64,QQ==',
  persona: '旧书店老板',
  gender: '男',
  age: '31',
  renderStyle: 'ink',
  modelConfig: '{"providerId":"p1","model":"m1","legacyKey":{"a":1}}',
  accentColor: '#3322ff',
  calendarConfig: null,
  updatedAt: 100,
  sessionCount: 3,
};

function renderForm(character: CharacterSummary | null, onDirtyChange = vi.fn()) {
  const rendered = renderHook(() => useEditorForm({ character, onDirtyChange }));
  return { ...rendered, onDirtyChange };
}

afterEach(cleanup);

describe('useEditorForm 新建态（character = null）', () => {
  it('默认值：全部空、renderStyle 与 Rust 缺省一致、覆写收起、不可保存', () => {
    const { result } = renderForm(null);
    expect(result.current.name).toBe('');
    expect(result.current.gender).toBe('');
    expect(result.current.age).toBe('');
    expect(result.current.persona).toBe('');
    expect(result.current.renderStyle).toBe('type');
    expect(result.current.accentColor).toBeNull();
    expect(result.current.override).toEqual({
      providerId: '',
      model: '',
      baseUrl: '',
      apiKey: '',
      rest: {},
    });
    expect(result.current.overrideOpen).toBe(false);
    expect(result.current.canSave).toBe(false);
    expect(result.current.previewed).toBe(false);
  });

  it('live 派生：名称空回落「新建角色」，颜色按 id=0 跟随海报', () => {
    const { result } = renderForm(null);
    expect(result.current.live.nameText).toBe('新建角色');
    expect(result.current.live.baseColor).toBe(gradientPairOf(0)[1]);
    expect(result.current.live.posterGradient).toContain('#332a6e');
    // 默认 'type' 命中 18 风格表 → 展示表内标签「打字机」
    expect(result.current.live.styleLabel).toBe('打字机');
  });

  it('buildInput：name/gender/age trim，空串归一 null，avatar/voiceConfig 恒 null', () => {
    const { result } = renderForm(null);
    act(() => {
      result.current.setName('  乌鸦  ');
      result.current.setGender('  ');
      result.current.setAge('');
      result.current.setPersona('哑巴');
    });
    const input = result.current.buildInput();
    expect(input.name).toBe('乌鸦');
    expect(input.avatar).toBeNull();
    expect(input.gender).toBeNull();
    expect(input.age).toBeNull();
    expect(input.persona).toBe('哑巴');
    expect(input.voiceConfig).toBeNull();
    // 全空覆写序列化为 null（跟随全局）
    expect(input.modelConfig).toBeNull();
  });
});

describe('useEditorForm 编辑态回填', () => {
  it('全量字段预填 + 覆写解析（未知键进 rest）+ 覆写自动展开', () => {
    const { result } = renderForm(EDIT_CHARACTER);
    expect(result.current.name).toBe('林深');
    expect(result.current.gender).toBe('男');
    expect(result.current.age).toBe('31');
    expect(result.current.persona).toBe('旧书店老板');
    expect(result.current.renderStyle).toBe('ink');
    expect(result.current.accentColor).toBe('#3322ff');
    expect(result.current.override.providerId).toBe('p1');
    expect(result.current.override.model).toBe('m1');
    expect(result.current.override.rest).toEqual({ legacyKey: { a: 1 } });
    expect(result.current.overrideOpen).toBe(true);
    expect(result.current.canSave).toBe(true);
    expect(result.current.live.nameText).toBe('林深');
  });

  it('buildInput：avatar 原样带回，覆写未知键往返保留', () => {
    const { result } = renderForm(EDIT_CHARACTER);
    const input = result.current.buildInput();
    expect(input.avatar).toBe('data:image/png;base64,QQ==');
    const model = JSON.parse(input.modelConfig!) as Record<string, unknown>;
    expect(model).toEqual({ providerId: 'p1', model: 'm1', legacyKey: { a: 1 } });
  });

  it('modelConfig 为 null 的老角色：覆写全空且收起', () => {
    const { result } = renderForm({ ...EDIT_CHARACTER, modelConfig: null });
    expect(result.current.override).toEqual({
      providerId: '',
      model: '',
      baseUrl: '',
      apiKey: '',
      rest: {},
    });
    expect(result.current.overrideOpen).toBe(false);
  });
});

describe('useEditorForm model_config 解析边界', () => {
  it('非对象 JSON（数组）与非法 JSON 均回落空覆写（保存即修复）', () => {
    for (const raw of ['not json', '[1,2]', '"str"', '{}surplus']) {
      const { result } = renderForm({ ...EDIT_CHARACTER, modelConfig: raw });
      expect(result.current.override).toEqual({
        providerId: '',
        model: '',
        baseUrl: '',
        apiKey: '',
        rest: {},
      });
      expect(result.current.overrideOpen).toBe(false);
    }
  });

  it('已知键非字符串值：不进表单也不留在 rest（保存后被清除）', () => {
    const { result } = renderForm({ ...EDIT_CHARACTER, modelConfig: '{"model":42}' });
    expect(result.current.override.model).toBe('');
    expect(result.current.override.rest).toEqual({});
  });

  it('覆写值带空白：解析原样保留（overrideOpen 判定看原值），序列化时 trim', () => {
    const { result } = renderForm({
      ...EDIT_CHARACTER,
      modelConfig: '{"providerId":"  ","model":" m2 "}',
    });
    expect(result.current.override.providerId).toBe('  ');
    expect(result.current.override.model).toBe(' m2 ');
    expect(result.current.overrideOpen).toBe(true);
    const model = JSON.parse(result.current.buildInput().modelConfig!) as Record<
      string,
      unknown
    >;
    // providerId trim 后为空被丢弃，model 保留去空白值
    expect(model).toEqual({ model: 'm2' });
  });
});

describe('useEditorForm 序列化出口', () => {
  it('setOverride 函数式更新：填值序列化、清空回落 null', () => {
    const { result } = renderForm(null);
    act(() => {
      result.current.setOverride((o) => ({ ...o, model: ' m2 ', apiKey: ' k ' }));
    });
    expect(result.current.buildInput().modelConfig).toBe('{"model":"m2","apiKey":"k"}');
    act(() => {
      result.current.setOverride((o) => ({ ...o, model: '', apiKey: '' }));
    });
    expect(result.current.buildInput().modelConfig).toBeNull();
  });

  it('rest 未知键单独存在时也序列化（编辑往返不清除遗留键）', () => {
    const { result } = renderForm(null);
    act(() => {
      result.current.setOverride((o) => ({ ...o, rest: { custom: 1 } }));
    });
    expect(result.current.buildInput().modelConfig).toBe('{"custom":1}');
  });
});

describe('useEditorForm canSave 与脏比对', () => {
  it('canSave 只看名称 trim 非空', () => {
    const { result } = renderForm(null);
    expect(result.current.canSave).toBe(false);
    act(() => result.current.setName('   '));
    expect(result.current.canSave).toBe(false);
    act(() => result.current.setName(' 乌鸦 '));
    expect(result.current.canSave).toBe(true);
  });

  it('onDirtyChange 时序：挂载 false → 改动 true → 还原 false', () => {
    const onDirtyChange = vi.fn();
    const { result } = renderForm(null, onDirtyChange);
    expect(onDirtyChange.mock.calls.map((c) => c[0])).toEqual([false]);
    act(() => result.current.setPersona('x'));
    expect(onDirtyChange.mock.calls.map((c) => c[0])).toEqual([false, true]);
    act(() => result.current.setPersona(''));
    expect(onDirtyChange.mock.calls.map((c) => c[0])).toEqual([false, true, false]);
  });

  it('编辑态改回原值即不脏（含覆写 rest 往返一致）', () => {
    const onDirtyChange = vi.fn();
    const { result } = renderForm(EDIT_CHARACTER, onDirtyChange);
    expect(onDirtyChange.mock.calls.map((c) => c[0])).toEqual([false]);
    act(() => result.current.setOverride((o) => ({ ...o, model: 'm9' })));
    expect(onDirtyChange.mock.calls.at(-1)?.[0]).toBe(true);
    act(() => result.current.setOverride((o) => ({ ...o, model: 'm1' })));
    expect(onDirtyChange.mock.calls.at(-1)?.[0]).toBe(false);
  });
});

describe('useEditorForm 历法编辑（FR-014 二期）', () => {
  /** 已配置旧都历（snake_case 存储 JSON）的角色。 */
  const CAL_CHARACTER: CharacterSummary = {
    ...EDIT_CHARACTER,
    calendarConfig:
      '{"name":"旧都历","months":["霜月","白蜡月"],"days_per_month":30,"day_names":["晨露日"],"festivals":{"45":"灯节"}}',
  };

  it('新建角色：历法未配置全空、收起、buildInput 携带 null', () => {
    const { result } = renderForm(null);
    expect(result.current.calendarFields).toEqual({
      name: '',
      daysPerMonth: '',
      months: '',
      dayNames: '',
      festivals: '',
    });
    expect(result.current.calendarOpen).toBe(false);
    expect(result.current.calendarEditing).toBe(false);
    expect(result.current.calendarBuild).toEqual({ kind: 'empty' });
    expect(result.current.buildInput().calendarConfig).toBeNull();
  });

  it('已配置角色：字段归一化回填（每行一项 / 节日升序）且区块自动展开', () => {
    const { result } = renderForm(CAL_CHARACTER);
    expect(result.current.calendarFields).toEqual({
      name: '旧都历',
      daysPerMonth: '30',
      months: '霜月\n白蜡月',
      dayNames: '晨露日',
      festivals: '45=灯节',
    });
    expect(result.current.calendarOpen).toBe(true);
    expect(result.current.calendarBuild.kind).toBe('valid');
    // 未触碰历法时不脏（未编辑的已配置角色可直接保存整卡）
    expect(result.current.buildInput().calendarConfig).toEqual({
      name: '旧都历',
      months: ['霜月', '白蜡月'],
      daysPerMonth: 30,
      dayNames: ['晨露日'],
      festivals: { 45: '灯节' },
    });
  });

  it('坏日历 JSON：整体降级未配置（保存 null 即修复），不阻塞保存', () => {
    const { result } = renderForm({ ...CAL_CHARACTER, calendarConfig: 'not json' });
    expect(result.current.calendarBuild).toEqual({ kind: 'empty' });
    expect(result.current.canSave).toBe(true);
  });

  it('脏比对覆盖历法字段：改动 true → 改回原值 false', () => {
    const onDirtyChange = vi.fn();
    const { result } = renderForm(CAL_CHARACTER, onDirtyChange);
    expect(onDirtyChange.mock.calls.at(-1)?.[0]).toBe(false);
    act(() => result.current.setCalendarFields((c) => ({ ...c, daysPerMonth: '31' })));
    expect(onDirtyChange.mock.calls.at(-1)?.[0]).toBe(true);
    act(() => result.current.setCalendarFields((c) => ({ ...c, daysPerMonth: '30' })));
    expect(onDirtyChange.mock.calls.at(-1)?.[0]).toBe(false);
  });

  it('校验拦截：配置了月名但每月天数非法 → canSave 关掉（名称有效也一样拦）', () => {
    const { result } = renderForm(null);
    act(() => result.current.setName('乌鸦'));
    expect(result.current.canSave).toBe(true);
    act(() =>
      result.current.setCalendarFields((c) => ({ ...c, daysPerMonth: '0', months: '一月' })),
    );
    expect(result.current.calendarBuild).toEqual({ kind: 'invalid', error: 'daysPerMonth' });
    expect(result.current.canSave).toBe(false);
    // 未配置（全空）不拦保存：默认数字历是合法态
    act(() => result.current.setCalendarFields((c) => ({ ...c, daysPerMonth: '', months: '' })));
    expect(result.current.canSave).toBe(true);
  });

  it('applyCalendar（AI 草稿/预设共用）：填入编辑态并自动展开进编辑，不自行保存', () => {
    const { result } = renderForm(null);
    act(() => result.current.applyCalendar(CALENDAR_PRESETS.fantasy));
    expect(result.current.calendarOpen).toBe(true);
    expect(result.current.calendarEditing).toBe(true);
    expect(result.current.calendarFields.name).toBe('旧都历');
    expect(result.current.calendarFields.festivals).toBe('45=灯节\n360=守夜');
    expect(result.current.buildInput().calendarConfig).toEqual(CALENDAR_PRESETS.fantasy);
    // 关闭编辑态不改变字段（只是形态切换）
    act(() => result.current.setCalendarEditing(() => false));
    expect(result.current.calendarFields.name).toBe('旧都历');
  });

  it('折叠开合函数式更新', () => {
    const { result } = renderForm(null);
    act(() => result.current.setCalendarOpen((o) => !o));
    expect(result.current.calendarOpen).toBe(true);
    act(() => result.current.setCalendarOpen((o) => !o));
    expect(result.current.calendarOpen).toBe(false);
  });
});

describe('useEditorForm live 派生', () => {
  it('显式强调色：海报原色直出、基础色同值；清 null 跟随 id 派生', () => {
    const { result } = renderForm(null);
    act(() => result.current.setAccentColor('#00ff00'));
    expect(result.current.live.baseColor).toBe('#00ff00');
    expect(result.current.live.posterGradient).toBe(
      'linear-gradient(150deg, #00ff00 0%, #00ff00 100%)',
    );
    act(() => result.current.setAccentColor(null));
    expect(result.current.live.baseColor).toBe(gradientPairOf(0)[1]);
  });

  it('编辑角色无强调色：按角色 id 取模亮端（非新建的 id=0 色）', () => {
    const { result } = renderForm({ ...EDIT_CHARACTER, accentColor: null });
    expect(result.current.live.baseColor).toBe(gradientPairOf(2)[1]);
    expect(result.current.live.posterGradient).toBe(gradientOf(2));
  });

  it('风格标签：合法 id 出中文标签，表外串原样回落', () => {
    const { result } = renderForm(null);
    const ink = ANIM_STYLES.find((s) => s.id === 'ink');
    expect(ink).toBeDefined();
    act(() => result.current.setRenderStyle('ink'));
    expect(result.current.live.styleLabel).toBe(ink!.label);
    act(() => result.current.setRenderStyle('made-up-style'));
    expect(result.current.live.styleLabel).toBe('made-up-style');
  });
});

describe('useEditorForm 开合与预览演出', () => {
  it('setOverrideOpen 函数式开合', () => {
    const { result } = renderForm(null);
    expect(result.current.overrideOpen).toBe(false);
    act(() => result.current.setOverrideOpen((o) => !o));
    expect(result.current.overrideOpen).toBe(true);
    act(() => result.current.setOverrideOpen((o) => !o));
    expect(result.current.overrideOpen).toBe(false);
  });

  it('playPreview：容器绑定后可播，遗留风格串自校验回落 fade，选合法风格按 id 播', () => {
    const { result } = renderForm(null);
    const container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      result.current.previewRef(container);
      result.current.playPreview();
    });
    expect(result.current.previewed).toBe(true);
    // 新建默认 'type'（打字机）命中 18 风格表
    expect(container.getAttribute('data-anim')).toBe('type');
    act(() => result.current.setRenderStyle('ink'));
    act(() => result.current.playPreview());
    expect(container.getAttribute('data-anim')).toBe('ink');
    // 表外遗留串（如迁移前的 'typewriter'）回落 fade，兜底不炸
    act(() => result.current.setRenderStyle('typewriter'));
    act(() => result.current.playPreview());
    expect(container.getAttribute('data-anim')).toBe('fade');
    container.remove();
  });

  it('playPreview：未绑定容器时安全空转（不置 previewed）', () => {
    const { result } = renderForm(null);
    act(() => result.current.playPreview());
    expect(result.current.previewed).toBe(false);
  });
});
