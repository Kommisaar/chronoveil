// 会话侧栏「新建会话」开合接线测试（U5）：对话框 open 状态提升至 ui store 后，
// 侧栏「+」与聊天空态直达钮（ChatView.interaction.test.tsx）同源触发同一个
// store 开关；本文件只验证侧栏消费端的双向接线（置位开、复位关）。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '../../i18n';
import { useUiStore } from '../../stores/ui';
import { Sidebar } from './Sidebar';

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  listCharacters: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  subscribeStream: vi.fn(),
}));

vi.mock('../../api/commands', () => ({
  listSessions: mocks.listSessions,
  listCharacters: mocks.listCharacters,
  createSession: mocks.createSession,
  deleteSession: mocks.deleteSession,
}));

vi.mock('../../api/events', () => ({
  subscribeStream: mocks.subscribeStream,
}));

function renderSidebar() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <Sidebar />
    </FluentProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSessions.mockResolvedValue([]);
  mocks.listCharacters.mockResolvedValue([]);
  mocks.subscribeStream.mockImplementation(() => () => {});
  useUiStore.setState({
    activeSessionId: null,
    sessions: [],
    sessionsLoaded: false,
    newSessionOpen: false,
  });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({
    activeSessionId: null,
    sessions: [],
    sessionsLoaded: false,
    newSessionOpen: false,
  });
});

it('U5：侧栏「+」点击置位 store 开关并打开新建会话对话框', () => {
  renderSidebar();
  fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
  expect(useUiStore.getState().newSessionOpen).toBe(true);
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('U5：store 关闭动作经侧栏接线收合对话框（双向接线）', () => {
  renderSidebar();
  fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  act(() => {
    useUiStore.getState().closeNewSession();
  });
  expect(useUiStore.getState().newSessionOpen).toBe(false);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('C3：头部工具钮提示迁移 Fluent Tooltip——原生 title 移除，聚焦后 content 以 role="tooltip" 挂载', async () => {
  renderSidebar();
  const newBtn = screen.getByRole('button', { name: '新建会话' });
  expect(newBtn.getAttribute('title')).toBeNull();
  // label 关系：Fluent 把文案写到 trigger 的 aria-label（与原 aria-label 同值）；
  // content 仅在显示时挂载（label 模式无需常驻 DOM）——聚焦触发挂载，
  // 真实浏览器中的视觉浮现由 Fluent Tooltip 保证（jsdom 断言不到 CSS 显示）
  expect(newBtn.getAttribute('aria-label')).toBe('新建会话');
  fireEvent.focus(newBtn);
  expect(await screen.findByRole('tooltip')).toBeTruthy();
  expect(screen.getByRole('tooltip').textContent).toBe('新建会话');
});

it('A1：清单加载中渲染 StateBlock loading（此前整段空白）', () => {
  // 永不 resolve 的挂起 promise：固定「加载中」时点
  mocks.listSessions.mockImplementation(() => new Promise(() => {}));
  renderSidebar();
  expect(screen.getByText('正在加载会话…')).toBeTruthy();
});

it('A1：清单加载失败渲染 StateBlock error（role="alert"），重试接 refreshSessions 成功后回清单', async () => {
  mocks.listSessions.mockRejectedValueOnce(new Error('db down'));
  renderSidebar();
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText('会话清单加载失败')).toBeTruthy();
  // 重试：后端恢复 → 清单加载成功，回段内空态（store 单一数据源重拉）
  mocks.listSessions.mockResolvedValue([]);
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('还没有会话，选择一个角色开始吧')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('A1：加载完成后空清单保持段内级一行空态（不升页面级占位块）', async () => {
  renderSidebar();
  expect(await screen.findByText('还没有会话，选择一个角色开始吧')).toBeTruthy();
});
