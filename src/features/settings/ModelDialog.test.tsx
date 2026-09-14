// ModelDialog 单测：模型元数据对话框的用户可观察行为（2026-09-15 补测）——
// 编辑模式按 K 量纲回灌（显示 = 原始 token / 1000）且保存按 ×1000 还原、
// 取消只关闭不回传、数值门控（负数/小数/空串禁保存并标 aria-invalid）、
// 图片模态勾选进 inputTypes（文本恒选且禁用）、新增模式空 ID 禁保存并回缺省。
// 对话框受控开合由本壳直接传 open， spies 断言 onConfirm / onOpenChange。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelSpecDto } from '../../api/types';
import '../../i18n';
import { ModelDialog } from './ModelDialog';

afterEach(cleanup);

/** 编辑回灌夹具：数值取非整 K 也无损的千倍值（1500K / 200K）。 */
const editedSpec: ModelSpecDto = {
  id: 'orig-model',
  contextWindow: 1_500_000,
  maxOutputTokens: 200_000,
  inputTypes: ['text'],
  outputTypes: ['text'],
};

interface RenderOptions {
  open?: boolean;
  initial?: ModelSpecDto | null;
}

/** 挂载对话框壳：open 受控恒开（关闭由 onOpenChange spy 承接，不真正卸载）。 */
function renderDialog(options: RenderOptions = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <FluentProvider theme={webLightTheme}>
      <ModelDialog
        open={options.open ?? true}
        initial={options.initial ?? null}
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
      />
    </FluentProvider>,
  );
  return { onConfirm, onOpenChange };
}

const idInput = (): HTMLInputElement => screen.getByLabelText('模型 ID') as HTMLInputElement;
const contextInput = (): HTMLInputElement =>
  screen.getByLabelText('上下文窗口（K）') as HTMLInputElement;
const maxOutputInput = (): HTMLInputElement =>
  screen.getByLabelText('最大输出 Token（K）') as HTMLInputElement;
const saveButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;

describe('ModelDialog 模型元数据对话框', () => {
  it('编辑模式：initial 按 K 量纲回灌显示，保存按 ×1000 还原并关闭', () => {
    const { onConfirm, onOpenChange } = renderDialog({ initial: editedSpec });
    // 标题为编辑形态（非「添加模型」）
    expect(screen.getByText('编辑模型')).toBeTruthy();
    // 回灌：显示 = 原始 token / 1000；ID 原样
    expect(contextInput().value).toBe('1500');
    expect(maxOutputInput().value).toBe('200');
    expect(idInput().value).toBe('orig-model');
    expect(saveButton().disabled).toBe(false);

    fireEvent.change(idInput(), { target: { value: 'edited-model' } });
    fireEvent.click(saveButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // 落 spec：显示值 ×1000 还原原始量纲
    expect(onConfirm).toHaveBeenCalledWith({
      id: 'edited-model',
      contextWindow: 1_500_000,
      maxOutputTokens: 200_000,
      inputTypes: ['text'],
      outputTypes: ['text'],
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('取消：填一半点取消只回传关闭，不触发 onConfirm', () => {
    const { onConfirm, onOpenChange } = renderDialog({ initial: null });
    fireEvent.change(idInput(), { target: { value: '半截输入' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('数值门控：context/maxOutput 填负数、小数、空串时保存禁用并标 aria-invalid', () => {
    renderDialog({ initial: null });
    // 先把 ID 填合法，隔离数值单因素
    fireEvent.change(idInput(), { target: { value: 'm1' } });
    expect(saveButton().disabled).toBe(false);

    for (const bad of ['-3', '1.5', '']) {
      fireEvent.change(contextInput(), { target: { value: bad } });
      expect(saveButton().disabled).toBe(true);
      expect(contextInput().getAttribute('aria-invalid')).toBe('true');
    }
    fireEvent.change(contextInput(), { target: { value: '1000' } });

    // 最大输出同门控
    fireEvent.change(maxOutputInput(), { target: { value: '-3' } });
    expect(saveButton().disabled).toBe(true);
    expect(maxOutputInput().getAttribute('aria-invalid')).toBe('true');

    // 双字段恢复合法 → 保存重新可用
    fireEvent.change(maxOutputInput(), { target: { value: '128' } });
    expect(saveButton().disabled).toBe(false);
  });

  it('图片模态：勾选进确认载荷 inputTypes；文本模态恒选且禁用', () => {
    const { onConfirm } = renderDialog({ initial: null });
    // 文本模态在输入/输出两行各一枚：恒选且禁用（锁死）
    const textBoxes = screen.getAllByRole('checkbox', { name: '文本' }) as HTMLInputElement[];
    expect(textBoxes.length).toBe(2);
    for (const box of textBoxes) {
      expect(box.checked).toBe(true);
      expect(box.disabled).toBe(true);
    }
    const imageBox = screen.getByRole('checkbox', { name: '图片' }) as HTMLInputElement;
    expect(imageBox.checked).toBe(false);

    fireEvent.change(idInput(), { target: { value: 'vision' } });
    fireEvent.click(imageBox);
    expect(imageBox.checked).toBe(true);
    fireEvent.click(saveButton());
    // 新增缺省（1M/128K）×1000 还原 + 图片入 inputTypes
    expect(onConfirm).toHaveBeenCalledWith({
      id: 'vision',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      inputTypes: ['text', 'image'],
      outputTypes: ['text'],
    });
  });

  it('新增模式：空 ID 禁保存并标 aria-invalid，缺省 K 值预填', () => {
    renderDialog({ initial: null });
    expect(screen.getByText('添加模型')).toBeTruthy();
    expect(idInput().value).toBe('');
    // 缺省回灌：1000K / 128K（与 DEFAULT_* 常量一致）
    expect(contextInput().value).toBe('1000');
    expect(maxOutputInput().value).toBe('128');
    expect(saveButton().disabled).toBe(true);
    expect(idInput().getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(idInput(), { target: { value: 'm1' } });
    expect(saveButton().disabled).toBe(false);
  });
});
