/**
 * 新建会话三段式对话框测试（FR-014 开局向导 + 多角色第 1 步两步选人）：
 * - ① 「你的角色」：单选 1 张 = 用户扮演位（D2 必选——不选则「下一步」禁用）；
 * - ② 「LLM 阵容」：多选 ≥1 张卡（空选「下一步」禁用；可与扮演位同卡——D2
 *   自己跟自己对话 UI 不禁止；扮演位卡出「你的扮演位」记号）；
 * - ③ 开局表单：「默认数字历」为缺省项（wire 传 null，会话落内置默认历）；
 *   「开局并开始」提交完整 wire 载荷（preset → CalendarConfigDto、锚、可选字段）；
 * - 「直接开始」= 降级路径：onCreate 收到 opening = null（后端 seed 默认锚行）。
 * onCreate 由测试注入，直接断言载荷（不触 api 层）。
 */
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  CharacterSummary,
  SessionOpeningInput,
  SessionRosterMember,
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
    persona: '',
    renderStyle: 'type',
    modelConfig: null,
    accentColor: null,
    updatedAt: 0,
    sessionCount: 0,
  },
  {
    id: 2,
    name: '林深',
    avatar: null,
    gender: null,
    age: null,
    persona: '',
    renderStyle: 'ink',
    modelConfig: null,
    accentColor: null,
    updatedAt: 0,
    sessionCount: 0,
  },
];

function renderDialog(
  onCreate: (members: SessionRosterMember[], opening: SessionOpeningInput | null) => void,
) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <NewSessionDialog
        open
        characters={CHARACTERS}
        creating={false}
        onOpenChange={() => undefined}
        onCreate={onCreate}
      />
    </FluentProvider>,
  );
}

/** 走完两步选人（user 扮演位 → LLM 阵容点选）进入开局表单步。 */
function advanceToForm(user: string, llm: string[]): void {
  fireEvent.click(screen.getByRole('button', { name: user }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  for (const name of llm) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
  }
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
}

afterEach(cleanup);

it('第一步「你的角色」必选：不选不能下一步；「返回重选」可回退且保留扮演位', () => {
  renderDialog(vi.fn());

  // 未选扮演位：「下一步」禁用（D2 必选门槛）
  expect(screen.getByRole('button', { name: '下一步' }).hasAttribute('disabled')).toBe(true);

  // ① 选扮演位（aria-pressed 表达选中态）→ 解禁
  const suCard = screen.getByRole('button', { name: '苏鸢' });
  expect(suCard.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(suCard);
  expect(suCard.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: '下一步' }).hasAttribute('disabled')).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: '下一步' }));

  // ② 阵容步：扮演位卡出「你的扮演位」记号（可访问名拼接）；「返回重选」回第一步且选择保留
  expect(screen.getByRole('button', { name: /你的扮演位/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '返回重选' }));
  expect(screen.getByRole('button', { name: '苏鸢' }).getAttribute('aria-pressed')).toBe('true');
});

it('第二步「LLM 阵容」多选：空选禁用下一步；可含扮演位同卡（D2 自演自）；阵容按点选序提交', () => {
  const onCreate = vi.fn();
  renderDialog(onCreate);

  // 第一步选扮演位进阵容步
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

  // ③ 表单步：直接开始 = 降级路径（opening = null），阵容含双位
  fireEvent.click(screen.getByRole('button', { name: '直接开始' }));
  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(onCreate).toHaveBeenCalledWith(
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
  advanceToForm('苏鸢', ['苏鸢']);
  fireEvent.click(screen.getByRole('button', { name: '直接开始' }));
  expect(onCreate).toHaveBeenCalledWith(
    [
      { characterId: 1, isUser: true },
      { characterId: 1, isUser: false },
    ],
    null,
  );
});

it('阵容可回退改选：「返回重选」回阵容步且勾选保留；重新进入表单不残留上次草稿', () => {
  const onCreate = vi.fn();
  renderDialog(onCreate);
  advanceToForm('苏鸢', ['林深']);

  // 表单改草稿 → 返回阵容步（勾选保留）→ 再进表单（草稿重置）
  fireEvent.change(screen.getByLabelText('开局第几天（≥1）'), { target: { value: '9' } });
  fireEvent.click(screen.getByRole('button', { name: '返回重选' }));
  expect(screen.getByRole('button', { name: '林深' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  expect((screen.getByLabelText('开局第几天（≥1）') as HTMLInputElement).value).toBe('1');
});

it('「开局并开始」：提交完整开局载荷（预设日历 DTO + 起始锚 + 可选字段，空串归 null）', () => {
  const onCreate = vi.fn();
  renderDialog(onCreate);
  advanceToForm('苏鸢', ['林深']);

  // 历法选「旧都历」预设（ radio ），样例行随选中切换
  fireEvent.click(screen.getByRole('radio', { name: '旧都历' }));
  expect(screen.getByText(/灯节（第45日）/)).toBeTruthy();

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
    [
      { characterId: 1, isUser: true },
      { characterId: 2, isUser: false },
    ],
    {
      calendar: expect.objectContaining({
        name: '旧都历',
        daysPerMonth: 30,
        festivals: { 45: '灯节', 360: '守夜' },
      }),
      ficDay: 45,
      ficPart: '夜',
      location: '旧都 · 灯市',
      timeNote: null,
    },
  );
});

it('「默认数字历」为缺省历法项（wire 传 null）；样例行随预设切换', () => {
  const onCreate = vi.fn();
  renderDialog(onCreate);
  advanceToForm('苏鸢', ['林深']);

  // 缺省选中「默认数字历」，样例行显示数字历说明
  const defaultRadio = screen.getByRole('radio', { name: '默认数字历' }) as HTMLInputElement;
  expect(defaultRadio.checked).toBe(true);
  expect(screen.getByText(/不设月名日名/)).toBeTruthy();

  // 切到预设再切回：样例行随选中切换
  fireEvent.click(screen.getByRole('radio', { name: '旧都历' }));
  expect(screen.getByText(/灯节（第45日）/)).toBeTruthy();
  fireEvent.click(defaultRadio);
  expect(screen.getByText(/不设月名日名/)).toBeTruthy();

  // 「开局并开始」提交 calendar = null（不指定 → 会话落内置默认历）
  fireEvent.click(screen.getByRole('button', { name: '开局并开始' }));
  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(onCreate).toHaveBeenCalledWith(
    [
      { characterId: 1, isUser: true },
      { characterId: 2, isUser: false },
    ],
    {
      calendar: null,
      ficDay: 1,
      ficPart: '夜',
      location: null,
      timeNote: null,
    },
  );
});
