/**
 * 角色卡历法编辑的纯表单逻辑（FR-014 二期）：存储 JSON 解析、表单字段
 * 序列化与客户端校验，供 useEditorForm（状态/脏比对/整卡保存）与
 * CalendarSection / CalendarDraftDialog（查看/编辑/起草预览）复用。
 * 不依赖 React，可脱离 UI 直接单测。
 *
 * 形态契约：
 * - CharacterSummary.calendarConfig 是存储 JSON 字符串（Rust 序列化 domain
 *   CalendarConfig 得 snake_case 键）；解析按 snake_case 读，坏 JSON 按未
 *   配置降级（与 model_config 覆写解析同款「展示回落、保存即修复」语义）；
 * - 编辑产物走 wire DTO（CalendarConfigDto，camelCase）随整卡 update_character
 *   提交，由 Rust 折叠成存储 JSON——前端不手写存储 JSON；
 * - 校验规则对齐 Rust domain/fiction_time::validate：days_per_month > 0 且
 *   月名 / 日名至少其一非空；每月天数另有上界 999（含端点），对齐 Rust AI
 *   路径 services/calendar_draft::coerce_days_per_month——持久化路径维持
 *   validate-only，上界由前端把关；节日行另加「N=名称，N 为 ≥1 整数且不超
 *   年长（月数 × 每月天数，月名未配置时不设上界）」的行式约定，与 Rust AI
 *   路径 services/calendar_draft::coerce_festivals 的越年防御对齐。
 */
import type { CalendarConfigDto } from '../../../api/types';

/**
 * 每月天数上界（含端点：999 放行、1000 拦截）。与 Rust
 * services/calendar_draft 的 `MAX_DAYS_PER_MONTH` 常量对齐。
 */
export const MAX_DAYS_PER_MONTH = 999;

/** 历法编辑表单形态（textarea 原文：月名/日名每行一项，节日每行「N=名称」）。 */
export interface CalendarFields {
  /** 历法名，可空（空 = 无命名皮肤）。 */
  name: string;
  /** 每月天数（字符串形态承载输入，序列化时校验转数字）。 */
  daysPerMonth: string;
  months: string;
  dayNames: string;
  festivals: string;
}

/** 未配置初值（全部空 = 默认数字历）。 */
export const EMPTY_CALENDAR_FIELDS: CalendarFields = {
  name: '',
  daysPerMonth: '',
  months: '',
  dayNames: '',
  festivals: '',
};

/** buildCalendar 的判定结果：全空（未配置）/ 校验失败 / 有效配置。 */
export type CalendarBuild =
  | { kind: 'empty' }
  | { kind: 'invalid'; error: CalendarFieldError }
  | { kind: 'valid'; config: CalendarConfigDto };

/** 校验失败定位（i18n 文案由 UI 层映射）。daysPerMonthMax = 超上界。 */
export type CalendarFieldError = 'daysPerMonth' | 'daysPerMonthMax' | 'names' | 'festivals';

/** 按行拆 textarea：trim 后丢空行，保持书写顺序。 */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * 存储 JSON 字符串 → wire DTO（查看态用）。只认 snake_case 键（Rust 存储
 * 形态）；任何结构意外都整体降级为 null（= 未配置），不抛错不打扰 UI。
 */
export function parseCalendarJson(raw: string | null): CalendarConfigDto | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  // festivals：键为数字字符串的平面对象；非法条目跳过，空表归 null。
  let festivals: Record<number, string> | null = null;
  if (typeof obj.festivals === 'object' && obj.festivals !== null && !Array.isArray(obj.festivals)) {
    for (const [key, value] of Object.entries(obj.festivals)) {
      const day = Number(key);
      if (Number.isInteger(day) && day >= 1 && typeof value === 'string') {
        festivals ??= {};
        festivals[day] = value;
      }
    }
  }
  return {
    name: typeof obj.name === 'string' && obj.name !== '' ? obj.name : null,
    months: strings(obj.months),
    daysPerMonth: typeof obj.days_per_month === 'number' ? obj.days_per_month : 0,
    dayNames: strings(obj.day_names),
    festivals,
  };
}

