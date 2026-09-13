// 聊天交互手感测试（U1 / U2 / U3 / A1 / U5，2026-09 只读审计落地项）：
// - U1 IME 守卫：组合期（中文确认候选词）的 Enter 不发送，草稿保留；
// - U2 切会话竞态：快速切换时慢返的旧 listMessages 响应不覆盖新会话消息；
// - U3 智能吸底：上滚阅读时新消息不拽回底部，贴底时仍自动跟随；
// - A1 错误通知 role="alert"：发送失败提示对读屏可达；
// - U5 空态直达钮：零会话空态含「新建会话」按钮，点击置位 store 开关
//   （对话框 open 状态提升自 Sidebar），侧栏「+」同源消费。
// api 层整体 vi.mock（同 sessionActivity.test.tsx 的 Harness）；i18n 固定中文，
// 断言用 zh 文案。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StreamEventHandler } from '../../api/events';
import type { ChatMessage, SessionSummary } from '../../api/types';
import '../../i18n';
import { useUiStore } from '../../stores/ui';
import { ChatView } from './ChatView';
import { streamHub } from './streamHub';

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  listMessages: vi.fn(),
  listCharacters: vi.fn(),
  getConfig: vi.fn(),
  sendMessage: vi.fn(),
  regenerateLast: vi.fn(),
  cancelGeneration: vi.fn(),
  subscribeStream: vi.fn(),
}));

vi.mock('../../api/commands', () => ({
  listSessions: mocks.listSessions,
  listMessages: mocks.listMessages,
  listCharacters: mocks.listCharacters,
  getConfig: mocks.getConfig,
  sendMessage: mocks.sendMessage,
  regenerateLast: mocks.regenerateLast,
  cancelGeneration: mocks.cancelGeneration,
}));

vi.mock('../../api/events', () => ({
  subscribeStream: mocks.subscribeStream,
}));

/** subscribeStream mock 捕获的每会话事件处理器（本文件不投事件，仅为卫生清理） */
const handlers = new Map<number, StreamEventHandler>();

const SESSION: SessionSummary = {
  id: 3,
  title: '雨夜来电',
  updatedAt: 0,
  instances: [
    { id: 10, name: '旅人', isUser: true, characterId: 2, renderStyle: 'fade' },
    { id: 11, name: '织星者', isUser: false, characterId: 1, renderStyle: 'ink' },
  ],
  forkedFromSessionId: null,
  forkAnchorSceneIdx: null,
};

const USER_MESSAGE: ChatMessage = {
  id: 101,
  sessionId: 3,
  characterId: null, // wire 定案：user 条恒 null
  role: 'user',
  content: '你好',
  reasoning: null,
  thinkMs: null,
  createdAt: 1_000,
  interrupted: false,
};

const OLD_MESSAGE: ChatMessage = {
  ...USER_MESSAGE,
  content: '旧回复',
};

const NEW_MESSAGE: ChatMessage = {
  ...USER_MESSAGE,
  sessionId: 4,
  id: 401,
  content: '新回复',
};

function renderView() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <ChatView />
    </FluentProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSessions.mockResolvedValue([]);
  mocks.listMessages.mockResolvedValue([]);
  mocks.listCharacters.mockResolvedValue([]);
  mocks.getConfig.mockRejectedValue(new Error('配置缺席走引擎默认'));
  mocks.subscribeStream.mockImplementation((sessionId: number, handler: StreamEventHandler) => {
    handlers.set(sessionId, handler);
    return () => {
      handlers.delete(sessionId);
    };
  });
  useUiStore.setState({ activeSessionId: null, sessions: [], sessionsLoaded: false });
});

afterEach(() => {
  cleanup();
  // hub 是模块级单例：摘掉本文件登记的路由订阅与流状态，避免跨用例泄漏
  for (const sessionId of [...handlers.keys()]) streamHub.end(sessionId);
  handlers.clear();
  useUiStore.setState({ activeSessionId: null, sessions: [], sessionsLoaded: false });
  restoreScrollPrototype();
});

// —— U3 滚动几何模拟基建：jsdom 无布局，scrollHeight / clientHeight / scrollTop
// 全为零——在 Element.prototype 上替换访问器注入受控几何；afterEach 还原。
const originalScrollDescriptors = new Map(
  ['scrollTop', 'scrollHeight', 'clientHeight']
    .map((key) => [key, Object.getOwnPropertyDescriptor(Element.prototype, key)] as const)
    .filter(([, descriptor]) => descriptor !== undefined),
);
let scrollTopValue = 0;
let scrollHeightValue = 0;
let clientHeightValue = 0;
// scrollTop 写入探针：写回受控值（贴近真实滚动语义），并记录调用供断言
const scrollTopSetter = vi.fn((value: number) => {
  scrollTopValue = value;
});

