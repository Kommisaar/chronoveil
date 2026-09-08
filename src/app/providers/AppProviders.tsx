// 全局 Provider：Fluent 主题（FR-009 界面主题，档位在 ui store；启动经
// getConfig 从 config.json 引导落盘值，ADR-012 / TASK-009）+ 语言解析与
// html lang 同步（FR-009 界面语言）。
import { FluentProvider, webDarkTheme, webLightTheme } from '@fluentui/react-components';
import i18next from 'i18next';
import { useEffect, useRef, type ReactNode } from 'react';
import { getConfig } from '../../api/commands';
import { useResolvedTheme } from '../../components/useResolvedTheme';
import {
  normalizeLanguageSetting,
  normalizeThemeSetting,
} from '../../features/settings/preferences';
import { resolveSystemLanguage, toHtmlLang } from '../../i18n';
import { useUiStore } from '../../stores/ui';
import '../../i18n';

/** 应用级 Provider 组合：i18next（副作用初始化）+ Fluent 主题（ADR-011）。 */
export function AppProviders({ children }: { children: ReactNode }) {
  const themePref = useUiStore((s) => s.theme);
  const languagePref = useUiStore((s) => s.language);
  // 偏好动作只调用既有 setTheme/setLanguage，不改 store 定义
  const setTheme = useUiStore((s) => s.setTheme);
  const setLanguage = useUiStore((s) => s.setLanguage);
  const resolvedTheme = useResolvedTheme(themePref);
  const resolvedLanguage = languagePref === 'system' ? resolveSystemLanguage() : languagePref;

  // 启动引导（TASK-009 / ADR-012）：getConfig 一次，把 ui_theme / ui_language
  // 同步进 ui store，设置页与全局主题/语言以此预填。失败不阻塞启动——坏
  // config 的可读错误由设置页载入路径完整呈现（ADR-012 快速失败语义）。
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void getConfig()
      .then((config) => {
        setTheme(normalizeThemeSetting(config.uiTheme));
        setLanguage(normalizeLanguageSetting(config.uiLanguage));
      })
      .catch(() => {
        // 引导失败按 ui store 默认档位继续
      });
  }, [setTheme, setLanguage]);

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
