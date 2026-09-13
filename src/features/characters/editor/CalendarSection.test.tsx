// CalendarSection 冒烟（历法区块，FR-014 二期）：折叠摘要（未配置/已配置/
// 校验失败三态）、查看态明细、查看↔编辑往返、字段编辑回调、无效输入的
// 行内校验提示、校验未过禁用「完成编辑」（C7：不放回查看态）、四预设一键
// 填入（components/calendarPresets 事实源）、「AI 起草」入口回调。
// i18n 固定中文，断言 zh 文案。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALENDAR_PRESETS } from '../../../components/calendarPresets';
import '../../../i18n';
import { buildCalendar, EMPTY_CALENDAR_FIELDS, type CalendarFields } from './calendarForm';
import { CalendarSection } from './CalendarSection';

function renderUi(node: ReactNode) {
  return render(<FluentProvider theme={webLightTheme}>{node}</FluentProvider>);
}

/** 受控壳：模拟 useEditorForm 持有的状态（open/editing/fields/build）。 */
function Harness(props: {
  initialFields: CalendarFields;
  initialOpen?: boolean;
  onDraftClick?: () => void;
}) {
  const [open, setOpen] = useState(props.initialOpen ?? true);
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState(props.initialFields);
  const build = useMemo(() => buildCalendar(fields), [fields]);
  return (
    <CalendarSection
      open={open}
      onToggle={() => setOpen((o) => !o)}
      editing={editing}
      onEditingChange={setEditing}
      fields={fields}
      build={build}
      onFieldsChange={setFields}
      onDraftClick={props.onDraftClick ?? (() => {})}
    />
  );
}

const FANTASY_FIELDS: CalendarFields = {
  name: '旧都历',
  daysPerMonth: '30',
  months: '霜月\n白蜡月',
  dayNames: '晨露日\n萤火日',
  festivals: '45=灯节\n60=守夜',
};

afterEach(cleanup);

