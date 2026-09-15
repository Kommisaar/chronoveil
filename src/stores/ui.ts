import { create } from 'zustand';
import { listSessions } from '../api/commands';
import type { LanguageSetting, SessionSummary, ThemeSetting } from '../api/types';

export type View = 'chat' | 'characters' | 'worlds' | 'settings';

/** 卡面视觉方向（角色页/世界页三方向对比期）：gallery 陈列馆 / ledger 名册 / stage 舞台。 */
export type CardDirection = 'gallery' | 'ledger' | 'stage';

/** 会话清单排序约定（FR-007）：updated_at 倒序，落 store 前统一保证。 */
const byRecencyDesc = (a: SessionSummary, b: SessionSummary): number => b.updatedAt - a.updatedAt;

/**
 * 重拉请求序号（模块级单调递增）：refreshSessions 与 refreshSessionsQuietly
 * 共用此序号源（后者委托 get().refreshSessions()，天然同源）。并发重拉时仅
 * 序号等于最新值的响应可落 store，收敛「先发后至」竞态（Task-11：删除会话
 * 的重拉与流终态静默刷新并发时，陈旧响应不得把已删会话写回清单）。
 */
let refreshSeq = 0;

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
  /**
   * 会话清单最近一次重拉的失败详情（Task-11 提升自 Sidebar 本地标记）：错误态
   * 归属与清单数据同源（未来消费视图不必各自兜底）。存原始错误详情而非翻译
   * 文案——语言档位运行时可切且 store 跨视图存续，通用文案由消费组件 i18n
   * 渲染（形态对齐 SettingsView 的「t 前缀 + 详情追加」；describeError 同款
   * 收敛）。null = 最近一次重拉无失败；进入重拉即清值（错误态回加载态），
   * 成功保持 null。静默路径 refreshSessionsQuietly 的失败同样落值——落值不
   * 等于冒泡（不抛给调用方、不阻塞聊天路径，TASK-010 契约不变），仅让全局
   * 错误态如实反映最近一次重拉结果。并发重拉时失败按请求序号归属：仅最新
   * 请求的失败可落值，陈旧失败丢弃（Task-11，与清单写入同规则）。
   */
  sessionsLoadError: string | null;
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
  /**
   * 卡面方向偏好（三方向对比期基建，2026-09-15 用户拍板「都做做看」）：角色页
   * 与世界页共用同一档位，两页工具栏切换器同源读写（对比期视觉分支尚未接入，
   * 切换只改本值）。会话级状态不落盘——本 store 无 persist 中间件，重启回
   * 'gallery' 默认档。
   * TODO(对比期)：未完成原因——三方向卡面尚未实现，无法裁撤；移除条件——
   * 对比期结束用户拍板胜出方向后，败者方向与两页切换器一并裁撤（本字段
   * 收编为胜出方向的常量或彻底移除）。
   */
  cardDirection: CardDirection;
  setView: (view: View) => void;
  selectSession: (id: number) => void;
  /**
   * 全量重拉会话清单（TASK-007 刷新策略）：挂载进聊天视图、新建/删除后调用，
   * 排序在此收口。后端为唯一事实，前端不做增量补丁。并发重拉按发起序号归属
   * （Task-11）：仅最新请求的成功响应落清单，陈旧响应整体丢弃。失败落
   * sessionsLoadError 并保持原 rejection 契约——调用方仍须收敛 rejection（错误可见性走 store
   * 状态，异常路径仅是调用方流程控制，如 ledgerPanel 删除/分叉失败提示）。
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
  setCardDirection: (direction: CardDirection) => void;
}

/** 应用级 UI 路由状态（视图切换 + 当前会话 + 会话清单 + 界面偏好）；多路生成实例表在阶段 4 扩展（FR-007）。 */
export const useUiStore = create<UiState>()((set, get) => ({
  view: 'chat',
  activeSessionId: null,
  sessions: [],
  sessionsLoaded: false,
  sessionsLoadError: null,
  railExpanded: false,
  sidebarCollapsed: false,
  newSessionOpen: false,
  theme: 'system',
  language: 'system',
  cardDirection: 'gallery',
  setView: (view) => set({ view }),
  selectSession: (id) => set({ activeSessionId: id, view: 'chat' }),
  refreshSessions: async () => {
    // 发起即取序号：此后任何时刻 seq !== refreshSeq 都意味着已有更新的重拉
    // 在途或完成，本请求降级为陈旧请求
    const seq = ++refreshSeq;
    // 进入重拉即清错误（重试语义 = 错误态回加载态）
    set({ sessionsLoadError: null });
    try {
      const sessions = await listSessions();
      // 陈旧成功整体丢弃（清单与错误态都不写）：先发后至的响应不得覆盖最新
      // 清单（删除 × 终态刷新并发实坑，Task-11）
      if (seq !== refreshSeq) return;
      set({
        sessions: [...sessions].sort(byRecencyDesc),
        sessionsLoaded: true,
        sessionsLoadError: null,
      });
    } catch (e) {
      // 陈旧失败同样不落错误态（旧失败不得覆盖新成功）；rejection 契约不变
      // 仍上抛——调用方收敛职责不因陈旧而豁免（静默路径由 refreshSessionsQuietly 接住）
      if (seq !== refreshSeq) throw e;
      set({ sessionsLoadError: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },
  removeSession: (id) =>
    set((s) => ({
      sessions: s.sessions.filter((session) => session.id !== id),
      activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
    })),
  refreshSessionsQuietly: () => {
    void get().refreshSessions().catch(() => {
      // 静默：保持现有清单，等下一个事件时点再对齐（验收 4）；失败详情已落
      // sessionsLoadError（不冒泡给聊天路径，见该字段注释）
    });
  },
  toggleRailExpanded: () => set((s) => ({ railExpanded: !s.railExpanded })),
  toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  openNewSession: () => set({ newSessionOpen: true }),
  closeNewSession: () => set({ newSessionOpen: false }),
  setTheme: (theme) => set({ theme }),
  setLanguage: (language) => set({ language }),
  setCardDirection: (direction) => set({ cardDirection: direction }),
}));
