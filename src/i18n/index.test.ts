// i18n/index 纯函数补测（审计批次 C）：system 档语言解析（FR-009）与
// html lang 同步值映射（a11y）。navigator.language 在 jsdom 是原型上的
// 只读 getter，按惯例在实例上 defineProperty 覆写、afterEach 删除还原。
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSystemLanguage, toHtmlLang } from './index';

function stubNavigatorLanguage(language: string): void {
  Object.defineProperty(window.navigator, 'language', {
    value: language,
    configurable: true,
  });
}

afterEach(() => {
  // 删掉实例覆盖即还原 jsdom 原型 getter（语言定义在 Navigator 原型链上）
  delete (window.navigator as { language?: string }).language;
});

describe('resolveSystemLanguage（FR-009 system 档）', () => {
  it('zh 前缀归中文：zh / zh-CN / zh-TW / zh-Hans 都算', () => {
    for (const language of ['zh', 'zh-CN', 'zh-TW', 'zh-Hans']) {
      stubNavigatorLanguage(language);
      expect(resolveSystemLanguage()).toBe('zh');
    }
  });

  it('其余一律回落英文：en / 其他语言 / 大写标签（toLowerCase 后比较）', () => {
    for (const language of ['en-US', 'en', 'fr', 'ja-JP', 'DE-de']) {
      stubNavigatorLanguage(language);
      expect(resolveSystemLanguage()).toBe('en');
    }
  });

  it('jsdom 缺省（en-US）即英文', () => {
    expect(resolveSystemLanguage()).toBe('en');
  });
});

describe('toHtmlLang（documentElement.lang 同步值）', () => {
  it('zh → zh-CN，en → en', () => {
    expect(toHtmlLang('zh')).toBe('zh-CN');
    expect(toHtmlLang('en')).toBe('en');
  });
});
