// @vitest-environment node —— 纯逻辑测试无 DOM 依赖，跳过 jsdom 环境创建（测试提速）
// 设置域纯逻辑单测（TASK-009；双层级 provider→models 2026-09-09）：规范化、
// 值域校验、草稿转换、模型列表增删。
import { describe, expect, it } from 'vitest';
import type { ConfigDto, ProviderDto } from '../../api/types';
import {
  isNearScenesValid,
  isProviderValid,
  isRhythmValid,
  normalizeLanguageSetting,
  normalizeThemeSetting,
  newProviderId,
  parseAnimBaseMs,
  parseNearScenes,
  toDraft,
  withoutModel,
} from './preferences';

const provider = (partial: Partial<ProviderDto>): ProviderDto => ({
  id: 'p1',
  name: '本地中转',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  models: ['test-model'],
  ...partial,
});

const config = (partial: Partial<ConfigDto>): ConfigDto => ({
  providers: [],
  activeProviderId: null,
  activeModel: null,
  rhythmMsPerChar: 45,
  renderStyle: 'type',
  punctPauseEnabled: true,
  animDurationBase: 450,
  uiLanguage: 'zh',
  uiTheme: 'system',
  directorModel: null,
  nearScenes: 2,
  ...partial,
});

describe('normalizeThemeSetting（ui_theme 三档）', () => {
  it('合法档位原样保留', () => {
    expect(normalizeThemeSetting('system')).toBe('system');
    expect(normalizeThemeSetting('light')).toBe('light');
    expect(normalizeThemeSetting('dark')).toBe('dark');
  });
  it('越档值（外部手改）回落默认 system，不扩大存储值域', () => {
    expect(normalizeThemeSetting('banana')).toBe('system');
    expect(normalizeThemeSetting('')).toBe('system');
  });
});

describe('normalizeLanguageSetting（ui_language 三档）', () => {
  it('合法档位原样保留', () => {
    expect(normalizeLanguageSetting('system')).toBe('system');
    expect(normalizeLanguageSetting('zh')).toBe('zh');
    expect(normalizeLanguageSetting('en')).toBe('en');
  });
  it('越档值回落 Rust 缺省 zh', () => {
    expect(normalizeLanguageSetting('fr')).toBe('zh');
  });
});

describe('isRhythmValid（FR-009：10–160）', () => {
  it('边界 10 / 160 与默认 45 放行', () => {
    expect(isRhythmValid(10)).toBe(true);
    expect(isRhythmValid(45)).toBe(true);
    expect(isRhythmValid(160)).toBe(true);
  });
  it('越界与非整数拒绝', () => {
    expect(isRhythmValid(9)).toBe(false);
    expect(isRhythmValid(161)).toBe(false);
    expect(isRhythmValid(45.5)).toBe(false);
    expect(isRhythmValid(Number.NaN)).toBe(false);
  });
});

describe('parseNearScenes / isNearScenesValid（近景窗口可选化：1–6，默认 2）', () => {
  it('边界 1 / 6 与默认 2 放行', () => {
    expect(parseNearScenes('1')).toBe(1);
    expect(parseNearScenes(' 2 ')).toBe(2);
    expect(parseNearScenes('6')).toBe(6);
    expect(isNearScenesValid(1)).toBe(true);
    expect(isNearScenesValid(6)).toBe(true);
  });
  it('越域与非法文本拒绝，走 issueNearScenes 错误路径（与 Rust validate 同域拒绝）', () => {
    expect(parseNearScenes('')).toBeNull();
    expect(parseNearScenes('abc')).toBeNull();
    expect(parseNearScenes('-1')).toBeNull();
    expect(parseNearScenes('2.5')).toBeNull();
    expect(parseNearScenes('0')).toBeNull();
    expect(parseNearScenes('7')).toBeNull();
    expect(isNearScenesValid(0)).toBe(false);
    expect(isNearScenesValid(7)).toBe(false);
    expect(isNearScenesValid(2.5)).toBe(false);
    expect(isNearScenesValid(Number.NaN)).toBe(false);
  });
});

