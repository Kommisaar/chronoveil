// CalendarDraftDialog 单测（AI 起草历法，FR-014 二期）：api 层整体 vi.mock
// （ADR-010 允许 UI 层测试替换数据入口）——输入计数与空描述禁用、起草中
// 加载态、结果预览与「应用到表单 / 丢弃」双动作、错误文案与「重试」、
// 起草途中关闭 = 放弃（迟到结果按序号守卫丢弃，不触碰状态）。i18n 固定中文。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarConfigDto } from '../../../api/types';
import '../../../i18n';
import { CalendarDraftDialog } from './CalendarDraftDialog';

const mocks = vi.hoisted(() => ({
  draftCalendar: vi.fn(),
}));

vi.mock('../../../api/commands', () => mocks);

const FANTASY: CalendarConfigDto = {
  name: '旧都历',
  months: ['霜月', '白蜡月', '融雪月'],
  daysPerMonth: 30,
  dayNames: ['晨露日', '萤火日'],
  festivals: { 45: '灯节', 360: '守夜' },
};

/** 受控壳：模拟父级的 open 开合（应用/关闭回调翻转 open）。 */
function Harness(props: { onApply?: (config: CalendarConfigDto) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <FluentProvider theme={webLightTheme}>
      <CalendarDraftDialog
        open={open}
        onApply={(config) => {
          props.onApply?.(config);
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      />
    </FluentProvider>
  );
}

function typeDescription(text: string): void {
  fireEvent.change(screen.getByLabelText('世界观描述'), { target: { value: text } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CalendarDraftDialog 输入态', () => {
  it('空描述禁用「起草」；输入后计数实时更新并解锁', () => {
    render(<Harness />);
    const run = screen.getByRole('button', { name: '起草' }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    typeDescription('旧都的历法');
    expect(screen.getByText('5 / 4000')).toBeTruthy();
    expect((screen.getByRole('button', { name: '起草' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('成功路径：起草中出加载态，结果出格式化预览，「应用到表单」回传草稿并关闭', async () => {
    const onApply = vi.fn();
    mocks.draftCalendar.mockResolvedValue(FANTASY);
    render(<Harness onApply={onApply} />);
    typeDescription('旧都的历法');
    fireEvent.click(screen.getByRole('button', { name: '起草' }));
    // 调用中：命令被携 trim 后的描述调用，加载态可关闭
    expect(mocks.draftCalendar).toHaveBeenCalledWith('旧都的历法');
    expect(screen.getByText('起草中…')).toBeTruthy();
    // 结果预览（CalendarDetail 复用查看态渲染）
    await screen.findByText('月名（3）');
    expect(screen.getByText('霜月、白蜡月、融雪月')).toBeTruthy();
    expect(screen.getByText(/第45天 灯节、第360天 守夜/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '应用到表单' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(FANTASY);
    // 应用即关闭（放弃语义下不残留结果态）
    await waitFor(() => expect(screen.queryByText('月名（3）')).toBeNull());
    expect(mocks.draftCalendar).toHaveBeenCalledTimes(1);
  });

  it('「丢弃」：结果只关不应用（onApply 不被调用）', async () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    mocks.draftCalendar.mockResolvedValue(FANTASY);
    render(
      <FluentProvider theme={webLightTheme}>
        <CalendarDraftDialog open onApply={onApply} onClose={onClose} />
      </FluentProvider>,
    );
    typeDescription('描述');
    fireEvent.click(screen.getByRole('button', { name: '起草' }));
    await screen.findByText('月名（3）');
    fireEvent.click(screen.getByRole('button', { name: '丢弃' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('错误路径：i18n 错误文案 +「重试」沿用同一描述重新发起', async () => {
    mocks.draftCalendar
      .mockRejectedValueOnce(new Error('conflict: 描述为空'))
      .mockResolvedValueOnce(FANTASY);
    render(<Harness />);
    typeDescription('旧都的历法');
    fireEvent.click(screen.getByRole('button', { name: '起草' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      '起草失败：conflict: 描述为空',
    );
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('月名（3）');
    expect(mocks.draftCalendar).toHaveBeenCalledTimes(2);
    expect(mocks.draftCalendar).toHaveBeenNthCalledWith(2, '旧都的历法');
  });

  it('起草途中关闭 = 放弃：迟到结果被序号守卫丢弃，不再触碰状态', async () => {
    let resolve!: (config: CalendarConfigDto) => void;
    mocks.draftCalendar.mockImplementation(
      () =>
        new Promise<CalendarConfigDto>((res) => {
          resolve = res;
        }),
    );
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(
      <FluentProvider theme={webLightTheme}>
        <CalendarDraftDialog open onApply={onApply} onClose={onClose} />
      </FluentProvider>,
    );
    typeDescription('描述');
    fireEvent.click(screen.getByRole('button', { name: '起草' }));
    expect(screen.getByText('起草中…')).toBeTruthy();
    // 关闭（取消）：对话框可关，草稿命令无取消通道
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // 迟到的结果：静默丢弃（不出结果预览、不回调应用）
    await act(async () => {
      resolve(FANTASY);
    });
    expect(screen.queryByText('月名（3）')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('重新打开重置为初始输入态（描述清空，不残留上次草稿）', async () => {
    mocks.draftCalendar.mockResolvedValue(FANTASY);
    const { rerender } = render(
      <FluentProvider theme={webLightTheme}>
        <CalendarDraftDialog open onApply={vi.fn()} onClose={vi.fn()} />
      </FluentProvider>,
    );
    typeDescription('一段描述');
    rerender(
      <FluentProvider theme={webLightTheme}>
        <CalendarDraftDialog open={false} onApply={vi.fn()} onClose={vi.fn()} />
      </FluentProvider>,
    );
    rerender(
      <FluentProvider theme={webLightTheme}>
        <CalendarDraftDialog open onApply={vi.fn()} onClose={vi.fn()} />
      </FluentProvider>,
    );
    expect((screen.getByLabelText('世界观描述') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByText('0 / 4000')).toBeTruthy();
  });
});
