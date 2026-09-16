/**
 * 新建会话四段式对话框测试（FR-014 开局向导 + 多角色两步选人 + 0017 世界
 * 必选）：
 * - ① 「世界」：单选 1 张（不选则「下一步」禁用）；空清单出指引；内联建卡
 *   （填名点建 → onCreateWorld 落库 → 新建卡即选中，下一步解禁）；
 * - ② 「你的角色」：单选 1 张 = 用户扮演位（D2 必选——不选则「下一步」禁用）；
 * - ③ 「LLM 阵容」：多选 ≥1 张卡（空选「下一步」禁用；可与扮演位同卡——D2
 *   自己跟自己对话 UI 不禁止；扮演位卡出「你的扮演位」记号）；
 * - ④ 开局表单：历法已随 0017 收编世界卡（表单无历法段）；「开局并开始」
 *   提交四纯剧情位 wire 载荷（锚、可选字段，空串归 null）；
 * - 「直接开始」= 降级路径：onCreate 收到 opening = null（后端 seed 默认锚行）。
 * onCreate / onCreateWorld 由测试注入，直接断言载荷（不触 api 层）。
 */
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  CharacterSummary,
  SessionOpeningInput,
  SessionRosterMember,
  WorldSummary,
} from '../../api/types';
import '../../i18n';
import { NewSessionDialog } from './NewSessionDialog';

const CHARACTERS: CharacterSummary[] = [
  {
    id: 1,
    name: '苏鸢',
    avatar: null,
    gender: null,
    age: null,
    titles: [],
    persona: '',
    renderStyle: 'type',
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
    updatedAt: 0,
    sessionCount: 0,
  },
  {
    id: 2,
    name: '林深',
    avatar: null,
    gender: null,
    age: null,
    titles: [],
    persona: '',
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
    updatedAt: 0,
    sessionCount: 0,
  },
];

const WORLDS: WorldSummary[] = [
  { id: 1, name: '空白舞台', worldbook: '', calendar: null, updatedAt: 0 },
  {
    id: 2,
    name: '雾灯航线',
    worldbook: '',
    calendar: {
      name: '旧都历',
      months: ['霜月', '白蜡月'],
      daysPerMonth: 30,
      dayNames: ['晨露日', '萤火日'],
      festivals: { 45: '灯节' },
    },
    updatedAt: 0,
  },
];

/** 内联建世界的缺省回包（对齐 Sidebar.createWorldInline 的新建卡形态）。 */
function newWorld(id: number, name: string): WorldSummary {
  return { id, name, worldbook: '', calendar: null, updatedAt: 0 };
}

function renderDialog(
  onCreate: (
    worldId: number,
    members: SessionRosterMember[],
    opening: SessionOpeningInput | null,
  ) => void,
  onCreateWorld: (name: string) => Promise<WorldSummary> = (name) =>
    Promise.resolve(newWorld(3, name)),
  worlds: WorldSummary[] | null = WORLDS,
) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <NewSessionDialog
        open
        characters={CHARACTERS}
        worlds={worlds}
        creating={false}
        onOpenChange={() => undefined}
        onCreateWorld={onCreateWorld}
        onCreate={onCreate}
      />
    </FluentProvider>,
  );
}

/** 走完前三步（world → user 扮演位 → LLM 阵容点选）进入开局表单步。 */
function advanceToForm(world: string, user: string, llm: string[]): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(world) }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  fireEvent.click(screen.getByRole('button', { name: user }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  for (const name of llm) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
  }
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
}

afterEach(cleanup);

it('第一步「世界」必选：不选不能下一步；空清单出指引文案', () => {
  renderDialog(vi.fn(), undefined, WORLDS);

  // 未选世界：「下一步」禁用（0017 会话必有世界）
  expect(screen.getByRole('button', { name: '下一步' }).hasAttribute('disabled')).toBe(true);

  // 选中世界卡（aria-pressed 表达选中态）→ 解禁
  const worldCard = screen.getByRole('button', { name: /空白舞台/ });
  expect(worldCard.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(worldCard);
  expect(worldCard.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: '下一步' }).hasAttribute('disabled')).toBe(false);

  // 空清单：出「先到世界页创建」指引（内联建卡是出路）
  cleanup();
  renderDialog(vi.fn(), undefined, []);
  expect(screen.getByText(/还没有世界/)).toBeTruthy();
});

