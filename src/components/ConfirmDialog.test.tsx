// ConfirmDialog（C1 确认对话框族统一模板）单测：覆盖收编时立下的族内契约——
// Esc 可取消（收编前 CharactersView 两处不可取消）、取消/确认分发、破坏性
// 强调（取消键主键化 + 确认键红色弱化，收编前破坏性键一律 primary）、
// aria 抑制与双钮禁用。
// Fluent 的 Esc 处理挂在 DialogSurface 的 keydown 上（useDialogSurface），
// 触发方式：向 surface 内元素派发 Escape 键盘事件让其冒泡到 surface。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

function renderDialog(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn();
  const view = render(
    <FluentProvider theme={webLightTheme}>
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="确认标题"
        content="确认正文"
        confirmLabel="确认"
        cancelLabel="取消"
        onConfirm={onConfirm}
        {...overrides}
      />
    </FluentProvider>,
  );
  return { onOpenChange, onConfirm, unmount: view.unmount };
}

afterEach(cleanup);

describe('ConfirmDialog（C1 确认族统一模板）', () => {
  it('Esc 触发 onOpenChange(false)（受控开合唯一出口，Esc 可取消）', () => {
    const { onOpenChange } = renderDialog();
    fireEvent.keyDown(screen.getByText('确认标题'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByText('确认正文')).toBeTruthy(); // 受控组件不自行卸载
  });

  it('取消键走 onOpenChange(false)，确认键走 onConfirm，两出口互不串线', () => {
    const { onOpenChange, onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('destructive：取消键与确认键样式分支翻转（取消主键化、确认红色弱化）', () => {
    const { unmount } = renderDialog();
    const plainCancel = screen.getByRole('button', { name: '取消' }).className;
    const plainConfirm = screen.getByRole('button', { name: '确认' }).className;
    unmount();

    renderDialog({ destructive: true });
    const dangerCancel = screen.getByRole('button', { name: '取消' }).className;
    const dangerConfirm = screen.getByRole('button', { name: '确认' }).className;
    // destructive 翻转两键的强调（appearance 分支 + 红色样式类），与普通确认可区分
    expect(dangerCancel).not.toEqual(plainCancel);
    expect(dangerConfirm).not.toEqual(plainConfirm);
    expect(dangerConfirm).toMatch(/___/); // 携带本地红色弱化样式（makeStyles 生成类）
  });

  it('DialogSurface 无 aria-describedby（{undefined} 统一抑制 Fluent 警告）', () => {
    renderDialog();
    const surface = screen.getByText('确认标题').closest('[class*="fui-DialogSurface"]');
    expect(surface).toBeTruthy();
    expect(surface!.getAttribute('aria-describedby')).toBeNull();
  });

  it('busy 禁用双钮；confirmDisabled 仅禁确认键（取消仍可撤离）', () => {
    const { onOpenChange, onConfirm } = renderDialog({ busy: true });
    const cancel = screen.getByRole('button', { name: '取消' }) as HTMLButtonElement;
    const confirm = screen.getByRole('button', { name: '确认' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    expect(confirm.disabled).toBe(true);
    fireEvent.click(cancel);
    fireEvent.click(confirm);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirmDisabled 仅禁确认键，取消仍可撤离', () => {
    const { onOpenChange, onConfirm } = renderDialog({ confirmDisabled: true });
    const cancel = screen.getByRole('button', { name: '取消' }) as HTMLButtonElement;
    const confirm = screen.getByRole('button', { name: '确认' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    expect(confirm.disabled).toBe(true);
    fireEvent.click(cancel);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
