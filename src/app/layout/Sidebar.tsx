// 第二层会话侧栏（结构照抄 relay-harbor 项目导航栏，仅在聊天视图显示）：
// 「会话」分组小字 + 会话清单（两行条目：标题 + 相对时间 meta，点击切换
// 当前会话）。选中态为与活动栏同款的共享指示条（位移动画）+ 选中底色。
// 条目入场动画：挂载时逐项浮现一次（app.css 的 sidebar-enter 全局类，
// 错开延迟经行内 --enter-delay 注入）。
// 右缘 handle（2026-09-08 用户要求）：点击收起/展开侧栏——root 只做
// 0/232 宽度裁切（overflow hidden + width 过渡），内容在内层固定 232px
// 的 inner 里滑出而非挤压；收起过渡结束后 inner 隐藏（两段式，避免
// 文本被压扁、焦点落入零宽区域）。
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { PanelLeftContract16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { listSessions } from '../../api/commands';
import type { SessionSummary } from '../../api/types';
import { moveIndicator } from '../../components/indicatorMotion';
import { formatRelative } from '../../lib/relativeTime';
import { useUiStore } from '../../stores/ui';

// 入场动画：淡入 + 8px 上移，逐项错开 16ms、错开总量钳制 240ms（过长
// 清单只对首屏节奏负责）。关键帧 sidebar-item-enter 落 app.css 全局
// （Griffel 不透出 keyframes 工具）；单一 enter 类经行内 CSS 变量取错开值
const ENTER_STAGGER_MS = 16;
const ENTER_STAGGER_CAP_MS = 240;
// 收起过渡（durationGentle）结束后再藏 inner 的宽限
const COLLAPSE_HIDE_MS = 220;

function enterDelayStyle(index: number): CSSProperties {
  const delay = Math.min(index * ENTER_STAGGER_MS, ENTER_STAGGER_CAP_MS);
  return { '--enter-delay': `${delay}ms` } as CSSProperties;
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
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    minHeight: '44px',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    marginLeft: tokens.spacingHorizontalXS,
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
  // 头部行：标题 + 收起按钮（千问式——收起在侧栏内，展开在主区左上）。
  // 行高 36 与活动栏首条目同带（内层 padding-top 8 → 行跨 y 8-44），
  // 收起按钮右缘对齐会话条目右端（条目 marginLeft 4 ≈ 内层右 padding 差 1px）
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
  collapseBtn: {
    width: '36px',
    height: '36px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0px',
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'transparent',
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
});

/** 会话侧栏（FR-007 多会话管理；数据经 api 层读，mock 阶段为内存清单）。 */
export function Sidebar() {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const selectSession = useUiStore((s) => s.selectSession);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useUiStore((s) => s.toggleSidebarCollapsed);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [innerHidden, setInnerHidden] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void listSessions().then(setSessions);
  }, []);

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
            <button
              type="button"
              className={styles.collapseBtn}
              onClick={toggleSidebarCollapsed}
              aria-controls="sessions-sidebar"
              aria-expanded="true"
              aria-label={t('sessions.collapse')}
              title={t('sessions.collapse')}
            >
              <PanelLeftContract16Regular />
            </button>
          </div>
          {sessions.length === 0 ? (
            <div className={mergeClasses(styles.empty, 'sidebar-enter')} style={nextEnter()}>
              {t('sessions.empty')}
            </div>
          ) : (
            sessions.map((session) => {
              const active = session.id === activeSessionId;
              return (
                <button
                  key={session.id}
                  type="button"
                  className={mergeClasses(
                    styles.item,
                    styles.buttonReset,
                    'sidebar-enter',
                    active && styles.itemActive,
                  )}
                  style={nextEnter()}
                  onClick={() => selectSession(session.id)}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className={styles.label}>
                    <span className={styles.title}>{session.title}</span>
                    <span className={styles.meta}>{formatRelative(session.updatedAt, i18n.language)}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
    </aside>
  );
}
