// CharactersView 三态收编断言（A1）：列表加载中出 StateBlock loading（堵住
// 初始 [] 闪空态）、加载失败出 StateBlock error + 重试钮（重试走现有 refresh
// 单点重拉）、空库出 EmptyState。api 层整体 vi.mock（ADR-010；独立于
// CharactersView.test 的共享 mock 种子，互不影响）。i18n 固定中文。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterSummary } from '../../api/types';
import '../../i18n';
import { CharactersView } from './CharactersView';

const mocks = vi.hoisted(() => ({
  listCharacters: vi.fn(),
  getConfig: vi.fn(),
  createCharacter: vi.fn(),
  updateCharacter: vi.fn(),
  deleteCharacter: vi.fn(),
  exportCharacter: vi.fn(),
  importCharacter: vi.fn(),
}));

vi.mock('../../api/commands', () => ({ ...mocks }));

const LIN: CharacterSummary = {
  id: 2,
  name: '林深',
  avatar: null,
  persona: '旧书店老板',
  gender: '男',
  age: '31',
  renderStyle: 'ink',
  modelConfig: null,
  accentColor: null,
    animDurationMs: null,
    animRhythmMs: null,
    animPunctPause: null,
  updatedAt: 100,
  sessionCount: 3,
};

function renderView() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <CharactersView />
    </FluentProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConfig.mockResolvedValue({ providers: [] });
});

afterEach(cleanup);

describe('CharactersView 三态（A1 收编）', () => {
  it('列表在途且为空：StateBlock loading 占位，不闪空态文案', async () => {
    // 永不 resolve 的挂起请求模拟首帧加载窗口
    mocks.listCharacters.mockReturnValue(new Promise(() => {}));
    renderView();
    expect(await screen.findByText('加载中…')).toBeTruthy();
    expect(screen.queryByText('还没有角色，点击「新建角色」创建一张角色卡')).toBeNull();
    expect(screen.queryByText('林深')).toBeNull();
  });

  it('加载失败：StateBlock error（role="alert"）+ 重试钮；重试成功后网格上屏', async () => {
    mocks.listCharacters.mockRejectedValueOnce(new Error('backend down'));
    renderView();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('角色列表加载失败');
    expect(alert.textContent).toContain('backend down');

    // 重试走现有 refresh 单点重拉：恢复后列表渲染，错误与重试钮消失
    mocks.listCharacters.mockResolvedValueOnce([LIN]);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('林深')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(mocks.listCharacters).toHaveBeenCalledTimes(2);
  });

  it('空库：EmptyState 空态文案，无加载指示', async () => {
    mocks.listCharacters.mockResolvedValue([]);
    renderView();
    expect(
      await screen.findByText('还没有角色，点击「新建角色」创建一张角色卡'),
    ).toBeTruthy();
    expect(screen.queryByText('加载中…')).toBeNull();
  });
});
