// 叙事账本面板测试（FR-012）：入口开关、两段渲染（状态分组 / 场景倒序与
// 时间标签取值链）、recap 折叠、空态、终态与换会话重拉、错误重试。
// api 层整体 vi.mock（同 ChatView.history.test.tsx 的 Harness）；i18n 固定中文，
// 断言用 zh 文案。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StreamEventHandler } from '../../api/events';
import type { CharacterSummary } from '../../api/types';
import '../../i18n';
import { useUiStore } from '../../stores/ui';
import { ChatView } from './ChatView';
import type { CharacterState, Scene } from './ledgerPanel';
import { streamHub } from './streamHub';

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  listMessages: vi.fn(),
  listCharacters: vi.fn(),
  getConfig: vi.fn(),
  sendMessage: vi.fn(),
  regenerateLast: vi.fn(),
  cancelGeneration: vi.fn(),
  listScenes: vi.fn(),
  listCharacterStates: vi.fn(),
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
  listScenes: mocks.listScenes,
  listCharacterStates: mocks.listCharacterStates,
}));

vi.mock('../../api/events', () => ({
  subscribeStream: mocks.subscribeStream,
}));

/** subscribeStream mock 捕获的每会话事件处理器（终态刷新用例投递 done 事件） */
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
  calendarConfig: null,
  updatedAt: 0,
  sessionCount: 1,
};

const SCENES: Scene[] = [
  // 第 1 场：dateLabel 在场 → 优先于 ficDay/ficPart 拼接
  {
    id: 31,
    idx: 1,
    location: '旅店大堂',
    timeNote: null,
    ficDay: 1,
    ficPart: '夜',
    dateLabel: '白蜡月·晨露日·夜',
    summary: '初到旧都',
    recap: null,
    present: [1],
  },
  // 第 2 场：元数据全空 → 行保留，仅场号可辨
  {
    id: 32,
    idx: 2,
    location: null,
    timeNote: null,
    ficDay: null,
    ficPart: null,
    dateLabel: null,
    summary: null,
    recap: null,
    present: [],
  },
  // 第 3 场：dateLabel 缺失 → 拼 ficDay/ficPart；recap 非空 → 出折叠块
  {
    id: 33,
    idx: 3,
    location: '灯塔',
    timeNote: null,
    ficDay: 3,
    ficPart: '夜',
    dateLabel: null,
    summary: '对峙',
    recap: '前情：旅店夜话，守塔人的警告犹在耳边。',
    present: [1, 2],
  },
];

const STATES: CharacterState[] = [
  {
    id: 41,
    characterId: 1,
    scope: 'state',
    key: '伤势',
    value: '左臂脱臼',
    expiry: 'scene_end', // 结算清算线索：面板不展示，测试断言不出现在 DOM
    sourceScene: 31,
    updatedAt: 1,
  },
  {
    id: 42,
    characterId: 1,
    scope: 'relation',
    key: '对守塔人',
    value: '戒备',
    expiry: null,
    sourceScene: 31,
    updatedAt: 2,
  },
];

function renderView() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <ChatView />
    </FluentProvider>,
  );
}

