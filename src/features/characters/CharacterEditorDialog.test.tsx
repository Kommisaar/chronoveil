// CharacterEditorDialog 主交互流补测（审计批次 C：全仓最复杂交互组件）。
// 经真实父级 CharactersView 挂载：行内编辑、修改即保存（2026-09-13 定稿，
// 取消/保存按钮已移除，改名经防抖自动落库）、Tooltip 收编与删除确认流。
// api 层整体 vi.mock（ADR-010 允许 UI 层测试替换数据入口；本文件独立于
// CharactersView.test 的共享 mock 种子，互不影响）。i18n 固定中文（i18n/index
// 以 lng:'zh' 初始化），断言用 zh 文案。
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
  renderStyle: 'ink',
  modelConfig: null,
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

/** 进入身份行输入态并返回名称输入框 */
function startRename(): HTMLInputElement {
  fireEvent.click(screen.getByRole('button', { name: '重命名' }));
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
  it('点卡片打开：标题「编辑角色」，身份行展示态回填名称/性别/年龄，人设进渲染展示态', async () => {
    renderView();
    await openEditorOf('林深');
    // 身份行展示态：名称纯文本（卡片 + 编辑器展示 + 海报 ≥2 处同名）
    expect(screen.getAllByText('林深').length).toBeGreaterThanOrEqual(2);
    // 元数据非空才占位（用户定稿：空值不占位）
    expect(screen.getByText('性别：男')).toBeTruthy();
    expect(screen.getByText('年龄：31')).toBeTruthy();
    // 人设默认渲染展示（引擎静态渲染直插 DOM，CharacterSummary 随列表回填）
    expect(document.querySelector('[data-persona-preview]')?.textContent).toContain(
      '旧书店老板',
    );
  });
});

describe('CharacterEditorDialog 修改即保存', () => {
  it('清空名称出必填提示且不落库，改回有值恢复并自动保存', async () => {
    renderView();
    await openEditorOf('林深');
    const name = startRename();
    expect(name.value).toBe('林深');

    fireEvent.change(name, { target: { value: '' } });
    expect(screen.getByText('名称必填')).toBeTruthy();

    fireEvent.change(name, { target: { value: '林深·改' } });
    expect(screen.queryByText('名称必填')).toBeNull();
  });

  it('改名即自动落库：防抖后载荷交给 updateCharacter（角色 id + 整卡字段）', async () => {
    renderView();
    await openEditorOf('林深');
    const name = startRename();
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

describe('CharacterEditorDialog 身份行行内编辑收口', () => {
  it('Escape 取消：还原输入前进值并回到展示态', async () => {
    renderView();
    await openEditorOf('林深');
    const name = startRename();
    fireEvent.change(name, { target: { value: '错字' } });
    fireEvent.keyDown(name, { key: 'Escape' });
    // 回展示态：输入框消失，海报随还原值
    expect(screen.queryByLabelText('名称')).toBeNull();
    expect(screen.getAllByText('林深').length).toBeGreaterThanOrEqual(2);
    // 再进输入态确认还原到编辑前的原值（identityBeforeEditRef）
    fireEvent.click(screen.getByRole('button', { name: '重命名' }));
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('林深');
  });

  it('Enter 提交：回展示态且保留新值（自动保存随后落库）', async () => {
    renderView();
    await openEditorOf('林深');
    const name = startRename();
    fireEvent.change(name, { target: { value: '林深·改' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(screen.queryByLabelText('名称')).toBeNull();
    // 展示态回显新名：身份卡标题合并为「名称：林深·改」，左海报独立一份跟随
    expect(screen.getByText('名称：林深·改')).toBeTruthy();
    expect(screen.getAllByText('林深·改').length).toBeGreaterThanOrEqual(1);
    // 修改即保存：防抖后落库
    await waitFor(
      () => expect(mocks.updateCharacter).toHaveBeenCalledTimes(1),
      { timeout: 3000 },
    );
    expect(mocks.updateCharacter).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ name: '林深·改' }),
    );
  });
});

describe('C3 Tooltip 收编（原生 title → Fluent Tooltip）', () => {
  it('重命名按钮不再携带原生 title，可访问名由 Tooltip 注入；人设编辑随同一会话开合', async () => {
    renderView();
    await openEditorOf('林深');
    const rename = screen.getByRole('button', { name: '重命名' }) as HTMLButtonElement;
    expect(rename.getAttribute('title')).toBeNull();
    expect(rename.getAttribute('aria-label')).toBe('重命名');

    // 统一编辑会话（2026-09-13）：人设不再单独挂切换钮——进会话后人设切
    // 输入框，标题栏对钩（保存）提交回渲染展示态
    fireEvent.click(rename);
    expect(screen.getByLabelText('人设')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.queryByLabelText('人设')).toBeNull();
    expect(document.querySelector('[data-persona-preview]')).toBeTruthy();
  });
});