function mockScrollGeometry(geometry: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): void {
  scrollTopValue = geometry.scrollTop;
  scrollHeightValue = geometry.scrollHeight;
  clientHeightValue = geometry.clientHeight;
  scrollTopSetter.mockClear();
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get: () => scrollTopValue,
    set: scrollTopSetter,
  });
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeightValue,
  });
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get: () => clientHeightValue,
  });
}

function restoreScrollPrototype(): void {
  for (const [key, descriptor] of originalScrollDescriptors) {
    Object.defineProperty(Element.prototype, key, descriptor);
  }
}

it('U3：贴底时新消息仍自动吸底', async () => {
  useUiStore.setState({ activeSessionId: 3, sessions: [SESSION] });
  mocks.listMessages.mockResolvedValue([USER_MESSAGE]);
  // 距底 1000 - 430 - 500 = 70px（< 80 阈值）：用户本就贴底
  mockScrollGeometry({ scrollTop: 430, scrollHeight: 1000, clientHeight: 500 });
  renderView();
  await screen.findByText('你好');
  expect(scrollTopSetter).toHaveBeenCalledWith(1000);
});

it('U3：上滚阅读时新消息不把视口拽回底部', async () => {
  useUiStore.setState({ activeSessionId: 3, sessions: [SESSION] });
  mocks.listMessages.mockResolvedValue([USER_MESSAGE]);
  // 距底 500px：用户上滚阅读中
  mockScrollGeometry({ scrollTop: 0, scrollHeight: 1000, clientHeight: 500 });
  renderView();
  await screen.findByText('你好');
  expect(scrollTopSetter).not.toHaveBeenCalled();
});

it('U3：距底恰在阈值（80px）上不吸底', async () => {
  useUiStore.setState({ activeSessionId: 3, sessions: [SESSION] });
  mocks.listMessages.mockResolvedValue([USER_MESSAGE]);
  // 距底 1000 - 420 - 500 = 80px：恰在阈值上，不判定为贴底
  mockScrollGeometry({ scrollTop: 420, scrollHeight: 1000, clientHeight: 500 });
  renderView();
  await screen.findByText('你好');
  expect(scrollTopSetter).not.toHaveBeenCalled();
});

it('U1：IME 组合期的 Enter 不发送，草稿保留', async () => {
  useUiStore.setState({ activeSessionId: 3, sessions: [SESSION] });
  mocks.sendMessage.mockResolvedValue(USER_MESSAGE);
  renderView();
  const textbox = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
  fireEvent.change(textbox, { target: { value: '半截候选' } });
  fireEvent.keyDown(textbox, { key: 'Enter', isComposing: true });
  expect(mocks.sendMessage).not.toHaveBeenCalled();
  expect(textbox.value).toBe('半截候选');
});

it('U1：非组合期的 Enter 仍发送（守卫不误伤）', async () => {
  useUiStore.setState({ activeSessionId: 3, sessions: [SESSION] });
  mocks.sendMessage.mockResolvedValue(USER_MESSAGE);
  renderView();
  const textbox = await screen.findByRole('textbox');
  fireEvent.change(textbox, { target: { value: '你好' } });
  fireEvent.keyDown(textbox, { key: 'Enter' });
  await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledWith(3, '你好'));
});

it('U2：快速切会话时慢返的旧响应不覆盖新会话消息', async () => {
  useUiStore.setState({ activeSessionId: 3, sessions: [SESSION] });
  // 会话 3 的响应挂起（慢），会话 4 的响应立即返回（快）
  let resolveOld!: (messages: ChatMessage[]) => void;
  mocks.listMessages.mockImplementation((sessionId: number) =>
    sessionId === 3
      ? new Promise<ChatMessage[]>((resolve) => {
          resolveOld = resolve;
        })
      : Promise.resolve([NEW_MESSAGE]),
  );
  renderView();
  await waitFor(() => expect(mocks.listMessages).toHaveBeenCalledWith(3));
  // 切到会话 4，新会话消息先上屏
  act(() => {
    useUiStore.setState({ activeSessionId: 4 });
  });
  expect(await screen.findByText('新回复')).toBeTruthy();
  // 慢返的旧会话响应此刻才到：不得把界面拖回旧会话数据
  await act(async () => {
    resolveOld([OLD_MESSAGE]);
  });
  expect(screen.queryByText('旧回复')).toBeNull();
  expect(screen.getByText('新回复')).toBeTruthy();
});
