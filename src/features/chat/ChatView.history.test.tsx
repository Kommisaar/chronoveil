// 历史行引擎静态渲染测试（TASK-12 / 审计问题 1 / ADR-011）：
// - 历史 assistant 行走 renderStaticMarkdown：动作斜体/加粗/场景线/列表与流式
//   同构，收尾重拉后不再回退成字面星号；
// - 历史 user 行保持纯文本（markdown-lite 是 assistant 叙事语法）；
// - 行元信息零回归（说话人/时间/思考折叠/中断标记）。
// api 层整体 vi.mock（同 sessionActivity.test.tsx 的 Harness）；i18n 固定中文，
// 断言用 zh 文案。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StreamEventHandler } from '../../api/events';
import type { CharacterSummary, ChatMessage } from '../../api/types';
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

const CHARACTER: CharacterSummary = {
  id: 1,
  name: '织星者',
  avatar: null,
  persona: '',
  gender: null,
  age: null,
  renderStyle: 'fade',
  modelConfig: null,
  accentColor: null,
  updatedAt: 0,
  sessionCount: 1,
};

const USER_MESSAGE: ChatMessage = {
  id: 101,
  sessionId: 3,
  characterId: null,
  role: 'user',
  content: '你好 *不解析*',
  reasoning: null,
  thinkMs: null,
  createdAt: 1_000,
  interrupted: false,
};

const ASSISTANT_MESSAGE: ChatMessage = {
  id: 100,
  sessionId: 3,
  characterId: 1,
  role: 'assistant',
  content: '*她抬起头*，声音很轻。\n\n**别走。**\n\n---\n\n- 甲\n- 乙',
  reasoning: '内心戏',
  thinkMs: 1500,
  createdAt: 2_000,
  interrupted: true,
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
  mocks.listMessages.mockResolvedValue([USER_MESSAGE, ASSISTANT_MESSAGE]);
  mocks.listCharacters.mockResolvedValue([CHARACTER]);
  mocks.getConfig.mockRejectedValue(new Error('配置缺席走引擎默认'));
  mocks.subscribeStream.mockImplementation((sessionId: number, handler: StreamEventHandler) => {
    handlers.set(sessionId, handler);
    return () => {
      handlers.delete(sessionId);
    };
  });
  useUiStore.setState({ activeSessionId: 3, sessions: [], sessionsLoaded: false });
});

afterEach(() => {
  cleanup();
  for (const sessionId of [...handlers.keys()]) streamHub.end(sessionId);
  handlers.clear();
  useUiStore.setState({ activeSessionId: null, sessions: [], sessionsLoaded: false });
});

it('历史 assistant 行走引擎静态渲染：动作/加粗/场景线/列表与流式同构', async () => {
  const view = renderView();
  await screen.findByText('织星者'); // 消息列表加载完成

  // 场景线：--- 产出 hr.scene 而非文本
  expect(view.container.querySelectorAll('hr.scene')).toHaveLength(1);
  // 动作斜体 / 加粗
  const actions = view.container.querySelectorAll('span.tok.action');
  expect(actions).toHaveLength(1);
  expect(actions[0]?.textContent).toBe('她抬起头');
  const bolds = view.container.querySelectorAll('span.tok.bold');
  expect(bolds).toHaveLength(1);
  expect(bolds[0]?.textContent).toBe('别走。');
  // 列表：uli 段落 + 项目符（与 static.test 同构断言）
  const ulis = view.container.querySelectorAll('.para.uli');
  expect(ulis).toHaveLength(2);
  expect(ulis[0]?.textContent).toBe('• 甲\n');
  expect(ulis[1]?.textContent).toBe('• 乙');
  // 不再回退成字面星号：assistant 侧无 markdown 标记残留
  expect(view.container.textContent).not.toContain('*她抬起头*');
  expect(view.container.textContent).not.toContain('**');
});

it('历史 user 行保持纯文本：markdown 标记不解析', async () => {
  renderView();
  const userBody = await screen.findByText('你好 *不解析*');
  expect(userBody.querySelectorAll('.tok')).toHaveLength(0);
  expect(userBody.querySelectorAll('.para')).toHaveLength(0);
  expect(userBody.textContent).toBe('你好 *不解析*');
});

it('历史行元信息零回归：说话人/时间/思考折叠/中断标记俱在', async () => {
  renderView();
  // 说话人头：user「你」/ assistant 角色名
  expect(await screen.findByText('你')).toBeTruthy();
  expect(screen.getByText('织星者')).toBeTruthy();
  // 钟面时间（HH:mm，时区无关的形状断言；两条消息各一个）
  expect(screen.getAllByText(/\d{2}:\d{2}/).length).toBe(2);
  // 思考折叠头带时长（1500ms → 1.5s）
  expect(screen.getByText(/思考过程 · 1\.5s/)).toBeTruthy();
  // 中断标记
  expect(screen.getByText('已中断')).toBeTruthy();
});
