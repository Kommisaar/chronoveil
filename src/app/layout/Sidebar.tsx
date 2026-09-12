// 第二层会话侧栏（结构照抄 relay-harbor 项目导航栏，仅在聊天视图显示）：
// 「会话」分组小字 + 工具钮（新建会话 / 收起）+ 会话清单（两行条目：标题 +
// 相对时间 meta，点击切换当前会话）。选中态为与活动栏同款的共享指示条
// （位移动画）+ 选中底色。
// 会话管理（TASK-007 / FR-007 / ADR-009）：
// - 新建：Fluent Dialog 三段式开局向导（FR-014 + 多角色第 1 步两步选人，表单
//   内聚在 NewSessionDialog）：选扮演位 → 选 LLM 阵容 → 开局表单（历法五选 /
//   起始锚 / 首场景可选字段，「直接开始」= opening 全空降级）→ createSession →
//   store 全量重拉（updated_at 倒序进列表）→ 新会话成为当前会话（视图已在聊天）；
// - 删除：条目删除钮 → Dialog 确认（文案明示「聊天记录软删除」，ADR-009）→
//   deleteSession → store.removeSession（当前会话指向被删项时置空，回聊天
//   空态）→ 全量重拉对齐；
// - 生成中的会话禁删（streamHub streaming/stopping，先取消再删不采用），
//   点击时就地轻提示；
// - 清单唯一数据源在 ui store（sessions / refreshSessions）：本组件挂载即重拉
//   （AppShell 仅聊天视图挂载本组件，从其他视图回来自然重拉，验收 3），
//   ChatView 同源读取，两侧不出现陈旧分叉（验收 4）。
// 条目入场动画：挂载时逐项浮现一次（app.css 的 sidebar-enter 全局类，
// 错开延迟经行内 --enter-delay 注入）。
// 右缘 handle（2026-09-08 用户要求）：点击收起/展开侧栏——root 只做
// 0/232 宽度裁切（overflow hidden + width 过渡），内容在内层固定 232px
// 的 inner 里滑出而非挤压；收起过渡结束后 inner 隐藏（两段式，避免
// 文本被压扁、焦点落入零宽区域）。
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  Add16Regular,
  Delete16Regular,
  PanelLeftContract16Regular,
} from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { CSSProperties } from 'react';
import { createSession, deleteSession, listCharacters } from '../../api/commands';
import type {
  CharacterSummary,
  SessionOpeningInput,
  SessionRosterMember,
  SessionSummary,
} from '../../api/types';
import { streamHub } from '../../features/chat/streamHub';
import { moveIndicator } from '../../components/indicatorMotion';
import { formatRelative } from '../../lib/relativeTime';
import { useUiStore } from '../../stores/ui';
import { NewSessionDialog } from './NewSessionDialog';

// 入场动画：淡入 + 8px 上移，逐项错开 16ms、错开总量钳制 240ms（过长
// 清单只对首屏节奏负责）。关键帧 sidebar-item-enter 落 app.css 全局
// （Griffel 不透出 keyframes 工具）；单一 enter 类经行内 CSS 变量取错开值
const ENTER_STAGGER_MS = 16;
const ENTER_STAGGER_CAP_MS = 240;
// 收起过渡（durationGentle）结束后再藏 inner 的宽限
const COLLAPSE_HIDE_MS = 220;
// 轻提示（禁删 / 操作失败）自动消隐
const HINT_CLEAR_MS = 4000;

function enterDelayStyle(index: number): CSSProperties {
  const delay = Math.min(index * ENTER_STAGGER_MS, ENTER_STAGGER_CAP_MS);
  return { '--enter-delay': `${delay}ms` } as CSSProperties;
}

/** 生成中的判定（FR-007 多路并发）：streamHub 有该会话的活动流跟踪即禁删。 */
function isGenerating(sessionId: number): boolean {
  const state = streamHub.stateOf(sessionId);
  return state !== null && (state.status === 'streaming' || state.status === 'stopping');
}

