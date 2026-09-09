/**
 * 设置域纯逻辑（FR-009 / ADR-012 / UI-003，TASK-009）：config 值规范化与
 * 表单校验。UI 侧三档取值与 `src/api/types.ts` 的 ThemeSetting /
 * LanguageSetting 一致；Rust 侧 ui_theme / ui_language 为自由 String 不做
 * 枚举校验（infra/config.rs），故由前端在载入时把越档值规范化回默认，
 * 不静默扩大存储值域。
 */

import type { ConfigDto, LanguageSetting, ProviderDto, ThemeSetting } from '../../api/types';

/** 打字节奏允许范围（FR-009：10–160 ms/字；与 infra/config.rs 双重兜底）。 */
export const RHYTHM_MIN = 10;
export const RHYTHM_MAX = 160;

const THEME_VALUES: readonly ThemeSetting[] = ['system', 'light', 'dark'];
const LANGUAGE_VALUES: readonly LanguageSetting[] = ['system', 'zh', 'en'];

/** 越档主题值回落默认档（与 Rust `Config::new_with_defaults` 的 ui_theme 一致）。 */
export function normalizeThemeSetting(value: string): ThemeSetting {
  return (THEME_VALUES as readonly string[]).includes(value)
    ? (value as ThemeSetting)
    : 'system';
}

/** 越档语言值回落默认（与 Rust 缺省 ui_language = 'zh' 一致）。 */
export function normalizeLanguageSetting(value: string): LanguageSetting {
  return (LANGUAGE_VALUES as readonly string[]).includes(value)
    ? (value as LanguageSetting)
    : 'zh';
}

/** 节奏值域校验（整数 10–160）；滑杆已限位，此为保存前兜底。 */
export function isRhythmValid(value: number): boolean {
  return Number.isInteger(value) && value >= RHYTHM_MIN && value <= RHYTHM_MAX;
}

const U32_MAX = 0xffffffff; // Rust 侧 anim_duration_base: u32，越界会令反序列化失败

/** 动效基准文本 → 毫秒（非负整数、u32 上界）；不可解析返回 null（禁保存）。 */
export function parseAnimBaseMs(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 0 && value <= U32_MAX ? value : null;
}

/** 单套 Provider 逐项有效性（UI-003；双层级 2026-09-09：模型列表非空且逐项非空）。 */
export interface ProviderValidity {
  name: boolean;
  baseUrl: boolean;
  /** models 非空，且每项 trim 后非空（空串项只可能是非法输入，就地标错）。 */
  models: boolean;
}

export function validateProvider(provider: ProviderDto): ProviderValidity {
  return {
    name: provider.name.trim() !== '',
    baseUrl: isValidHttpUrl(provider.baseUrl.trim()),
    models:
      provider.models.length > 0 && provider.models.every((m) => m.trim() !== ''),
  };
}

/** 合法 http(s) URL（LLM base_url 不接受其他协议）。 */
export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isProviderValid(provider: ProviderDto): boolean {
  const v = validateProvider(provider);
  return v.name && v.baseUrl && v.models;
}

/** 新 provider id：uuid 优先（保存前仅存在于前端草稿，Rust 侧不校验格式）。 */
export function newProviderId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 载入 config → 表单草稿：providers 逐项浅拷 + models 拷贝（不可变更新基），
 * 主题/语言规范化到三档。 */
export function toDraft(config: ConfigDto): ConfigDto {
  return {
    ...config,
    providers: config.providers.map((p) => ({ ...p, models: [...p.models] })),
    uiTheme: normalizeThemeSetting(config.uiTheme),
    uiLanguage: normalizeLanguageSetting(config.uiLanguage),
  };
}

/** 删除第 index 个模型；若被删的是全局默认模型，同步回落默认选中（activeModel 置 null）。 */
export function withoutModel(
  config: Pick<ConfigDto, 'activeProviderId' | 'activeModel'>,
  provider: ProviderDto,
  index: number,
): { provider: ProviderDto; activeModel: ConfigDto['activeModel'] } {
  const removed = provider.models[index] ?? null;
  const models = provider.models.filter((_, i) => i !== index);
  const activeModel =
    config.activeProviderId === provider.id && config.activeModel !== null && config.activeModel === removed
      ? null
      : config.activeModel;
  return { provider: { ...provider, models }, activeModel };
}
