// CharacterEditorDialog 主交互流补测（审计批次 C：全仓最复杂交互组件）。
// 经真实父级 CharactersView 挂载：身份行常驻编辑（2026-09-15 重设计，整卡
// 编辑会话裁撤）、修改即保存（2026-09-13 定稿，改名经防抖自动落库）与人设
// 独立「预览|编辑」切换。api 层整体 vi.mock（ADR-010 允许 UI 层测试替换数据
// 入口；本文件独立于 CharactersView.test 的共享 mock 种子，互不影响）。
// i18n 固定中文（i18n/index 以 lng:'zh' 初始化），断言用 zh 文案。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterSummary, ConfigDto } from '../../api/types';
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
  titles: [],
  renderStyle: 'ink',
  modelProviderId: null,
  modelName: null,
  modelTemperature: null,
  accentColor: null,
    animDurationMs: null,
    animRhythmMs: null,
    animPunctPause: null,
  updatedAt: 100,
  sessionCount: 3,
};

const CONFIG: ConfigDto = {
  providers: [],
  activeProviderId: null,
  activeModel: null,
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
};

function renderView() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <CharactersView />
    </FluentProvider>,
  );
}

/** 点卡片打开既有角色编辑，等对话框标题上屏 */
async function openEditorOf(name: string): Promise<void> {
  fireEvent.click(await screen.findByText(name));
  await screen.findByRole('heading', { name: '编辑角色' });
}

/** 身份行常驻输入态：名称输入框直接可取（无重命名按钮，2026-09-15 重设计） */
function nameInput(): HTMLInputElement {
  return screen.getByLabelText('名称') as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listCharacters.mockResolvedValue([LIN]);
  mocks.getConfig.mockResolvedValue(CONFIG);
  mocks.updateCharacter.mockResolvedValue(null);
  mocks.createCharacter.mockResolvedValue(LIN);
});

afterEach(cleanup);

describe('CharacterEditorDialog 打开与回填（编辑既有卡）', () => {
  it('点卡片打开：标题「编辑角色」，身份行输入框常驻回填，人设进渲染预览态', async () => {
    renderView();
    await openEditorOf('林深');
    // 常驻编辑：输入框直接在（无重命名按钮）
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('林深');
    expect((screen.getByLabelText('性别') as HTMLInputElement).value).toBe('男');
    expect((screen.getByLabelText('年龄') as HTMLInputElement).value).toBe('31');
    expect(screen.queryByRole('button', { name: '重命名' })).toBeNull();
    // 人设默认渲染预览（引擎静态渲染直插 DOM，CharacterSummary 随列表回填）
    expect(document.querySelector('[data-markdown-preview]')?.textContent).toContain(
      '旧书店老板',
    );
  });
});

describe('CharacterEditorDialog 修改即保存', () => {
  it('清空名称出必填提示且不落库，改回有值恢复并自动保存', async () => {
    renderView();
    await openEditorOf('林深');
    const name = nameInput();
    expect(name.value).toBe('林深');

    fireEvent.change(name, { target: { value: '' } });
    expect(screen.getByText('名称必填')).toBeTruthy();

    fireEvent.change(name, { target: { value: '林深·改' } });
    expect(screen.queryByText('名称必填')).toBeNull();
  });

  it('改名即自动落库：防抖后载荷交给 updateCharacter（角色 id + 整卡字段）', async () => {
    renderView();
    await openEditorOf('林深');
    const name = nameInput();
    fireEvent.change(name, { target: { value: '林深·改' } });

    await waitFor(
      () => expect(mocks.updateCharacter).toHaveBeenCalledTimes(1),
      { timeout: 3000 },
    );
    expect(mocks.updateCharacter).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        name: '林深·改',
        persona: '旧书店老板',
        renderStyle: 'ink',
        gender: '男',
        age: '31',
      }),
    );
    // 自动保存不关闭编辑器（不再有「保存即退出」语义）
    expect(screen.getByText('编辑角色')).toBeTruthy();
  });
});

describe('CharacterEditorDialog 人设独立切换（2026-09-15 自整卡会话拆出）', () => {
  /** 切换人设「预览|编辑」分段。 */
  function switchPersonaMode(mode: '预览' | '编辑') {
    const group = screen.getByRole('radiogroup', { name: '人设视图' });
    fireEvent.click(
      [...group.querySelectorAll('[role="radio"]')].find((r) => r.textContent === mode)!,
    );
  }

  it('默认渲染预览；切编辑出 textarea 并改文落库；切回预览渲染新文', async () => {
    renderView();
    await openEditorOf('林深');
    // 默认预览态（人设编辑不随身份行——两者已无共享会话）
    expect(document.querySelector('[data-markdown-preview]')).toBeTruthy();
    expect(screen.queryByLabelText('人设')).toBeNull();

    switchPersonaMode('编辑');
    const textarea = screen.getByLabelText('人设') as HTMLTextAreaElement;
    expect(textarea.value).toBe('旧书店老板');
    fireEvent.change(textarea, { target: { value: '旧书店老板，业余侦探。' } });
    await waitFor(
      () => expect(mocks.updateCharacter).toHaveBeenCalledWith(
        2,
        expect.objectContaining({ persona: '旧书店老板，业余侦探。' }),
      ),
      { timeout: 3000 },
    );

    switchPersonaMode('预览');
    expect(
      document.querySelector('[data-markdown-preview]')?.textContent,
    ).toContain('旧书店老板，业余侦探。');
    expect(screen.queryByLabelText('人设')).toBeNull();
  });
});