const useStyles = makeStyles({
  // root 只承担宽度裁切：宽度经行内样式注入（0 ↔ 232 过渡）
  root: {
    overflow: 'hidden',
    flexShrink: 0,
    transitionProperty: 'width',
    transitionDuration: tokens.durationGentle,
    transitionTimingFunction: tokens.curveDecelerateMid,
  },
  inner: {
    position: 'relative', // 共享指示条的定位包含块
    width: '232px', // 固定宽：收起时整体滑出被 root 裁掉，而非挤压换行
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    overflowY: 'auto',
  },
  // 会话条目行：选择按钮（占满）+ 删除钮；原条目的 marginLeft 上移到行
  row: {
    display: 'flex',
    alignItems: 'center',
    marginLeft: tokens.spacingHorizontalXS,
  },
  item: {
    flex: 1,
    minWidth: 0, // 标题省略号生效前提（flex 子项默认 min-width:auto）
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    minHeight: '44px',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground1,
    textDecoration: 'none',
    textAlign: 'left',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  itemActive: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Selected },
  },
  // 条目删除钮：低调常驻（前景三阶，悬停染危险色）；生成中禁删的守卫在
  // 点击路径上（requestDelete），不禁用按钮以便给出可发现的提示
  deleteBtn: {
    width: '28px',
    height: '28px',
    flexShrink: 0,
    marginRight: '2px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0px',
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground3,
    '> svg': { width: '16px', height: '16px', fontSize: '16px' },
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      color: tokens.colorPaletteRedForeground1,
    },
  },
  // 共享选中指示条：与活动栏同款（3×16 品牌色圆角竖条）。位置（translate）
  // 由 JS 写入——需 X+Y 双轴位移；默认隐藏，定位后显示。绝对定位子项不
  // 参与 flex/gap 布局；zIndex 提层防止选中底色压住竖条
  indicator: {
    position: 'absolute',
    zIndex: 1,
    left: '0',
    top: '0px',
    width: '3px',
    height: '16px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorBrandBackground,
    pointerEvents: 'none',
    visibility: 'hidden',
  },
  buttonReset: {
    border: 'none',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    cursor: 'pointer',
  },
  label: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // 头部行：标题 + 工具钮组（新建 / 收起）。行高 36 与活动栏首条目同带
  // （内层 padding-top 8 → 行跨 y 8-44），钮组右缘对齐会话条目右端
  section: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '36px',
    flexShrink: 0,
    padding: `0 0 ${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}`,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  sectionActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
  },
  // 头部图标钮（新建 / 收起共用规格；原生 button 手动抹平默认外观，
  // 不与 buttonReset 合并——后者的条目 padding 会覆盖此处的 0）
  iconBtn: {
    width: '36px',
    height: '36px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0px',
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    // 图标与活动栏同规格（20px）
    '> svg': { width: '20px', height: '20px', fontSize: '20px' },
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  title: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    display: 'block',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  empty: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  // 轻提示（生成中禁删 / 删除失败等）：就地一行，红字，自动消隐
  hint: {
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}`,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorPaletteRedForeground1,
  },
});

/** 会话侧栏（FR-007 多会话管理）：清单走 ui store 单一数据源，挂载即重拉。 */
export function Sidebar() {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const sessions = useUiStore((s) => s.sessions);
  const sessionsLoaded = useUiStore((s) => s.sessionsLoaded);
  const selectSession = useUiStore((s) => s.selectSession);
  const refreshSessions = useUiStore((s) => s.refreshSessions);
  const removeSession = useUiStore((s) => s.removeSession);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useUiStore((s) => s.toggleSidebarCollapsed);
  const [characters, setCharacters] = useState<CharacterSummary[] | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [innerHidden, setInnerHidden] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);

  // 订阅 streamHub 的版本号：生成中判定随流状态启停即时更新（禁删提示）
  useSyncExternalStore(streamHub.subscribe, streamHub.getVersion);

  // 挂载即全量重拉（验收 3）：AppShell 只在聊天视图挂载本组件——应用启动
  // 与从角色/设置视图回到聊天都会经这里刷新，不显示陈旧清单
  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // 现役角色清单：新建会话的选择列表 + 空标题条目的回退名（FR-007：标题
  // 缺省取首条用户消息，新建会话在首条消息前无标题）
  useEffect(() => {
    void listCharacters()
      .then(setCharacters)
      .catch(() => {
        // 拉取失败只影响新建列表与标题回退，不打断侧栏
        setCharacters([]);
      });
  }, []);

  // 轻提示自动消隐
  useEffect(() => {
    if (hint === null) return undefined;
    const timer = window.setTimeout(() => setHint(null), HINT_CLEAR_MS);
    return () => window.clearTimeout(timer);
  }, [hint]);

  // 条目标题：库中标题为空（新建会话尚无首条用户消息）时回退用户位实例名——
  // 多角色阵容制起标题派生来源从会话角色改为 instances 回显的用户位实例
  // （方案 §2.1「侧栏读 is_user」；instances 恒回显，空阵容才落「新会话」占位）。
  const displayTitle = (session: SessionSummary): string => {
    if (session.title !== '') return session.title;
    return session.instances.find((i) => i.isUser)?.name ?? t('sessions.untitled');
  };

  // 两段式收起：宽度过渡播完再藏 inner（隐藏后内容不可聚焦），展开时立即可见
  useEffect(() => {
    if (collapsed) {
      const timer = setTimeout(() => setInnerHidden(true), COLLAPSE_HIDE_MS);
      return () => clearTimeout(timer);
    }
    setInnerHidden(false);
    return undefined;
  }, [collapsed]);

  // 共享指示条定位与位移动画：选中态只落在当前会话项。sessions 数据
  // 就位后条目才出现，故入 deps。竖条纵向居中（(条目高-16)/2）、横向
  // 对齐条目左缘。
  useLayoutEffect(() => {
    const aside = asideRef.current;
    const indicator = indicatorRef.current;
    if (!aside || !indicator) return;
    const active = aside.querySelector<HTMLElement>('button[aria-current="page"]');
    if (!active) {
      indicator.style.visibility = 'hidden';
      return;
    }
    indicator.style.visibility = 'visible';
    moveIndicator(indicator, {
      x: active.offsetLeft,
      y: active.offsetTop + (active.offsetHeight - 16) / 2,
    });
  }, [activeSessionId, sessions]);

  // 删除入口（验收 2）：生成中禁删并就地提示（不采用先取消再删）；
  // 其余进确认对话框，文案明示聊天记录软删除（ADR-009）
  const requestDelete = (session: SessionSummary): void => {
    if (isGenerating(session.id)) {
      setHint(t('sessions.deleteBlocked'));
      return;
    }
    setDeleteTarget(session);
  };

  const confirmDelete = async (): Promise<void> => {
    if (deleteTarget === null) return;
    setDeleting(true);
    const target = deleteTarget;
    try {
      await deleteSession(target.id);
      // 本地即时收尾：清单移除 + 当前会话指向被删项时置空（回聊天空态），
      // 再全量重拉对齐（验收 2/3：删除后列表即时刷新）
      removeSession(target.id);
      setDeleteTarget(null);
      void refreshSessions();
    } catch (e) {
      setHint(`${t('sessions.deleteFailed')}${e instanceof Error ? `：${e.message}` : ''}`);
    } finally {
      setDeleting(false);
    }
  };

  // 新建会话（验收 1 / FR-014 开局向导两步选人）：createSession（阵容制 members，
  // title 恒 null——向导本切片不收集标题，后端取首条用户消息截断回填；opening =
  // null 即「直接开始」降级路径，后端同样 seed 默认锚开场行）→ 全量重拉
  // （updated_at 倒序进列表）→ 成为当前会话（selectSession 同时保证视图切到聊天）
  const createFromRoster = async (
    members: SessionRosterMember[],
    opening: SessionOpeningInput | null,
  ): Promise<void> => {
    if (creating) return;
    setCreating(true);
    try {
      const created = await createSession(members, null, opening);
      await refreshSessions();
      selectSession(created.id);
      setNewOpen(false);
    } catch (e) {
      setHint(`${t('sessions.createFailed')}${e instanceof Error ? `：${e.message}` : ''}`);
    } finally {
      setCreating(false);
    }
  };

  // 入场错开序号：按 JSX 书写顺序（= DOM 序）逐项递增；仅渲染期使用
  let enterIndex = 0;
  const nextEnter = () => enterDelayStyle(enterIndex++);

  return (
    <aside
      id="sessions-sidebar"
      ref={asideRef}
      className={styles.root}
      style={{ width: collapsed ? 0 : 232 }}
      aria-label={t('sessions.title')}
      aria-hidden={collapsed}
    >
      <div
        className={styles.inner}
        style={{ visibility: innerHidden ? 'hidden' : 'visible' }}
      >
        <div ref={indicatorRef} className={styles.indicator} aria-hidden="true" />
        <div className={mergeClasses(styles.section, 'sidebar-enter')} style={nextEnter()}>
          <span>{t('sessions.title')}</span>
          <span className={styles.sectionActions}>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => setNewOpen(true)}
              aria-haspopup="dialog"
              aria-label={t('sessions.new')}
              title={t('sessions.new')}
            >
              <Add16Regular />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={toggleSidebarCollapsed}
              aria-controls="sessions-sidebar"
              aria-expanded="true"
              aria-label={t('sessions.collapse')}
              title={t('sessions.collapse')}
            >
              <PanelLeftContract16Regular />
            </button>
          </span>
        </div>
        {!sessionsLoaded ? null : sessions.length === 0 ? (
          <div className={mergeClasses(styles.empty, 'sidebar-enter')} style={nextEnter()}>
            {t('sessions.empty')}
          </div>
        ) : (
          sessions.map((session) => {
            const active = session.id === activeSessionId;
            return (
              <div
                key={session.id}
                className={mergeClasses(styles.row, 'sidebar-enter')}
                style={nextEnter()}
              >
                <button
                  type="button"
                  className={mergeClasses(
                    styles.item,
                    styles.buttonReset,
                    active && styles.itemActive,
                  )}
                  onClick={() => selectSession(session.id)}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className={styles.label}>
                    <span className={styles.title}>{displayTitle(session)}</span>
                    <span className={styles.meta}>
                      {formatRelative(session.updatedAt, i18n.language)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.deleteBtn}
                  aria-label={`${t('sessions.delete')}：${displayTitle(session)}`}
                  title={t('sessions.delete')}
                  onClick={() => requestDelete(session)}
                >
                  <Delete16Regular />
                </button>
              </div>
            );
          })
        )}
        {hint !== null && (
          <div className={styles.hint} role="status">
            {hint}
          </div>
        )}
      </div>

      {/* 新建会话（FR-014 三段式开局向导）：选扮演位 → 选 LLM 阵容 → 开局表单；
          表单与提交逻辑内聚在 NewSessionDialog（app 层），本组件只负责开关与建会话执行 */}
      <NewSessionDialog
        open={newOpen}
        characters={characters}
        creating={creating}
        onOpenChange={setNewOpen}
        onCreate={(members, opening) => void createFromRoster(members, opening)}
      />

      {/* 删除确认：文案明示「聊天记录软删除」（ADR-009） */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(_, data) => {
          if (!data.open) setDeleteTarget(null);
        }}
      >
        <DialogSurface aria-describedby={undefined}>
          <DialogBody>
            <DialogTitle>{t('sessions.delete')}</DialogTitle>
            <DialogContent>
              {deleteTarget !== null
                ? t('sessions.deleteBody', { title: displayTitle(deleteTarget) })
                : null}
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
              >
                {t('sessions.cancel')}
              </Button>
              <Button
                appearance="primary"
                disabled={deleting}
                onClick={() => void confirmDelete()}
              >
                {t('sessions.deleteConfirm')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </aside>
  );
}
