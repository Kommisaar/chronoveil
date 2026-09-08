// 解析后的明暗主题（FR-009 界面主题：档位 + 系统跟随监听）。
// 档位由调用方传入（ui store 或未来 settings 查询），本 hook 只负责
// system 档的 prefers-color-scheme 实时监听。
import { useEffect, useState } from 'react';
import type { ThemeSetting } from '../api/types';

export type ResolvedTheme = 'light' | 'dark';

export function useResolvedTheme(pref: ThemeSetting): ResolvedTheme {
  // jsdom 等测试环境无 matchMedia：缺 API 时视为亮色，仅影响测试
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false,
  );

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const listener = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', listener);
    return () => mq.removeEventListener('change', listener);
  }, []);

  return pref === 'dark' || (pref === 'system' && systemDark) ? 'dark' : 'light';
}
