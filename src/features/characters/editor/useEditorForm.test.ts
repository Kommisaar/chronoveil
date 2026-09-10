// 角色编辑器表单逻辑单测（useEditorForm 公开出口全覆盖）：新建默认值、
// 编辑态回填、canSave 名称必填、脏比对（onDirtyChange 时序）、model_config
// 覆写解析/序列化（未知键往返、非法 JSON 回落、trim 归一）、live 派生
// （强调色/风格标签）、预览演出（遗留风格串回落 fade）。挂 hook 用
// renderHook（不挂 Fluent UI，逻辑层无组件依赖）；文案断言走 zh 资源。
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CharacterSummary } from '../../../api/types';
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