it('内联建世界：填名点建 → onCreateWorld 落库 → 新建卡即选中（下一步解禁）', async () => {
  const onCreate = vi.fn();
  const onCreateWorld = vi.fn().mockResolvedValue(newWorld(3, '回声荒原'));
  renderDialog(onCreate, onCreateWorld);

  fireEvent.change(screen.getByLabelText('新建世界'), { target: { value: '回声荒原' } });
  fireEvent.click(screen.getByRole('button', { name: '新建世界' }));
  await waitFor(() => {
    expect(onCreateWorld).toHaveBeenCalledWith('回声荒原');
  });
  // 建成即选中：下一步解禁
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '下一步' }).hasAttribute('disabled')).toBe(false);
  });

  // 走完向导提交：worldId 为内联新建卡 id（父级清单不回流也不影响选中态）
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  fireEvent.click(screen.getByRole('button', { name: '苏鸢' }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  // 阵容步的可访问名带「你的扮演位」前缀，正则匹配
  fireEvent.click(screen.getByRole('button', { name: /苏鸢/ }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  fireEvent.click(screen.getByRole('button', { name: '直接开始' }));
  expect(onCreate).toHaveBeenCalledWith(
    3,
    [
      { characterId: 1, isUser: true },
      { characterId: 1, isUser: false },
    ],
    null,
  );
});

it('第二步「你的角色」必选：不选不能下一步；「返回重选」可回退且保留扮演位', () => {
  renderDialog(vi.fn());

  fireEvent.click(screen.getByRole('button', { name: /空白舞台/ }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));

  // 未选扮演位：「下一步」禁用（D2 必选门槛）
  expect(screen.getByRole('button', { name: '下一步' }).hasAttribute('disabled')).toBe(true);

  // 选扮演位（aria-pressed 表达选中态）→ 解禁
  const suCard = screen.getByRole('button', { name: '苏鸢' });
  expect(suCard.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(suCard);
  expect(suCard.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: '下一步' }).hasAttribute('disabled')).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: '下一步' }));

  // 阵容步：扮演位卡出「你的扮演位」记号（可访问名拼接）；「返回重选」回第一步且选择保留
  expect(screen.getByRole('button', { name: /你的扮演位/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '返回重选' }));
  expect(screen.getByRole('button', { name: '苏鸢' }).getAttribute('aria-pressed')).toBe('true');
});

it('第三步「LLM 阵容」多选：空选禁用下一步；可含扮演位同卡（D2 自演自）；阵容按点选序提交', () => {
  const onCreate = vi.fn();
  renderDialog(onCreate);

  fireEvent.click(screen.getByRole('button', { name: /空白舞台/ }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  fireEvent.click(screen.getByRole('button', { name: '苏鸢' }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));

  // 阵容步初始为空 → 「下一步」禁用
  const nextInRoster = screen.getByRole('button', { name: '下一步' });
  expect(nextInRoster.hasAttribute('disabled')).toBe(true);

  // 多选：林深 + 扮演位同卡苏鸢（D2 允许自演自，UI 不禁止）
  fireEvent.click(screen.getByRole('button', { name: '林深' }));
  fireEvent.click(screen.getByRole('button', { name: /你的扮演位/ }));
  expect(nextInRoster.hasAttribute('disabled')).toBe(false);
  fireEvent.click(nextInRoster);

  // 表单步：直接开始 = 降级路径（opening = null），阵容含双位，worldId 随提交
  fireEvent.click(screen.getByRole('button', { name: '直接开始' }));
  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(onCreate).toHaveBeenCalledWith(
    1,
    [
      { characterId: 1, isUser: true },
      { characterId: 2, isUser: false },
      { characterId: 1, isUser: false },
    ],
    null,
  );
});

it('同卡双位（D2）：扮演位与 LLM 位同卡 → members 两实例同卡异位', () => {
  const onCreate = vi.fn();
  renderDialog(onCreate);
  advanceToForm('空白舞台', '苏鸢', ['苏鸢']);
  fireEvent.click(screen.getByRole('button', { name: '直接开始' }));
  expect(onCreate).toHaveBeenCalledWith(
    1,
    [
      { characterId: 1, isUser: true },
      { characterId: 1, isUser: false },
    ],
    null,
  );
});

it('阵容可回退改选：「返回重选」回阵容步且勾选保留；重新进入表单不残留上次草稿', () => {
  renderDialog(vi.fn());
  advanceToForm('空白舞台', '苏鸢', ['林深']);

  // 表单改草稿 → 返回阵容步（勾选保留）→ 再进表单（草稿重置）
  fireEvent.change(screen.getByLabelText('开局第几天（≥1）'), { target: { value: '9' } });
  fireEvent.click(screen.getByRole('button', { name: '返回重选' }));
  expect(screen.getByRole('button', { name: '林深' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  expect((screen.getByLabelText('开局第几天（≥1）') as HTMLInputElement).value).toBe('1');
});

it('「开局并开始」：提交四纯剧情位开局载荷（无历法字段——0017 收编世界卡；空串归 null）', () => {
  const onCreate = vi.fn();
  renderDialog(onCreate);
  advanceToForm('雾灯航线', '苏鸢', ['林深']);

  // 起始锚「第 45 天」，时段保持缺省「夜」；地点填、时间留空
  const day = screen.getByLabelText('开局第几天（≥1）') as HTMLInputElement;
  expect(day.value).toBe('1');
  fireEvent.change(day, { target: { value: '45' } });
  fireEvent.change(screen.getByLabelText('首场景地点（可选）'), {
    target: { value: '旧都 · 灯市' },
  });

  fireEvent.click(screen.getByRole('button', { name: '开局并开始' }));
  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(onCreate).toHaveBeenCalledWith(
    2,
    [
      { characterId: 1, isUser: true },
      { characterId: 2, isUser: false },
    ],
    {
      ficDay: 45,
      ficPart: '夜',
      location: '旧都 · 灯市',
      timeNote: null,
    },
  );
});
