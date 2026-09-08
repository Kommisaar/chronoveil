// 应用外壳（UI-001 布局基座；风格照抄 relay-harbor 双层导航）：第一层
// 活动栏（汉堡双态）+ 第二层会话侧栏（仅聊天视图，角色/设置页无二级
// 导航）+ 内容区。视图切换走 Zustand（无路由），聊天是常驻工作台，
// 角色/设置为页面（自带 page-enter 渐入）。
// 侧栏收合按钮为千问式（2026-09-08 用户要求）：收起在侧栏头部（‹），
// 展开在主区左上角（›）。
import { PanelLeftExpand16Regular } from '@fluentui/react-icons';
import { makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { CharactersView } from '../../features/characters/CharactersView';
import { ChatView } from '../../features/chat/ChatView';
import { SettingsView } from '../../features/settings/SettingsView';
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
  // 侧栏收起后的展开按钮：悬于主内容区左上角（千问同位）
  expandBtn: {
    position: 'absolute',
    top: '8px', // 与活动栏首条目同一水平带
    left: '12px',
    zIndex: 2,
    width: '36px',
    height: '36px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0px',
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    // 图标与活动栏同规格（20px）
    '> svg': { width: '20px', height: '20px', fontSize: '20px' },
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      color: tokens.colorNeutralForeground1,
    },
  },
});

export function AppShell() {
  const styles = useStyles();
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
        <button
          type="button"
          className={styles.expandBtn}
          style={{ left: railExpanded ? 212 : 60 }}
          onClick={toggleSidebarCollapsed}
          aria-controls="sessions-sidebar"
          aria-expanded="false"
          aria-label={t('sessions.expand')}
          title={t('sessions.expand')}
        >
            <PanelLeftExpand16Regular />
        </button>
      ) : null}
      <main className={styles.content}>
        {view === 'chat' && <ChatView />}
        {view === 'characters' && <CharactersView />}
        {view === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}
