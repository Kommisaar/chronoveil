// CharacterEditorDialog 主交互流补测（审计批次 C：全仓最复杂交互组件）。
// 经真实父级 CharactersView 挂载：脏守卫与「放弃未保存修改」确认对话框
// 是父级接线（guarded / onDirtyChange / pendingActionRef），只挂对话框壳
// 测不到关闭确认流。api 层整体 vi.mock（ADR-010 允许 UI 层测试替换数据
// 入口；本文件独立于 CharactersView.test 的共享 mock 种子，互不影响）。
// i18n 固定中文（i18n/index 以 lng:'zh' 初始化），断言用 zh 文案。
// 退场动画契约：关闭后组件留树播完 210ms 才 onClosed 卸载，等待放宽到 3s
// （与 CharactersView.test 同款）。
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
  draftCalendar: vi.fn(),
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
  calendarConfig: null,
  updatedAt: 100,
  sessionCount: 3,
};

const CONFIG: ConfigDto = {
  providers: [],
  activeProviderId: null,
  activeModel: null,
  rhythmMsPerChar: 60,
  punctPauseEnabled: true,
  animDurationBase: 300,
  uiLanguage: 'system',
  uiTheme: 'system',
  directorModel: null,
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

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
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
    // 保存可用（既有卡名称非空）
    expect(saveButton().disabled).toBe(false);
  });
});

