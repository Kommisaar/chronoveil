/**
 * i18n 奇偶守卫（AGENTS.md：`src/i18n/zh.ts` 与 `en.ts` 要同步加 key，默认 zh）：
 * - 两语言 key 集合必须完全一致（深层递归，任一侧缺失即失败并打印缺失清单）；
 * - 叶子值必须是非空字符串（防止占位空串上线）；
 * - 插值占位符（{{name}} / {{count}}…）集合两语言一致（防止丢变量导致渲染缺参）。
 */
import { describe, expect, it } from 'vitest';
import { en } from './en';
import { zh } from './zh';

/** 深层递归展开：嵌套对象 → 「a.b.c → 叶子值」扁平表。 */
function flatten(resource: unknown, prefix = ''): Map<string, string> {
  const leaves = new Map<string, string>();
  if (resource === null || typeof resource !== 'object') return leaves;
  for (const [key, value] of Object.entries(resource as Record<string, unknown>)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === 'object') {
      for (const [child, leaf] of flatten(value, path)) leaves.set(child, leaf);
    } else {
      leaves.set(path, value as string);
    }
  }
  return leaves;
}

/** 抽取插值占位符名并排序（{{count}} → ['count']）。 */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? '').sort();
}

const zhLeaves = flatten(zh);
const enLeaves = flatten(en);

describe('i18n 奇偶守卫（zh ↔ en 深层 key 对齐）', () => {
  it('zh 与 en 的 key 集合完全一致（深层递归）', () => {
    const missingInEn = [...zhLeaves.keys()].filter((key) => !enLeaves.has(key));
    const missingInZh = [...enLeaves.keys()].filter((key) => !zhLeaves.has(key));
    expect(missingInEn, `en 缺少 key：${missingInEn.join(', ')}`).toEqual([]);
    expect(missingInZh, `zh 缺少 key：${missingInZh.join(', ')}`).toEqual([]);
  });

  it('所有叶子值都是非空字符串', () => {
    for (const [language, leaves] of [
      ['zh', zhLeaves],
      ['en', enLeaves],
    ] as const) {
      for (const [key, value] of leaves) {
        expect(
          typeof value === 'string' && value.length > 0,
          `${language}.${key} 应为非空字符串，实际：${JSON.stringify(value)}`,
        ).toBe(true);
      }
    }
  });

  it('插值占位符集合两语言一致', () => {
    for (const [key, zhValue] of zhLeaves) {
      const enValue = enLeaves.get(key);
      if (enValue === undefined) continue; // key 集合一致性由第一个用例兜底
      expect(
        placeholders(enValue),
        `key「${key}」的插值占位符中英不一致（zh: ${placeholders(zhValue).join(',')}）`,
      ).toEqual(placeholders(zhValue));
    }
  });

  it('en 文案无尾随空白（间隔空格归拼接处，防翻译工具截断 / 复制丢失漂移）', () => {
    const offenders = [...enLeaves]
      .filter(([, value]) => /\s$/.test(value))
      .map(([key]) => key);
    expect(offenders, `en 尾随空白的 key：${offenders.join(', ')}`).toEqual([]);
  });
});
