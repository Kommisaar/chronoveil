import { create } from 'zustand';
import { listSessions } from '../api/commands';
import type { LanguageSetting, SessionSummary, ThemeSetting } from '../api/types';

export type View = 'chat' | 'characters' | 'settings';

/** 会话清单排序约定（FR-007）：updated_at 倒序，落 store 前统一保证。 */
const byRecencyDesc = (a: SessionSummary, b: SessionSummary): number => b.updatedAt - a.updatedAt;

interface UiState {
  view: View;
  activeSessionId: number | null;
  /**
   * 会话清单单一数据源（TASK-007 / FR-007）：Sidebar 条目与 ChatView 的
   * 会话⇄角色映射都从这里读，杜绝两侧各自缓存 listSessions 的陈旧分叉。
   */
  sessions: SessionSummary[];
  /** 清单是否完成首次加载（首帧区分「未加载」与「确实无会话」） */
  sessionsLoaded: boolean;
  /** 活动栏展开态（汉堡双态：48px 收起 / 200px 展开），风格随 relay-harbor */
  railExpanded: boolean;
  /** 会话侧栏收起态（右缘 handle 切换，232px ↔ 0 宽度过渡） */
  sidebarCollapsed: boolean;
  /**
   * 新建会话对话框开合（U5 提升自 Sidebar 局部态）：聊天空态直达钮与侧栏
   * 「+」两个入口同源触发；对话框本体仍由 Sidebar 渲染（其挂载域与角色
   * 清单数据所在处）。
   */
  newSessionOpen: boolean;
  /** 界面主题档位（FR-009；界面原型即时生效，落盘在阶段 6 接入 ADR-012） */
  theme: ThemeSetting;
  /** 界面语言档位（FR-009） */
  language: LanguageSetting;
  setView: (view: View) => void;
  selectSession: (id: number) => void;
  /**
   * 全量重拉会话清单（TASK-007 刷新策略）：挂载进聊天视图、新建/删除后调用，
   * 排序在此收口。后端为唯一事实，前端不做增量补丁。
   */
  refreshSessions: () => Promise<void>;
  /**
   * 事件级活性刷新（TASK-010 / FR-007「每条新消息刷新」）：消息落库与生成终态
   * 时点由聊天侧触发，重排清单与相对时间。失败静默降级（TASK-010 验收 4）：
   * 清单非关键数据，任何错误都不冒泡、不阻塞聊天主路径；错过的事件由下一
   * 时点或侧栏重挂（挂载即重拉）兜底。
   */
  refreshSessionsQuietly: () => void;
  /** 删除会话后的本地即时收尾：清单移除 + 指向被删会话的 activeSessionId 置空（回聊天空态）。 */
  removeSession: (id: number) => void;
  toggleRailExpanded: () => void;
  toggleSidebarCollapsed: () => void;
  openNewSession: () => void;
  closeNewSession: () => void;
  setTheme: (theme: ThemeSetting) => void;
  setLanguage: (language: LanguageSetting) => void;
}

/** 应用级 UI 路由状态（视图切换 + 当前会话 + 会话清单 + 界面偏好）；多路生成实例表在阶段 4 扩展（FR-007）。 */
export const useUiStore = create<UiState>()((set, get) => ({
  view: 'chat',
  activeSessionId: null,
  sessions: [],
  sessionsLoaded: false,
  railExpanded: false,
  sidebarCollapsed: false,
  newSessionOpen: false,
  theme: 'system',
  language: 'system',
  setView: (view) => set({ view }),
  selectSession: (id) => set({ activeSessionId: id, view: 'chat' }),
  refreshSessions: async () => {
    const sessions = await listSessions();
    set({ sessions: [...sessions].sort(byRecencyDesc), sessionsLoaded: true });
  },
  removeSession: (id) =>
    set((s) => ({
      sessions: s.sessions.filter((session) => session.id !== id),
      activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
    })),
  refreshSessionsQuietly: () => {
    void get().refreshSessions().catch(() => {
      // 静默：保持现有清单，等下一个事件时点再对齐（验收 4）
    });
  },
  toggleRailExpanded: () => set((s) => ({ railExpanded: !s.railExpanded })),
  toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  openNewSession: () => set({ newSessionOpen: true }),
  closeNewSession: () => set({ newSessionOpen: false }),
  setTheme: (theme) => set({ theme }),
  setLanguage: (language) => set({ language }),
}));
