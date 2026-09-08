import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { LanguageSetting } from '../api/types';
import { en } from './en';
import { zh } from './zh';

void i18next.use(initReactI18next).init({
  lng: 'zh',
  fallbackLng: 'zh',
  interpolation: { escapeValue: false },
  resources: { zh: { translation: zh }, en: { translation: en } },
});

/** system 档位解析：zh 前缀归中文，其余归英文（FR-009 界面语言） */
export function resolveSystemLanguage(): Exclude<LanguageSetting, 'system'> {
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** html lang 同步值（a11y：屏幕阅读器按 documentElement.lang 选音） */
export function toHtmlLang(lang: Exclude<LanguageSetting, 'system'>): string {
  return lang === 'zh' ? 'zh-CN' : 'en';
}