describe('parseAnimBaseMs（引擎渲染值域 150–1200，FR-005）', () => {
  it('域内整数解析', () => {
    expect(parseAnimBaseMs('450')).toBe(450);
    expect(parseAnimBaseMs(' 150 ')).toBe(150);
    expect(parseAnimBaseMs('1200')).toBe(1200);
  });
  it('越域（引擎渲染侧会静默钳边）与非法文本拒绝，走 issueAnimBase 错误路径', () => {
    expect(parseAnimBaseMs('')).toBeNull();
    expect(parseAnimBaseMs('abc')).toBeNull();
    expect(parseAnimBaseMs('-1')).toBeNull();
    expect(parseAnimBaseMs('12.5')).toBeNull();
    expect(parseAnimBaseMs('50')).toBeNull(); // 低于引擎下界
    expect(parseAnimBaseMs('0')).toBeNull();
    expect(parseAnimBaseMs('5000')).toBeNull(); // 高于引擎上界
    expect(parseAnimBaseMs('4294967295')).toBeNull(); // u32 内但越引擎值域
  });
});

describe('provider 校验（UI-003：name / base_url / models 非空）', () => {
  it('完整 provider 通过', () => {
    expect(isProviderValid(provider({}))).toBe(true);
  });
  it('name / models 空白拒绝（models 空列表或含空串项都算未填完）', () => {
    expect(isProviderValid(provider({ name: '  ' }))).toBe(false);
    expect(isProviderValid(provider({ models: [] }))).toBe(false);
    expect(isProviderValid(provider({ models: ['m1', ' '] }))).toBe(false);
  });
  it('base_url 需为合法 http(s) URL', () => {
    expect(isProviderValid(provider({ baseUrl: '' }))).toBe(false);
    expect(isProviderValid(provider({ baseUrl: 'not a url' }))).toBe(false);
    expect(isProviderValid(provider({ baseUrl: 'ftp://api.example.com' }))).toBe(false);
    expect(isProviderValid(provider({ baseUrl: 'http://localhost:11434/v1' }))).toBe(true);
  });
});

describe('模型列表删除（双层级 provider→models）', () => {
  it('withoutModel 删指定行；删中全局默认模型则回落 activeModel=null', () => {
    const p = provider({ models: ['m1', 'm2', 'm3'] });
    const keep = withoutModel({ activeProviderId: 'p1', activeModel: 'm2' }, p, 2);
    expect(keep.provider.models).toEqual(['m1', 'm2']);
    // 删的不是默认模型，选中不动
    expect(keep.activeModel).toBe('m2');

    const hit = withoutModel({ activeProviderId: 'p1', activeModel: 'm2' }, p, 1);
    expect(hit.provider.models).toEqual(['m1', 'm3']);
    // 删中默认模型 → 清空选中，解析层回落第一个
    expect(hit.activeModel).toBeNull();

    const other = withoutModel({ activeProviderId: 'p9', activeModel: 'm2' }, p, 1);
    // 默认指向别的服务时不动
    expect(other.activeModel).toBe('m2');
  });
  it('原数组不可变', () => {
    const p = provider({ models: ['m1', 'm2'] });
    withoutModel({ activeProviderId: 'p1', activeModel: null }, p, 0);
    expect(p.models).toEqual(['m1', 'm2']);
  });
});

describe('toDraft（载入 config → 表单草稿）', () => {
  it('主题/语言规范化，providers/models 深拷贝（不可变更新基）', () => {
    const original = config({
      uiTheme: 'weird',
      uiLanguage: 'klingon',
      providers: [provider({})],
    });
    const draft = toDraft(original);
    expect(draft.uiTheme).toBe('system');
    expect(draft.uiLanguage).toBe('zh');
    draft.providers[0]!.name = '改动';
    draft.providers[0]!.models.push('脏数据');
    expect(original.providers[0]!.name).toBe('本地中转');
    expect(original.providers[0]!.models).toEqual(['test-model']);
  });
});

describe('newProviderId', () => {
  it('非空且不重复', () => {
    const a = newProviderId();
    const b = newProviderId();
    expect(a).not.toBe('');
    expect(a).not.toBe(b);
  });
});
