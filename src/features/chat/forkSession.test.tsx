// 会话分叉 UI 链路测试（时间线分叉，Task-44）：场景行「从此分叉」入口 →
// 确认对话框（默认「原标题（分叉）」）→ forkSession 执行 → refreshSessions
// 单点重拉 + 选中新会话（对齐 Sidebar 新建会话路径）；失败错误就地可见
// （对话框不关闭，用户可修正重试）。
// Harness 从 ChatView.ledger.test.tsx 精简：api 层整体 vi.mock、i18n 固定中文、
// 直接渲染 LedgerPanel（面板自管数据拉取）。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SceneDto, SessionSummary } from '../../api/types';
import '../../i18n';
import { useUiStore } from '../../stores/ui';
import { LedgerPanel } from './ledgerPanel';

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
  listLlmCalls: vi.fn(),
  forkSession: vi.fn(),
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
  listLlmCalls: mocks.listLlmCalls,
  forkSession: mocks.forkSession,
}));

vi.mock('../../api/events', () => ({
  subscribeStream: vi.fn(() => () => {}),
  subscribeTraces: vi.fn(() => () => {}),
}));

const SESSION: SessionSummary = {
  id: 3,
  title: '雨夜来电',
  updatedAt: 0,
  instances: [
    { id: 1, name: '旅人', isUser: true, characterId: 1, renderStyle: 'type' },
    { id: 2, name: '守塔人', isUser: false, characterId: 2, renderStyle: 'ink' },
  ],
  forkedFromSessionId: null,
  forkAnchorSceneIdx: null,
};

const SCENES: SceneDto[] = [
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
];

/** 分叉成功的返回样例（新会话 id 9，溯源回显齐备）。 */
const FORKED: SessionSummary = {
  id: 9,
  title: '雨夜来电（分叉）',
  updatedAt: 1,
  instances: SESSION.instances,
  forkedFromSessionId: 3,
  forkAnchorSceneIdx: 2,
};

function renderPanel() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <LedgerPanel sessionId={3} />
    </FluentProvider>,
  );
}

/** 打开第 2 场的分叉对话框（场景行分叉钮的 aria 标注含场号）。 */
function openFork(): void {
  fireEvent.click(screen.getByRole('button', { name: '从此分叉：第2场' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSessions.mockResolvedValue([SESSION]);
  mocks.listCharacters.mockResolvedValue([]);
  mocks.getConfig.mockRejectedValue(new Error('配置缺席走引擎默认'));
  mocks.listScenes.mockResolvedValue(SCENES);
  mocks.listCharacterStates.mockResolvedValue([]);
  mocks.listLlmCalls.mockResolvedValue([]);
  useUiStore.setState({ activeSessionId: 3, sessions: [SESSION], sessionsLoaded: true });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ activeSessionId: null, sessions: [], sessionsLoaded: false });
});

it('分叉入口与默认标题：场景行点「从此分叉」弹确认框，标题预填「原标题（分叉）」，正文携带锚点场号', async () => {
  renderPanel();
  await screen.findByText('第2场');
  openFork();
  // 对话框文案：标题 + 锚点场插值 + 预填标题（默认「原标题（分叉）」）
  expect(await screen.findByText('分叉会话')).toBeTruthy();
  expect(screen.getByText('从「第2场」分叉出新会话，复制该场及其之前的消息与状态。')).toBeTruthy();
  const input = screen.getByLabelText('新会话标题') as HTMLInputElement;
  expect(input.value).toBe('雨夜来电（分叉）');
  // 未确认前不发起分叉
  expect(mocks.forkSession).not.toHaveBeenCalled();
});

it('确认执行：forkSession 以（会话, 锚点场 idx, 标题）调用，成功后 refreshSessions 单点重拉并选中新会话', async () => {
  mocks.forkSession.mockResolvedValue(FORKED);
  renderPanel();
  await screen.findByText('第2场');
  openFork();
  fireEvent.click(screen.getByRole('button', { name: '分叉' }));

  await waitFor(() => expect(mocks.forkSession).toHaveBeenCalledWith(3, 2, '雨夜来电（分叉）'));
  // 清单重拉（refreshSessions → listSessions）+ 选中新会话（selectSession）
  await waitFor(() => expect(mocks.listSessions).toHaveBeenCalled());
  await waitFor(() => expect(useUiStore.getState().activeSessionId).toBe(9));
  // 成功后对话框关闭
  await waitFor(() => expect(screen.queryByText('分叉会话')).toBeNull());
});

it('失败错误态就地可见：forkSession 拒绝对话框不关闭，错误文案可读（含锚点非法的 NotFound），不静默', async () => {
  mocks.forkSession.mockRejectedValue(
    Object.assign(new Error('scene #99 不存在（或已软删除）'), {
      name: 'ApiError',
      payload: { kind: 'notFound', entity: 'scene', id: 99 },
    }),
  );
  renderPanel();
  await screen.findByText('第2场');
  openFork();
  fireEvent.click(screen.getByRole('button', { name: '分叉' }));

  // 错误文案在对话框内可见（role=alert），进行中标记复位
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText('分叉失败：scene #99 不存在（或已软删除）')).toBeTruthy();
  expect(screen.getByText('分叉会话')).toBeTruthy();
  // 修正后可重试：第二次成功走完整收尾
  mocks.forkSession.mockResolvedValue(FORKED);
  fireEvent.click(screen.getByRole('button', { name: '分叉' }));
  await waitFor(() => expect(useUiStore.getState().activeSessionId).toBe(9));
});
