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
