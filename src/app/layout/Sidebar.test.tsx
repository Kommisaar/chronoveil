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
    sessionsLoadError: null,
    newSessionOpen: false,
    sidebarCollapsed: false,
  });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({
    activeSessionId: null,
    sessions: [],
    sessionsLoaded: false,
    sessionsLoadError: null,
    newSessionOpen: false,
    sidebarCollapsed: false,
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

// Task-14：收起宽限窗（inner 延迟 visibility:hidden 的 220ms，对齐
// Sidebar.tsx 的 COLLAPSE_HIDE_MS）内 Tab 曾可落入零宽 aria-hidden 子树的
// 删除/新建钮。修复 = 收起同帧挂 inert；jsdom 不做 Tab 焦点遍历，按 HTML
// 标准断言 inert 的焦点排除语义（inert 子树内后代不可聚焦）即等价断言。
it('Task-14：收起同帧 inner 挂 inert（宽限窗内 aria-hidden 子树不可聚焦），220ms 后才 visibility:hidden', () => {
  vi.useFakeTimers();
  try {
    renderSidebar();
    const aside = screen.getByRole('complementary');
    const inner = aside.firstElementChild as HTMLElement;
    expect(inner.hasAttribute('inert')).toBe(false);
    expect(inner.style.visibility).toBe('visible');

    act(() => {
      useUiStore.getState().toggleSidebarCollapsed();
    });

    // 同帧：aria-hidden 翻 true 的同一渲染里 inert 已在场（键盘可达性即时
    // 收敛），而 visibility 宽限仍在（只留给过渡视觉）——两机制时序刻意错开
    expect(aside.getAttribute('aria-hidden')).toBe('true');
    expect(inner.hasAttribute('inert')).toBe(true);
    expect(inner.style.visibility).toBe('visible');
    // 侧栏内全部按钮都落在 inert 子树里：Tab 落不进零宽区
    const buttons = Array.from(aside.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const btn of buttons) {
      expect(inner.contains(btn)).toBe(true);
    }

    // 宽限播完：visibility 才转 hidden，inert 持续在场
    act(() => {
      vi.advanceTimersByTime(220); // 对齐 Sidebar.tsx 的 COLLAPSE_HIDE_MS
    });
    expect(inner.style.visibility).toBe('hidden');
    expect(inner.hasAttribute('inert')).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('Task-14：展开同帧摘除 inert 并恢复可见（宽限只留给收起方向）', () => {
  renderSidebar();
  const aside = screen.getByRole('complementary');
  const inner = aside.firstElementChild as HTMLElement;

  act(() => {
    useUiStore.getState().toggleSidebarCollapsed();
  });
  expect(inner.hasAttribute('inert')).toBe(true);

  act(() => {
    useUiStore.getState().toggleSidebarCollapsed();
  });
  expect(aside.getAttribute('aria-hidden')).toBe('false');
  expect(inner.hasAttribute('inert')).toBe(false);
  expect(inner.style.visibility).toBe('visible');
});