describe('CharacterEditorDialog 改名与 canSave', () => {
  it('清空名称禁用保存并提示必填，改回有值恢复可用', async () => {
    renderView();
    await openEditorOf('林深');
    const name = startRename();
    expect(name.value).toBe('林深');
    expect(saveButton().disabled).toBe(false);

    fireEvent.change(name, { target: { value: '' } });
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText('名称必填')).toBeTruthy();

    fireEvent.change(name, { target: { value: '林深·改' } });
    expect(saveButton().disabled).toBe(false);
    expect(screen.queryByText('名称必填')).toBeNull();
  });

  it('保存：表单载荷交给 updateCharacter（角色 id + buildInput 序列化值）', async () => {
    renderView();
    await openEditorOf('林深');
    const name = startRename();
    fireEvent.change(name, { target: { value: '林深·改' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(mocks.updateCharacter).toHaveBeenCalledTimes(1));
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
    // 保存成功走静默关闭：退场动画播完对话框卸载（文本断言避免 role 假阴性）
    await waitFor(
      () => {
        expect(screen.queryByText('编辑角色')).toBeNull();
      },
      { timeout: 3000 },
    );
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

  it('Enter 提交：回展示态且保留新值（改名生效、未落库）', async () => {
    renderView();
    await openEditorOf('林深');
    const name = startRename();
    fireEvent.change(name, { target: { value: '林深·改' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(screen.queryByLabelText('名称')).toBeNull();
    // 展示态文本 + 左海报同时跟随新名
    expect(screen.getAllByText('林深·改').length).toBeGreaterThanOrEqual(2);
    // 未点保存不发请求
    expect(mocks.updateCharacter).not.toHaveBeenCalled();
  });
});

describe('放弃未保存修改确认流（父级脏守卫 × 编辑器关闭路径）', () => {
  it('改动后取消关闭 → 确认对话框出现；「继续编辑」保留改动留在编辑器', async () => {
    renderView();
    await openEditorOf('林深');
    const name = startRename();
    fireEvent.change(name, { target: { value: '林深（改）' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    // 父级 guarded 拦截 onClose，弹就地确认。确认框按钮用文本定位：编辑器
    // （非模态 Dialog）与确认框（模态 Dialog）同开时，Fluent/tabster 的
    // modalizer 竞态会把确认框 a11y 隐藏（时序偶发），role 查询会被过滤，
    // 文本查询不受影响；后续卸载断言同理不用 role（避免对隐藏态假阴性）。
    await screen.findByText('放弃未保存的修改？');
    fireEvent.click(await screen.findByText('继续编辑'));
    await waitFor(() => {
      expect(screen.queryByText('放弃未保存的修改？')).toBeNull();
    });
    // 编辑器未关，行内输入态与未提交值原样保留
    expect(screen.getByText('编辑角色')).toBeTruthy();
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('林深（改）');
  });

  it('改动后取消关闭 → 「放弃修改」→ 编辑器退场关闭、列表名保持原值、不发保存请求', async () => {
    renderView();
    await openEditorOf('林深');
    const name = startRename();
    fireEvent.change(name, { target: { value: '林深（改）' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await screen.findByText('放弃未保存的修改？');
    fireEvent.click(await screen.findByText('放弃修改'));

    await waitFor(
      () => {
        // 文本断言而非 role：确认框 a11y 隐藏竞态下 role 查询可能假阴性
        expect(screen.queryByText('编辑角色')).toBeNull();
      },
      { timeout: 3000 },
    );
    // 丢弃 = 不落库：卡片名原样
    expect(mocks.updateCharacter).not.toHaveBeenCalled();
    expect(screen.getByText('林深')).toBeTruthy();
  });
});

describe('历法区块与 AI 起草（FR-014 二期）', () => {
  /** mock draftCalendar 返回的旧都历样例（wire DTO 形态）。 */
  const DRAFTED = {
    name: '旧都历',
    months: ['霜月', '白蜡月', '融雪月'],
    daysPerMonth: 30,
    dayNames: ['晨露日', '萤火日'],
    // 节日界内（年长 = 3 月 × 30 天 = 90）：buildCalendar 越年拦截会让
    // canSave 变 false，保存用例载荷需要合法配置。
    festivals: { 45: '灯节', 90: '守夜' },
  };

  it('展开历法区块：未配置提示上屏，「AI 起草」打开对话框', async () => {
    renderView();
    await openEditorOf('林深');
    const header = screen.getByRole('button', { name: /^历法/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(screen.getAllByText(/未配置（默认数字历）/).length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole('button', { name: 'AI 起草' }));
    expect(await screen.findByText('AI 起草历法')).toBeTruthy();
  });

  it('AI 起草成功路径：应用到表单填入编辑态，保存载荷携带 calendarConfig', async () => {
    mocks.draftCalendar.mockResolvedValue(DRAFTED);
    renderView();
    await openEditorOf('林深');
    fireEvent.click(screen.getByRole('button', { name: /^历法/ }));
    fireEvent.click(screen.getByRole('button', { name: 'AI 起草' }));
    await screen.findByText('AI 起草历法');
    fireEvent.change(screen.getByLabelText('世界观描述'), {
      target: { value: '旧都的历法' },
    });
    // 内层模态对话框在外层非模态编辑器同开时会被 tabster 隐藏 a11y 树
    // （本文件上方同款已知现象），对话框内动作钮用文本查询。
    fireEvent.click(screen.getByText('起草'));
    // 结果预览上屏（格式化明细）后应用到表单
    await screen.findByText('月名（3）');
    fireEvent.click(screen.getByText('应用到表单'));
    // 填入编辑态（不自动保存）：编辑态字段上屏且带现值
    expect((screen.getByLabelText('每月天数') as HTMLInputElement).value).toBe('30');
    expect(
      (screen.getByLabelText('月名（每行一个）') as HTMLTextAreaElement).value,
    ).toContain('霜月');
    // 保存 → 整卡流载荷携带历法 wire DTO（持久化接线随 Rust/DTO 任务点亮）
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.updateCharacter).toHaveBeenCalledTimes(1));
    expect(mocks.updateCharacter).toHaveBeenCalledWith(
      2,
      expect.objectContaining({
        calendarConfig: expect.objectContaining({ name: '旧都历' }),
      }),
    );
  });

  it('AI 起草失败：就地错误文案与「重试」，重试成功后照常应用', async () => {
    mocks.draftCalendar
      .mockRejectedValueOnce(new Error('unavailable: 未配置模型服务'))
      .mockResolvedValueOnce(DRAFTED);
    renderView();
    await openEditorOf('林深');
    fireEvent.click(screen.getByRole('button', { name: /^历法/ }));
    fireEvent.click(screen.getByRole('button', { name: 'AI 起草' }));
    await screen.findByText('AI 起草历法');
    fireEvent.change(screen.getByLabelText('世界观描述'), {
      target: { value: '旧都的历法' },
    });
    // 内层模态对话框在外层非模态编辑器同开时会被 tabster 隐藏 a11y 树
    // （本文件上方同款已知现象），对话框内动作钮用文本查询。
    fireEvent.click(screen.getByText('起草'));
    expect(await screen.findByText('起草失败：unavailable: 未配置模型服务')).toBeTruthy();
    fireEvent.click(screen.getByText('重试'));
    await screen.findByText('月名（3）');
    fireEvent.click(screen.getByText('应用到表单'));
    expect((screen.getByLabelText('每月天数') as HTMLInputElement).value).toBe('30');
  });
});
