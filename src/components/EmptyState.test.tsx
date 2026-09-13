// EmptyState 单测：icon 位扩展（Task-05）的行为边界——默认无图标时布局与
// 现状完全一致（纯文案、无多余节点），有 icon 时渲染且位于文案上方；
// action 钮的带图标 / 无图标（icon 槽位放宽为可省后的新形态）两分支都可达。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyState } from './EmptyState';

function renderEmpty(props: Parameters<typeof EmptyState>[0]) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <EmptyState {...props} />
    </FluentProvider>,
  );
}

afterEach(cleanup);

describe('EmptyState icon 位（Task-05）', () => {
  it('默认无图标：纯文案布局与现状一致（root 下只有文案节点，零 svg）', () => {
    renderEmpty({ message: '还没有角色' });
    const text = screen.getByText('还没有角色');
    // root = 文案的父容器；断言其直接子节点只有文案（无 icon、无 action 钮）
    const root = text.parentElement as HTMLElement;
    expect(root.childElementCount).toBe(1);
    expect(root.querySelector('svg')).toBeNull();
  });

  it('有 icon：渲染且位于文案上方（DOM 序：icon → 文案）', () => {
    const { getByTestId } = renderEmpty({
      message: '还没有角色',
      icon: <svg data-testid="empty-icon" />,
    });
    const icon = getByTestId('empty-icon');
    const text = screen.getByText('还没有角色');
    expect(icon.nextSibling).toBe(text);
    expect(text.compareDocumentPosition(icon) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('action 带 icon（现状回归）：按钮渲染、点击回调触发', () => {
    const onClick = vi.fn();
    renderEmpty({
      message: '还没有会话',
      action: { label: '新建会话', icon: <svg data-testid="action-icon" />, onClick },
    });
    expect(getActionIcon()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('action 无 icon（icon 槽位放宽为可省）：按钮仍渲染、点击回调触发', () => {
    const onClick = vi.fn();
    renderEmpty({ message: '还没有会话', action: { label: '重试', onClick } });
    expect(getActionIcon()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

/** action 钮图标断言用：root 下的 svg（文案无图标时 root 唯一 svg 来自 action）。 */
function getActionIcon(): Element | null {
  const text = screen.getByText('还没有会话');
  return (text.parentElement as HTMLElement).querySelector('svg');
}
