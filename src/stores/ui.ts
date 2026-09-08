import { create } from 'zustand';
import type { LanguageSetting, ThemeSetting } from '../api/types';

export type View = 'chat' | 'characters' | 'settings';

interface UiState {
  view: View;
  activeSessionId: number | null;
  /** 活动栏展开态（汉堡双态：48px 收起 / 200px 展开），风格随 relay-harbor */
  railExpanded: boolean;
  /** 会话侧栏收起态（右缘 handle 切换，232px ↔ 0 宽度过渡） */
  sidebarCollapsed: boolean;
  /** 界面主题档位（FR-009；界面原型即时生效，落盘在阶段 6 接入 ADR-012） */
  theme: ThemeSetting;
  /** 界面语言档位（FR-009） */
  language: LanguageSetting;
  setView: (view: View) => void;
  selectSession: (id: number) => void;
  toggleRailExpanded: () => void;
  toggleSidebarCollapsed: () => void;
  setTheme: (theme: ThemeSetting) => void;
  setLanguage: (language: LanguageSetting) => void;
}

/** 应用级 UI 路由状态（视图切换 + 当前会话 + 界面偏好）；多路生成实例表在阶段 4 扩展（FR-007）。 */
export const useUiStore = create<UiState>()((set) => ({
  view: 'chat',
  activeSessionId: null,
  railExpanded: false,
  sidebarCollapsed: false,
  theme: 'system',
  language: 'system',
  setView: (view) => set({ view }),
  selectSession: (id) => set({ activeSessionId: id, view: 'chat' }),
  toggleRailExpanded: () => set((s) => ({ railExpanded: !s.railExpanded })),
  toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setTheme: (theme) => set({ theme }),
  setLanguage: (language) => set({ language }),
}));
