/**
 * 新建会话两段式对话框测试（FR-014 开局向导）：
 * - ① 选角色（列表来自 props，点击锁定进表单态，「返回重选」可回退）；
 * - ② 开局表单：「跟随角色卡」项读 CharacterSummary.calendarConfig 显示历法名；
 *   「开局并开始」提交完整 wire 载荷（preset → CalendarConfigDto、锚、可选字段）；
 * - 「直接开始」= 降级路径：onCreate 收到 opening = null（后端 seed 默认锚行）。
 * onCreate 由测试注入，直接断言载荷（不触 api 层）。
 */
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CharacterSummary, SessionOpeningInput } from '../../api/types';
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
    calendarConfig:
      '{"name":"旧都历","months":["霜月","白蜡月"],"days_per_month":30,"day_names":["晨露日","萤火日"]}',
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
    calendarConfig: null,
    updatedAt: 0,
    sessionCount: 0,
  },
];

function renderDialog(
  onCreate: (characterId: number, opening: SessionOpeningInput | null) => void,
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

afterEach(cleanup);

it('两段式：选角色进表单态，「跟随角色卡」显示角色卡历法名，「返回重选」可回退', () => {
  const onCreate = vi.fn();
  renderDialog(onCreate);

  // ① 选角色态
  fireEvent.click(screen.getByRole('button', { name: /苏鸢/ }));
  // 「跟随角色卡」项读 calendarConfig 的 name 字段显示历法名
  expect(screen.getByText(/跟随角色卡「旧都历」/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: '返回重选' }));
  expect(screen.getByRole('button', { name: /林深/ })).toBeTruthy();
});

it('「开局并开始」：提交完整开局载荷（预设日历 DTO + 起始锚 + 可选字段，空串归 null）', () => {
  const onCreate = vi.fn();
  renderDialog(onCreate);

  fireEvent.click(screen.getByRole('button', { name: /苏鸢/ }));
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
  expect(onCreate).toHaveBeenCalledWith(1, {
    calendar: expect.objectContaining({
      name: '旧都历',
      daysPerMonth: 30,
      festivals: { 45: '灯节', 360: '守夜' },
    }),
    ficDay: 45,
    ficPart: '夜',
    location: '旧都 · 灯市',
    timeNote: null,
  });
});

it('「直接开始」= 降级路径：不填表单直接提交，onCreate 收到 opening = null', () => {
  const onCreate = vi.fn();
  renderDialog(onCreate);

  fireEvent.click(screen.getByRole('button', { name: /林深/ }));
  fireEvent.click(screen.getByRole('button', { name: '直接开始' }));
  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(onCreate).toHaveBeenCalledWith(2, null);
});
