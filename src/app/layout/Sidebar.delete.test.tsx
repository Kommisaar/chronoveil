// 会话删除确认流程接线测试（ADR-009 破坏性操作，Task-12）：从用户可观察行为
// 断言 Sidebar.tsx confirmDelete 的完整链路——点条目删除钮 → 确认对话框（文案
// 明示「聊天记录软删除」）→ confirm → deleteSession(目标 id) → store.removeSession
// （清单移除 + 活动会话指向被删项时置空）→ refreshSessions 全量重拉 → 对话框
// 关闭；失败路径 hint 落「删除失败：详情」且清单/对话框保留可原地重试；删除中
// deleting 态双钮禁用防重复提交。清单唯一数据源在 ui store（TASK-007），mock
// 骨架形态与 Sidebar.fork.test.tsx 同款（api/commands + api/events 工厂 mock）。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../../api/types';
import '../../i18n';
import { useUiStore } from '../../stores/ui';
import { Sidebar } from './Sidebar';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  listCharacters: vi.fn(),
  listWorlds: vi.fn(),
  createWorld: vi.fn(),
  listSessions: vi.fn(),
}));

// Sidebar 消费的 api 面只有四个函数（forkSession 等由 ledgerPanel 负责）
vi.mock('../../api/commands', () => ({
  createSession: mocks.createSession,
  deleteSession: mocks.deleteSession,
  listCharacters: mocks.listCharacters,
  listWorlds: mocks.listWorlds,
  createWorld: mocks.createWorld,
  listSessions: mocks.listSessions,
}));

vi.mock('../../api/events', () => ({
  subscribeStream: vi.fn(() => () => {}),
  subscribeTraces: vi.fn(() => () => {}),
}));

// 待删目标（当前活动会话）
const TARGET: SessionSummary = {
  id: 1,
  title: '雨夜来电',
  updatedAt: Date.now(),
  instances: [
    { id: 1, name: '旅人', isUser: true, characterId: 1, renderStyle: 'type' },
  ],
  forkedFromSessionId: null,
  forkAnchorSceneIdx: null,
};

// 不删的旁证条目（updated_at 更新，重拉排序在前）
const KEEPER: SessionSummary = {
  id: 2,
  title: '长夜将尽',
  updatedAt: TARGET.updatedAt + 60_000,
  instances: TARGET.instances,
  forkedFromSessionId: null,
  forkAnchorSceneIdx: null,
};

// 永不自行落定的 promise 句柄（deleting 态固定时点用）
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function renderSidebar() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <Sidebar />
    </FluentProvider>,
  );
}

// 公共前缀：点条目删除钮 → 确认对话框打开且正文带 ADR-009 软删除文案与目标会话名
function openDeleteDialog() {
  fireEvent.click(screen.getByRole('button', { name: '删除会话：雨夜来电' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByText(/会话「雨夜来电」将被删除/)).toBeTruthy();
  expect(screen.getByText(/聊天记录软删除/)).toBeTruthy();
}

// 对话框动作钮的可访问名（ConfirmDialog：取消 '取消' / 确认 '删除'，与清单条目
// 删除钮的 aria-label「删除会话：xxx」精确名不冲突）
const confirmBtn = () => screen.getByRole('button', { name: '删除' });
const cancelBtn = () => screen.getByRole('button', { name: '取消' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listCharacters.mockResolvedValue([]);
  mocks.listWorlds.mockResolvedValue([]);
  mocks.listSessions.mockResolvedValue([TARGET, KEEPER]);
  useUiStore.setState({
    activeSessionId: TARGET.id,
    sessions: [TARGET, KEEPER],
    sessionsLoaded: true,
  });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ activeSessionId: null, sessions: [], sessionsLoaded: false });
});

it('删除成功链路：confirm → deleteSession(1) → removeSession 生效（清单移除、活动会话置空）→ 重拉 → 对话框关闭', async () => {
  renderSidebar();
  openDeleteDialog();
  // 仅打开对话框不触发删除
  expect(mocks.deleteSession).not.toHaveBeenCalled();
  // 后端视角：目标已删，删除后的重拉只剩保留项
  mocks.listSessions.mockResolvedValue([KEEPER]);
  fireEvent.click(confirmBtn());
  expect(mocks.deleteSession).toHaveBeenCalledTimes(1);
  expect(mocks.deleteSession).toHaveBeenCalledWith(TARGET.id);
  // 本地即时收尾 + 全量重拉对齐：清单只剩保留项
  await waitFor(() => {
    expect(useUiStore.getState().sessions.map((s) => s.id)).toEqual([KEEPER.id]);
  });
  // 活动会话指向被删项 → removeSession 置空（回聊天空态）
  expect(useUiStore.getState().activeSessionId).toBeNull();
  // 重拉恰好两次：挂载重拉 + 删除后重拉
  expect(mocks.listSessions).toHaveBeenCalledTimes(2);
  // 对话框关闭、目标条目从清单消失
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByText('雨夜来电')).toBeNull();
  expect(screen.getByText('长夜将尽')).toBeTruthy();
});

it('删除失败：hint 落「删除失败：详情」（role=status），清单与对话框保留，可原地重试成功', async () => {
  renderSidebar();
  openDeleteDialog();
  mocks.deleteSession.mockRejectedValueOnce(new Error('库被锁'));
  fireEvent.click(confirmBtn());
  // 失败详情就地可见，文案带原始错误消息（Sidebar.tsx catch 分支的拼接格式）
  const hint = await screen.findByRole('status');
  expect(hint.textContent).toBe('删除失败：库被锁');
  // 清单保留：目标条目还在，且失败路径不触发重拉（listSessions 仅挂载那一次）
  expect(screen.getByText('雨夜来电')).toBeTruthy();
  expect(mocks.listSessions).toHaveBeenCalledTimes(1);
  // 对话框保持打开，双钮恢复可用 → 原地重试
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(confirmBtn().hasAttribute('disabled')).toBe(false);
  expect(cancelBtn().hasAttribute('disabled')).toBe(false);
  // 重试成功：同一链路照常收尾
  mocks.deleteSession.mockResolvedValueOnce(undefined);
  mocks.listSessions.mockResolvedValue([KEEPER]);
  fireEvent.click(confirmBtn());
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useUiStore.getState().sessions.map((s) => s.id)).toEqual([KEEPER.id]);
  });
  expect(mocks.deleteSession).toHaveBeenCalledTimes(2);
  expect(useUiStore.getState().activeSessionId).toBeNull();
});

it('删除进行中（deleting）：确认/取消双钮禁用，重复点击不产生第二次提交，放行后链路照常收尾', async () => {
  renderSidebar();
  openDeleteDialog();
  const pending = deferred();
  mocks.deleteSession.mockImplementation(() => pending.promise);
  mocks.listSessions.mockResolvedValue([KEEPER]);
  fireEvent.click(confirmBtn());
  await waitFor(() => expect(mocks.deleteSession).toHaveBeenCalledTimes(1));
  // busy：双钮禁用（ConfirmDialog 的 busy 契约），再点确认不重复提交
  expect(confirmBtn().hasAttribute('disabled')).toBe(true);
  expect(cancelBtn().hasAttribute('disabled')).toBe(true);
  fireEvent.click(confirmBtn());
  expect(mocks.deleteSession).toHaveBeenCalledTimes(1);
  // 请求放行 → removeSession + 重拉 + 对话框关闭照常
  act(() => {
    pending.resolve();
  });
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useUiStore.getState().sessions.map((s) => s.id)).toEqual([KEEPER.id]);
  });
  expect(useUiStore.getState().activeSessionId).toBeNull();
});