/**
 * wire DTO → 表单字段（编辑态预填 / 预设与 AI 草稿应用共用）。
 * months/dayNames 每行一项；节日按第 N 天升序输出「N=名称」行（与 Rust
 * BTreeMap 的键序一致，往返稳定）。config = null 即未配置全空。
 */
export function fieldsFromCalendar(config: CalendarConfigDto | null): CalendarFields {
  if (config === null) return { ...EMPTY_CALENDAR_FIELDS };
  const festivals = Object.entries(config.festivals ?? {})
    .map(([key, value]) => ({ day: Number(key), value }))
    .filter(({ day }) => Number.isInteger(day) && day >= 1)
    .sort((a, b) => a.day - b.day)
    .map(({ day, value }) => `${day}=${value}`);
  return {
    name: config.name ?? '',
    daysPerMonth: config.daysPerMonth > 0 ? String(config.daysPerMonth) : '',
    months: config.months.join('\n'),
    dayNames: config.dayNames.join('\n'),
    festivals: festivals.join('\n'),
  };
}

/** 节日行格式：`N=名称`（允许等号两侧空白），N 为 ≥1 整数。 */
const FESTIVAL_LINE = /^(\d+)\s*=\s*(.+)$/;

/**
 * 表单字段 → 判定结果。任何历法字段非空即视为在配置历法，必须整体通过
 * 校验（对齐 Rust validate）；全部为空 = 未配置（存 null）。
 */
export function buildCalendar(fields: CalendarFields): CalendarBuild {
  const name = fields.name.trim();
  const months = lines(fields.months);
  const dayNames = lines(fields.dayNames);
  const hasInput =
    name !== '' ||
    fields.daysPerMonth.trim() !== '' ||
    months.length > 0 ||
    dayNames.length > 0 ||
    lines(fields.festivals).length > 0;
  if (!hasInput) return { kind: 'empty' };

  const days = Number(fields.daysPerMonth);
  if (!Number.isInteger(days) || days < 1) return { kind: 'invalid', error: 'daysPerMonth' };
  // 上界含端点（1–999），对齐 calendar_draft::coerce_days_per_month 的
  // `(1..=MAX_DAYS_PER_MONTH).contains` 语义。
  if (days > MAX_DAYS_PER_MONTH) return { kind: 'invalid', error: 'daysPerMonthMax' };
  // 对齐 fiction_time::validate：月名 / 日名至少其一非空。
  if (months.length === 0 && dayNames.length === 0) {
    return { kind: 'invalid', error: 'names' };
  }
  // 年总天数（越年节日判定基准，对齐 calendar_draft::coerce_festivals）：
  // months 非空时 = 月数 × 每月天数；months 为空无法界定年长，只查 ≥ 1 界。
  const yearDays = months.length > 0 ? months.length * days : null;
  const festivals: Record<number, string> = {};
  for (const line of lines(fields.festivals)) {
    const match = FESTIVAL_LINE.exec(line);
    // N=0 或非「N=名称」形态都拦下（N ≥ 1 整数）。
    if (match === null) return { kind: 'invalid', error: 'festivals' };
    const day = Number(match[1]);
    const festivalName = match[2]?.trim() ?? '';
    // 越年（超出月数 × 每月天数的年长）同样拦下，防「第 400 天」这类
    // 落不进任何月份的幽灵节日。
    if (day < 1 || festivalName === '' || (yearDays !== null && day > yearDays)) {
      return { kind: 'invalid', error: 'festivals' };
    }
    festivals[day] = festivalName;
  }
  return {
    kind: 'valid',
    config: {
      name: name === '' ? null : name,
      months,
      daysPerMonth: days,
      dayNames,
      festivals: Object.keys(festivals).length > 0 ? festivals : null,
    },
  };
}