describe('CalendarSection 折叠头摘要', () => {
  it('收起态：本体不渲染，摘要显示「未配置（默认数字历）」', () => {
    renderUi(<Harness initialFields={EMPTY_CALENDAR_FIELDS} initialOpen={false} />);
    const header = screen.getByRole('button', { name: /^历法/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText(/未配置（默认数字历）/)).toBeTruthy();
    // 收起时无编辑入口与字段
    expect(screen.queryByRole('button', { name: '编辑历法' })).toBeNull();
    expect(screen.queryByLabelText('每月天数')).toBeNull();
  });

  it('已配置：摘要 = 历法名 · N月×M日 · 节日数', () => {
    renderUi(<Harness initialFields={FANTASY_FIELDS} initialOpen={false} />);
    expect(screen.getByText(/旧都历 · 2 月 × 30 日 · 2 个节日/)).toBeTruthy();
  });

  it('点击头部开合；展开后查看态出明细（月名日名全列与节日表）', () => {
    renderUi(<Harness initialFields={FANTASY_FIELDS} initialOpen={false} />);
    fireEvent.click(screen.getByRole('button', { name: /^历法/ }));
    expect(screen.getByRole('button', { name: /^历法/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('月名（2）')).toBeTruthy();
    expect(screen.getByText('霜月、白蜡月')).toBeTruthy();
    expect(screen.getByText('晨露日、萤火日')).toBeTruthy();
    expect(screen.getByText('节日（2）')).toBeTruthy();
    expect(screen.getByText(/第45天 灯节、第60天 守夜/)).toBeTruthy();
    expect(screen.getByText('历法名：旧都历')).toBeTruthy();
  });

  it('展开 + 未配置：查看态只有提示与动作行，无字段', () => {
    renderUi(<Harness initialFields={EMPTY_CALENDAR_FIELDS} />);
    expect(screen.getAllByText(/未配置（默认数字历）/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByLabelText('月名（每行一个）')).toBeNull();
    expect(screen.getByRole('button', { name: 'AI 起草' })).toBeTruthy();
  });
});

describe('CalendarSection 查看↔编辑往返', () => {
  it('编辑历法 → 字段上屏带现值；完成编辑 → 回查看态', () => {
    renderUi(<Harness initialFields={FANTASY_FIELDS} />);
    fireEvent.click(screen.getByRole('button', { name: '编辑历法' }));
    expect((screen.getByLabelText('历法名（可空）') as HTMLInputElement).value).toBe('旧都历');
    expect((screen.getByLabelText('每月天数') as HTMLInputElement).value).toBe('30');
    expect((screen.getByLabelText('月名（每行一个）') as HTMLTextAreaElement).value).toBe(
      '霜月\n白蜡月',
    );
    expect((screen.getByLabelText('日名（每行一个）') as HTMLTextAreaElement).value).toBe(
      '晨露日\n萤火日',
    );
    expect((screen.getByLabelText('节日（每行「第N天=名称」）') as HTMLTextAreaElement).value).toBe(
      '45=灯节\n60=守夜',
    );
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }));
    expect(screen.queryByLabelText('每月天数')).toBeNull();
    // 查看态仍是现值明细
    expect(screen.getByText('霜月、白蜡月')).toBeTruthy();
  });

  it('无效输入显示行内校验文案（对齐 fiction_time::validate 的三处拦截）', () => {
    renderUi(<Harness initialFields={EMPTY_CALENDAR_FIELDS} />);
    fireEvent.click(screen.getByRole('button', { name: '编辑历法' }));
    // 全空无错误
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByLabelText('每月天数'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('月名（每行一个）'), { target: { value: '一月' } });
    expect(screen.getByRole('alert').textContent).toBe('每月天数需为 ≥1 的整数');
    fireEvent.change(screen.getByLabelText('每月天数'), { target: { value: '30' } });
    expect(screen.queryByRole('alert')).toBeNull();
    // 节日行非法
    fireEvent.change(screen.getByLabelText('节日（每行「第N天=名称」）'), {
      target: { value: '灯节' },
    });
    expect(screen.getByRole('alert').textContent).toBe(
      '节日行需为「第N天=名称」，N 为 ≥1 的整数，配置了月名时不得超过年总天数（月数 × 每月天数）',
    );
  });

  it('校验未过不放回查看态：完成钮禁用带提示，修正后恢复（C7：防「未配置」假象）', async () => {
    renderUi(<Harness initialFields={EMPTY_CALENDAR_FIELDS} />);
    fireEvent.click(screen.getByRole('button', { name: '编辑历法' }));
    // 造出 invalid（每月天数 0），完成钮禁用且点击无效
    fireEvent.change(screen.getByLabelText('每月天数'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('月名（每行一个）'), { target: { value: '一月' } });
    const done = screen.getByRole('button', { name: '完成编辑' }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    // 提示走 Fluent Tooltip（C3 收编后不再有原生 title 属性）：聚焦触发器
    // 后 content 以 role="tooltip" 挂载（惯例同 Sidebar.test；真实浏览器中
    // 的视觉浮现由 Fluent 保证）
    expect(done.getAttribute('title')).toBeNull();
    fireEvent.focus(done);
    expect(await screen.findByRole('tooltip')).toBeTruthy();
    expect(screen.getByRole('tooltip').textContent).toBe('历法未通过校验，修正或清空后才能完成编辑');
    fireEvent.blur(done);
    fireEvent.click(done);
    // 仍处编辑态：字段还在上屏，未泄漏成「未配置」查看态
    expect(screen.getByLabelText('每月天数')).toBeTruthy();
    // 清空全部字段 → 回未配置（empty），完成钮恢复可点
    fireEvent.change(screen.getByLabelText('每月天数'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('月名（每行一个）'), { target: { value: '' } });
    expect((screen.getByRole('button', { name: '完成编辑' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: '完成编辑' }));
    expect(screen.getAllByText(/未配置（默认数字历）/).length).toBeGreaterThanOrEqual(1);
  });

  it('四预设一键填入：下拉选择后字段整体替换（同一事实源 calendarPresets）', () => {
    renderUi(<Harness initialFields={EMPTY_CALENDAR_FIELDS} />);
    fireEvent.click(screen.getByRole('button', { name: '编辑历法' }));
    fireEvent.click(screen.getByRole('combobox', { name: '预设历法' }));
    fireEvent.click(screen.getByRole('option', { name: '现代公历' }));
    expect((screen.getByLabelText('历法名（可空）') as HTMLInputElement).value).toBe('现代公历');
    expect((screen.getByLabelText('月名（每行一个）') as HTMLTextAreaElement).value).toContain(
      '十一月',
    );
    expect((screen.getByLabelText('节日（每行「第N天=名称」）') as HTMLTextAreaElement).value).toBe(
      '1=元旦\n271=国庆节',
    );
    // 与共享常量同源（防两份事实源漂移）
    expect(CALENDAR_PRESETS.modern.festivals).toEqual({ 1: '元旦', 271: '国庆节' });
  });

  it('「AI 起草」入口触发回调（对话框由父级打开）', () => {
    const onDraftClick = vi.fn();
    renderUi(<Harness initialFields={EMPTY_CALENDAR_FIELDS} onDraftClick={onDraftClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI 起草' }));
    expect(onDraftClick).toHaveBeenCalledTimes(1);
  });
});
