// 人物状态手动清除 UI 链路测试（FR-012，Task-09）：状态行「清除状态」入口 →
// 确认对话框（键值插值文案）→ clearCharacterState 执行 → refreshTick 单点重拉
// （行立即从账本消失）；失败错误就地可见（对话框不关闭，用户可重试）。
// Harness 从 forkSession.test.tsx 精简：api 层整体 vi.mock、i18n 固定中文、
// 直接渲染 LedgerPanel（面板自管数据拉取）。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CharacterStateDto } from '../../api/types';
import '../../i18n';
import { LedgerPanel } from './ledgerPanel';

const mocks = vi.hoisted(() => ({
  listScenes: vi.fn(),
  listCharacterStates: vi.fn(),
  listLlmCalls: vi.fn(),
  forkSession: vi.fn(),
  clearCharacterState: vi.fn(),
}));

vi.mock('../../api/commands', () => ({
  listScenes: mocks.listScenes,
  listCharacterStates: mocks.listCharacterStates,
  listLlmCalls: mocks.listLlmCalls,
  forkSession: mocks.forkSession,
  clearCharacterState: mocks.clearCharacterState,
}));

vi.mock('../../api/events', () => ({
  subscribeStream: vi.fn(() => () => {}),
  subscribeTraces: vi.fn(() => () => {}),
}));

const STATES: CharacterStateDto[] = [
  {
    id: 11,
    instanceId: 1,
    scope: 'state',
    key: '情绪',
    value: '强撑镇定',
    expiry: 'scene_end',
    sourceScene: null,
    updatedAt: 1,
  },
  {
    id: 12,
    instanceId: 2,
    scope: 'relation',
    key: '对旅人的态度',
    value: '戒备渐消',
    expiry: null,
    sourceScene: null,
    updatedAt: 2,
  },
];

function renderPanel() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <LedgerPanel sessionId={3} />
    </FluentProvider>,
  );
}

/** 打开 id=11（情绪）行的清除对话框（行级清除钮的 aria 标注含键名）。 */
function openClear(): void {
  fireEvent.click(screen.getByRole('button', { name: '清除状态：情绪' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listScenes.mockResolvedValue([]);
  mocks.listCharacterStates.mockResolvedValue(STATES);
  mocks.listLlmCalls.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

it('清除入口与确认文案：状态行点「清除状态」弹确认框，正文携带键值插值；未确认前不发起清除', async () => {
  renderPanel();
  await screen.findByText('情绪：强撑镇定');
  openClear();
  // 对话框文案：标题 + 键值插值（含「后续结算不恢复」语义说明）
  expect(await screen.findByText('清除状态')).toBeTruthy();
  expect(
    screen.getByText(
      '将「情绪：强撑镇定」从人物状态中移除，后续结算不会恢复该状态。确定清除吗？',
    ),
  ).toBeTruthy();
  expect(mocks.clearCharacterState).not.toHaveBeenCalled();
  // Esc / 取消键不发起清除（受控开合走 onCancel）
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByText('清除状态')).toBeNull());
  expect(mocks.clearCharacterState).not.toHaveBeenCalled();
});

it('确认执行：clearCharacterState 以状态行 id 调用，成功后对话框关闭并单点重拉账本列表', async () => {
  mocks.clearCharacterState.mockResolvedValue(undefined);
  renderPanel();
  await screen.findByText('情绪：强撑镇定');
  const pullsBefore = mocks.listCharacterStates.mock.calls.length;
  openClear();
  fireEvent.click(screen.getByRole('button', { name: '清除' }));

  await waitFor(() => expect(mocks.clearCharacterState).toHaveBeenCalledWith(11));
  // refreshTick 单点重拉：面板既有的三列表拉取 effect 重跑（行立即从账本消失）
  await waitFor(() =>
    expect(mocks.listCharacterStates.mock.calls.length).toBeGreaterThan(pullsBefore),
  );
  // 成功后对话框关闭
  await waitFor(() => expect(screen.queryByText('清除状态')).toBeNull());
});

it('失败错误态就地可见：clearCharacterState 拒绝对话框不关闭，错误文案可读，不静默；修正后可重试', async () => {
  mocks.clearCharacterState.mockRejectedValueOnce(
    Object.assign(new Error('character_state #11 不存在（或已软删除）'), {
      name: 'ApiError',
      payload: { kind: 'notFound', entity: 'character_state', id: 11 },
    }),
  );
  mocks.clearCharacterState.mockResolvedValue(undefined);
  renderPanel();
  await screen.findByText('情绪：强撑镇定');
  openClear();
  fireEvent.click(screen.getByRole('button', { name: '清除' }));

  // 错误文案在对话框内可见（role=alert），进行中标记复位
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText('清除失败：character_state #11 不存在（或已软删除）')).toBeTruthy();
  expect(screen.getByText('清除状态')).toBeTruthy();
  // 修正后可重试：第二次成功走完整收尾
  fireEvent.click(screen.getByRole('button', { name: '清除' }));
  await waitFor(() => expect(mocks.clearCharacterState).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText('清除状态')).toBeNull());
});
