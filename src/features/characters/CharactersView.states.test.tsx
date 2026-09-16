// CharactersView 三态收编断言（A1）：列表加载中出 StateBlock loading（堵住
// 初始 [] 闪空态）、加载失败出 StateBlock error + 重试钮（重试走现有 refresh
// 单点重拉）、空库出 EmptyState。api 层整体 vi.mock（ADR-010；独立于
// CharactersView.test 的共享 mock 种子，互不影响）。i18n 固定中文。
// Task-14 追加「配置加载降级」块：getConfig 失败落编辑器「其他配置」卡的
// 可判定失败文案，与「未配置 provider」空列表区分。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterSummary, ConfigDto, ModelSpecDto } from '../../api/types';
import '../../i18n';

/** 模型元数据夹具：id 之外取缺省（1M 上下文 / 128K 输出 / 仅文本）。 */
const spec = (id: string): ModelSpecDto => ({
  id,
  contextWindow: 1000000,
  maxOutputTokens: 128000,
  inputTypes: ['text'],
  outputTypes: ['text'],
});
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
  titles: [],
  renderStyle: 'ink',
  modelProviderId: null,
  modelName: null,
  modelTemperature: null,
  modelTopP: null,
  modelFrequencyPenalty: null,
  modelPresencePenalty: null,
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
    expect(screen.queryByText('还没有角色。新建一位，或导入一张角色卡开始。')).toBeNull();
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
      await screen.findByText('还没有角色。新建一位，或导入一张角色卡开始。'),
    ).toBeTruthy();
    expect(screen.queryByText('加载中…')).toBeNull();
  });
});

describe('配置加载降级（Task-14）', () => {
  /** 渲染视图并点卡片打开既有角色编辑器，等对话框标题上屏。 */
  async function renderAndOpenEditor(): Promise<void> {
    renderView();
    fireEvent.click(await screen.findByText('林深'));
    await screen.findByRole('heading', { name: '编辑角色' });
  }

  it('getConfig 失败：主列表不受累，编辑器「其他配置」卡出可判定的失败文案（含原因）', async () => {
    mocks.listCharacters.mockResolvedValue([LIN]);
    mocks.getConfig.mockRejectedValue(new Error('backend down'));
    await renderAndOpenEditor();

    // 失败信号落在受影响的覆写下拉所在卡（role="alert"），文案含失败原因
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Provider 配置加载失败');
    expect(alert.textContent).toContain('backend down');
  });

  it('未配置 provider（空列表成功加载）：无失败文案，覆写下拉仅「跟随全局」——两种空可区分', async () => {
    mocks.listCharacters.mockResolvedValue([LIN]);
    await renderAndOpenEditor();

    // 加载成功路径不落错误信号（区别于加载失败的空列表）：无全局默认可选，
    // 模型设置级联钮跟随态禁用且显示「跟随全局」
    expect(screen.queryByRole('alert')).toBeNull();
    const trigger = screen.getByRole('button', { name: '模型设置' });
    expect(trigger).toHaveProperty('disabled', true);
    expect(trigger.textContent).toContain('跟随全局');
  });

  it('getConfig 成功（有 provider）：覆写下拉选项齐全且无失败文案（成功路径不回归）', async () => {
    const config: ConfigDto = {
      providers: [
        { id: 'p1', name: 'OpenAI', baseUrl: 'https://example.test', apiKey: 'k', models: [spec('gpt')], api: 'openai' },
      ],
      activeProviderId: 'p1',
      activeModel: 'gpt',
      rhythmMsPerChar: 60,
      renderStyle: 'type',
      punctPauseEnabled: true,
      animDurationBase: 300,
      uiLanguage: 'system',
      uiTheme: 'system',
      directorModel: null,
      nearScenes: 2,
      systemPrompt: '',
      temperature: 0.7,
      topP: 1.0,
      frequencyPenalty: 0.0,
      presencePenalty: 0.0,
    };
    mocks.listCharacters.mockResolvedValue([LIN]);
    mocks.getConfig.mockResolvedValue(config);
    await renderAndOpenEditor();

    expect(screen.queryByRole('alert')).toBeNull();
    // 切自定义（以全局默认 OpenAI / gpt 写卡）后开级联菜单：服务与模型叶子齐全
    fireEvent.click(
      [...screen.getByRole('radiogroup', { name: '模型设置' }).querySelectorAll('[role="radio"]')]
        .find((r) => r.textContent === '自定义')!,
    );
    fireEvent.click(screen.getByRole('button', { name: '模型设置' }));
    fireEvent.click(screen.getByRole('option', { name: 'OpenAI' }));
    // 二级叶子显裸名（2026-09-14 去父级前缀；服务名在父行上）；
    // 「默认模型」叶子已删（2026-09-15），叶子只有真实模型
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('gpt');
    expect(options).not.toContain('默认模型');
  });
});
