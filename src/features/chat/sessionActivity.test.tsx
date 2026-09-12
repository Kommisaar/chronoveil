// 会话列表活性刷新接缝测试（TASK-010 / FR-007「每条新消息刷新」）。
// 验证三个事件时点 → store.refreshSessionsQuietly → listSessions 的接线：
// 1. streamHub 终态（done / error，含 cancel 形态 interrupted=true）——未激活
//    会话也触发（后台会话语义，FR-007 多路并发）；
// 2. 用户条落库（sendMessage 成功返回）、重新生成替换落库（regenerateLast）；
// 3. token / reasoning 增量不触发（事件级粒度，验收 3）；
// 4. 刷新失败静默降级，不阻塞聊天主路径（验收 4）。
// api 层整体 vi.mock（ADR-010 双模式允许 UI 层测试替换数据入口）；i18n 固定
// 中文（i18n/index 以 lng:'zh' 初始化），断言用 zh 文案。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../api/types';
import type { StreamEventHandler } from '../../api/events';
import '../../i18n';
import { useUiStore } from '../../stores/ui';
import { ChatView } from './ChatView';
import { CANCEL_REASON, streamHub } from './streamHub';

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

/** subscribeStream mock 捕获的每会话事件处理器：测试内直接投递事件驱动 hub */
const handlers = new Map<number, StreamEventHandler>();

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

const ASSISTANT_MESSAGE: ChatMessage = {
  id: 100,
  sessionId: 3,
  characterId: 1, // 说话实例真值（wire 定案）
  role: 'assistant',
  content: '旧回复',
  reasoning: null,
  thinkMs: null,
  createdAt: 900,
  interrupted: false,
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
});

it('streamHub 终态 → refreshSessions 被调用；token 增量不触发（验收 2/3）', () => {
  renderView();
  // 挂载本身不重拉清单（重拉是 Sidebar 挂载职责）
  expect(mocks.listSessions).not.toHaveBeenCalled();

  streamHub.begin(7);
  const handler = handlers.get(7);
  expect(handler).toBeDefined();

  // 正文 / 思考增量不重拉清单：事件级粒度，非每 token（验收 3）
  handler?.({ type: 'reasoning', sessionId: 7, messageId: -1, text: '想', reset: false });
  handler?.({ type: 'token', sessionId: 7, messageId: -1, text: '你', reset: false });
  handler?.({ type: 'token', sessionId: 7, messageId: -1, text: '好', reset: false });
  expect(mocks.listSessions).not.toHaveBeenCalled();

  handler?.({ type: 'done', sessionId: 7, messageId: -1, thinkMs: 12 });
  expect(mocks.listSessions).toHaveBeenCalledTimes(1);
  // 会话 7 并非激活会话（activeSessionId 为 null）也触发：后台会话终态同样刷新
  expect(useUiStore.getState().activeSessionId).toBeNull();
});

it('error 终态（cancel 形态 interrupted=true）→ refreshSessions 同样被调用（验收 2）', () => {
  renderView();
  streamHub.begin(8);
  handlers.get(8)?.({
    type: 'error',
    sessionId: 8,
    messageId: -1,
    reason: CANCEL_REASON,
    interrupted: true,
  });
  expect(mocks.listSessions).toHaveBeenCalledTimes(1);
});

it('刷新失败静默降级：listSessions 拒绝不冒泡、清单保持原状（验收 4）', async () => {
  mocks.listSessions.mockRejectedValueOnce(new Error('db down'));
  renderView();
  streamHub.begin(9);
  // 触发路径上不抛出；若拒绝未被吞掉，vitest 会以 unhandled rejection 判失败
  expect(() =>
    handlers
      .get(9)
      ?.({ type: 'done', sessionId: 9, messageId: -1, thinkMs: 0 }),
  ).not.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 清单未动（sessionsLoaded 未翻转），等下一事件时点或侧栏重挂兜底
  expect(useUiStore.getState().sessionsLoaded).toBe(false);
});

it('发送消息落库 → refreshSessions 被调用（验收 1）', async () => {
  useUiStore.setState({ activeSessionId: 3 });
  mocks.sendMessage.mockResolvedValue(USER_MESSAGE);
  renderView();
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: '你好' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledWith(3, '你好'));
  await waitFor(() => expect(mocks.listSessions).toHaveBeenCalledTimes(1));
});

it('重新生成替换落库 → refreshSessions 被调用（落库时点）', async () => {
  useUiStore.setState({ activeSessionId: 3 });
  mocks.listMessages.mockResolvedValue([ASSISTANT_MESSAGE]);
  mocks.regenerateLast.mockResolvedValue(ASSISTANT_MESSAGE);
  renderView();
  fireEvent.click(await screen.findByRole('button', { name: '重新生成' }));
  await waitFor(() => expect(mocks.regenerateLast).toHaveBeenCalledWith(3));
  await waitFor(() => expect(mocks.listSessions).toHaveBeenCalledTimes(1));
});
