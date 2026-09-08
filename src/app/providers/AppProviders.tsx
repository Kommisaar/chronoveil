// 全局 Provider：Fluent 主题（FR-009 界面主题，档位在 ui store，落盘阶段 6
// 接入 ADR-012）+ 语言解析与 html lang 同步（FR-009 界面语言）。
import { FluentProvider, webDarkTheme, webLightTheme } from '@fluentui/react-components';
import i18next from 'i18next';
import { useEffect, type ReactNode } from 'react';
import { useResolvedTheme } from '../../components/useResolvedTheme';
import { resolveSystemLanguage, toHtmlLang } from '../../i18n';
import { useUiStore } from '../../stores/ui';
import '../../i18n';

/** 应用级 Provider 组合：i18next（副作用初始化）+ Fluent 主题（ADR-011）。 */
export function AppProviders({ children }: { children: ReactNode }) {
  const themePref = useUiStore((s) => s.theme);
  const languagePref = useUiStore((s) => s.language);
  const resolvedTheme = useResolvedTheme(themePref);
  const resolvedLanguage = languagePref === 'system' ? resolveSystemLanguage() : languagePref;

  useEffect(() => {
    // html lang 与 UI 语言同步（a11y：屏幕阅读器按 documentElement.lang 选音）。
    // 全仓 changeLanguage 仅此一处；同步放在 changeLanguage 之前，避免其
    // 异步切换期间 lang 仍停留旧值。
    document.documentElement.lang = toHtmlLang(resolvedLanguage);
    void i18next.changeLanguage(resolvedLanguage);
  }, [resolvedLanguage]);

  return (
    <FluentProvider theme={resolvedTheme === 'dark' ? webDarkTheme : webLightTheme}>
      {children}
    </FluentProvider>
  );
}