/** 打开叙事账本面板（点聊天列右上角浮动钮）。 */
function openLedger(): void {
  fireEvent.click(screen.getByRole('button', { name: '叙事账本' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSessions.mockResolvedValue([]);
  mocks.listMessages.mockResolvedValue([]);
  mocks.listCharacters.mockResolvedValue([CHARACTER]);
  mocks.getConfig.mockRejectedValue(new Error('配置缺席走引擎默认'));
  mocks.listScenes.mockResolvedValue(SCENES);
  mocks.listCharacterStates.mockResolvedValue(STATES);
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
  // hub 是模块级单例：摘掉本文件登记的路由订阅与流状态，避免跨用例泄漏
  for (const sessionId of [...handlers.keys()]) streamHub.end(sessionId);
  handlers.clear();
  useUiStore.setState({ activeSessionId: null, sessions: [], sessionsLoaded: false });
});

it('面板打开即拉取两列表，按当前会话查询；拉取中先见加载态', async () => {
  renderView();
  openLedger();
  // 加载态同步可见（promise 未 resolve 前渲染 spinner + 文案）
  expect(screen.getByText('加载中…')).toBeTruthy();
  expect(mocks.listScenes).toHaveBeenCalledWith(3);
  expect(mocks.listCharacterStates).toHaveBeenCalledWith(3);
  await screen.findByText('第3场');
});

it('两段渲染：状态按 scope 分组、expiry 不展示；场景倒序、时间标签按 dateLabel → ficDay/ficPart 取值链', async () => {
  const { container } = renderView();
  openLedger();
  await screen.findByText('第3场');

  // 人物状态：两组各自带标题；`key：value` 行；expiry（scene_end）不出现
  expect(screen.getByText('人物状态')).toBeTruthy();
  expect(screen.getByText('当前状态')).toBeTruthy();
  expect(screen.getByText('伤势：左臂脱臼')).toBeTruthy();
  expect(screen.getByText('关系')).toBeTruthy();
  expect(screen.getByText('对守塔人：戒备')).toBeTruthy();
  expect(container.textContent).not.toContain('scene_end');

  // 场景史：倒序（最新在上）
  const text = container.textContent ?? '';
  expect(text.indexOf('第3场')).toBeLessThan(text.indexOf('第2场'));
  expect(text.indexOf('第2场')).toBeLessThan(text.indexOf('第1场'));

  // 第 3 场：dateLabel 缺失 → 拼 ficDay/ficPart；地点与 summary 各就位
  expect(screen.getByText('第3日·夜')).toBeTruthy();
  expect(screen.getByText('灯塔')).toBeTruthy();
  expect(screen.getByText('对峙')).toBeTruthy();

  // 第 1 场：dateLabel 优先，不走 ficDay/ficPart 拼接
  expect(screen.getByText('白蜡月·晨露日·夜')).toBeTruthy();
  expect(screen.queryByText('第1日·夜')).toBeNull();

  // 第 2 场：元数据全空 → 行保留（场号可辨），无时间标签/地点/摘要
  expect(screen.getByText('第2场')).toBeTruthy();
});

it('recap 折叠：默认收起，点「展开回顾」后内容可见', async () => {
  renderView();
  openLedger();
  await screen.findByText('第3场');
  expect(screen.queryByText('前情：旅店夜话，守塔人的警告犹在耳边。')).toBeNull();
  fireEvent.click(screen.getByText('展开回顾'));
  await screen.findByText('前情：旅店夜话，守塔人的警告犹在耳边。');
});

it('空态：无状态显示「暂无状态记录」（组标题省略），无场景显示「本会话还没有场景记录」', async () => {
  mocks.listScenes.mockResolvedValue([]);
  mocks.listCharacterStates.mockResolvedValue([]);
  renderView();
  openLedger();
  expect(await screen.findByText('暂无状态记录')).toBeTruthy();
  expect(screen.getByText('本会话还没有场景记录')).toBeTruthy();
  expect(screen.queryByText('当前状态')).toBeNull();
  expect(screen.queryByText('关系')).toBeNull();
  expect(screen.queryByText(/第\d+场/)).toBeNull();
});

it('会话切换重拉：面板开着换 activeSessionId，按新会话重新查询', async () => {
  renderView();
  openLedger();
  await screen.findByText('第3场');
  expect(mocks.listScenes).toHaveBeenCalledTimes(1);
  act(() => {
    useUiStore.setState({ activeSessionId: 5 });
  });
  await waitFor(() => expect(mocks.listScenes).toHaveBeenCalledWith(5));
  await waitFor(() => expect(mocks.listCharacterStates).toHaveBeenCalledWith(5));
});

it('终态刷新：本会话 done 事件（已落库，ADR-005 done 放行前结算在库）触发静默重拉', async () => {
  renderView();
  openLedger();
  await screen.findByText('第3场');
  expect(mocks.listScenes).toHaveBeenCalledTimes(1);
  streamHub.begin(3);
  handlers.get(3)?.({ type: 'done', sessionId: 3, messageId: -1, thinkMs: 12 });
  await waitFor(() => expect(mocks.listScenes).toHaveBeenCalledTimes(2));
  expect(mocks.listScenes).toHaveBeenLastCalledWith(3);
});

it('错误重试：拉取失败显示错误与重试入口，重试成功恢复渲染', async () => {
  mocks.listScenes.mockRejectedValueOnce(new Error('db down'));
  renderView();
  openLedger();
  expect(await screen.findByText('叙事账本加载失败')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await screen.findByText('第3场');
  expect(mocks.listScenes).toHaveBeenCalledTimes(2);
});
