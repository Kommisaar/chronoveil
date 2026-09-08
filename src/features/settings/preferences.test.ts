// 设置域纯逻辑单测（TASK-009）：规范化、值域校验、草稿转换。
// 节奏范围与 Rust 侧 infra/config.rs 双重兜底一致（FR-009：10–160）。
import { describe, expect, it } from 'vitest';
import type { ConfigDto, ProviderDto } from '../../api/types';
import {
  isProviderValid,
  isRhythmValid,
  normalizeLanguageSetting,
  normalizeThemeSetting,
  newProviderId,
  parseAnimBaseMs,
  toDraft,
} from './preferences';

const provider = (partial: Partial<ProviderDto>): ProviderDto => ({
  id: 'p1',
  name: '本地中转',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  ...partial,
});

const config = (partial: Partial<ConfigDto>): ConfigDto => ({
  providers: [],
  activeProviderId: null,
  rhythmMsPerChar: 45,
  punctPauseEnabled: true,
  animDurationBase: 450,
  uiLanguage: 'zh',
  uiTheme: 'system',
  directorModel: null,
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

describe('parseAnimBaseMs（anim_duration_base: u32）', () => {
  it('非负整数解析', () => {
    expect(parseAnimBaseMs('450')).toBe(450);
    expect(parseAnimBaseMs(' 0 ')).toBe(0);
    expect(parseAnimBaseMs('4294967295')).toBe(4294967295);
  });
  it('非法文本拒绝', () => {
    expect(parseAnimBaseMs('')).toBeNull();
    expect(parseAnimBaseMs('abc')).toBeNull();
    expect(parseAnimBaseMs('-1')).toBeNull();
    expect(parseAnimBaseMs('12.5')).toBeNull();
    expect(parseAnimBaseMs('4294967296')).toBeNull();
  });
});

describe('provider 校验（UI-003：name / base_url / model 必填）', () => {
  it('完整 provider 通过', () => {
    expect(isProviderValid(provider({}))).toBe(true);
  });
  it('name / model 空白拒绝', () => {
    expect(isProviderValid(provider({ name: '  ' }))).toBe(false);
    expect(isProviderValid(provider({ model: '' }))).toBe(false);
  });
  it('base_url 需为合法 http(s) URL', () => {
    expect(isProviderValid(provider({ baseUrl: '' }))).toBe(false);
    expect(isProviderValid(provider({ baseUrl: 'not a url' }))).toBe(false);
    expect(isProviderValid(provider({ baseUrl: 'ftp://api.example.com' }))).toBe(false);
    expect(isProviderValid(provider({ baseUrl: 'http://localhost:11434/v1' }))).toBe(true);
  });
});

describe('toDraft（载入 config → 表单草稿）', () => {
  it('主题/语言规范化，providers 深拷贝（不可变更新基）', () => {
    const original = config({
      uiTheme: 'weird',
      uiLanguage: 'klingon',
      providers: [provider({})],
    });
    const draft = toDraft(original);
    expect(draft.uiTheme).toBe('system');
    expect(draft.uiLanguage).toBe('zh');
    draft.providers[0]!.name = '改动';
    expect(original.providers[0]!.name).toBe('本地中转');
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
