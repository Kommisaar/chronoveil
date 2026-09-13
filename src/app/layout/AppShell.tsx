// 应用外壳（UI-001 布局基座；风格照抄 relay-harbor 双层导航）：第一层
// 活动栏（汉堡双态）+ 第二层会话侧栏（仅聊天视图，角色/设置页无二级
// 导航）+ 内容区。视图切换走 Zustand（无路由），聊天是常驻工作台，
// 角色/设置为页面（自带 page-enter 渐入）。
// 侧栏收合按钮为千问式（2026-09-08 用户要求）：收起在侧栏头部（‹），
// 展开在主区左上角（›）。
import { PanelLeftExpand16Regular } from '@fluentui/react-icons';
import { makeStyles, mergeClasses, tokens, Tooltip } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { CharactersView } from '../../features/characters/CharactersView';
import { ChatView } from '../../features/chat/ChatView';
import { SettingsView } from '../../features/settings/SettingsView';
import { useGhostIconButtonStyles } from '../../components/useGhostIconButtonStyles';
import { useUiStore } from '../../stores/ui';
import { ActivityBar } from './ActivityBar';
import { Sidebar } from './Sidebar';

const useStyles = makeStyles({
  root: {
    position: 'relative', // 展开按钮的定位包含块
    display: 'flex',
    height: '100vh',
    overflow: 'hidden',
  },
  content: {
    flex: 1,
    minWidth: 0,
    overflowY: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  // 侧栏收起后的展开按钮：悬于主内容区左上角（千问同位）。外观/尺寸/悬停
  // 反馈由 useGhostIconButtonStyles('medium') 承载（36px 容器 + 20px 图标，
  // 与迁移前逐项一致）；本地特例只剩定位与不透明底——浮于滚动内容之上，
  // 钩子默认透明底会让内容从钮底透出（钩子头注预告的浮层覆写点）。
  expandBtn: {
    position: 'absolute',
    top: '8px', // 与活动栏首条目同一水平带
    left: '12px',
    zIndex: 2,
    backgroundColor: tokens.colorNeutralBackground1,
  },
});

export function AppShell() {
  const styles = useStyles();
  // 展开钮统一外观（medium 档：36px 容器 + 20px 图标）；禁用态恒不成立，
  // 不传 options
  const ghost = useGhostIconButtonStyles('medium');
  const { t } = useTranslation();
  const view = useUiStore((s) => s.view);
  const railExpanded = useUiStore((s) => s.railExpanded);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useUiStore((s) => s.toggleSidebarCollapsed);

  return (
    <div className={styles.root}>
      <ActivityBar />
      {view === 'chat' ? <Sidebar /> : null}
      {/* 展开按钮挂 root（main 是滚动容器，绝对定位会随内容滚走）；
          left 随活动栏宽度换算，视觉上贴主内容区左上角 */}
      {view === 'chat' && sidebarCollapsed ? (
        // 原生 title 换 Fluent Tooltip（审计 C3）：键盘 focus 也出提示；
        // below 贴近原 title 的弹出方位（主区左上角，右弹会压住正文）
        <Tooltip content={t('sessions.expand')} relationship="label" positioning="below">
          <button
            type="button"
            className={mergeClasses(ghost.root, styles.expandBtn)}
            style={{ left: railExpanded ? 212 : 60 }}
            onClick={toggleSidebarCollapsed}
            aria-controls="sessions-sidebar"
            aria-expanded="false"
            aria-label={t('sessions.expand')}
          >
              <PanelLeftExpand16Regular />
          </button>
        </Tooltip>
      ) : null}
      <main className={styles.content}>
        {view === 'chat' && <ChatView />}
        {view === 'characters' && <CharactersView />}
        {view === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}
