// StateBlock 三态守卫：loading 有 spinner（progressbar）且无 alert 语义、
// error 容器 role="alert" + 重试回调（可选，省略即无钮）、empty 原样透传
// EmptyState（用模块 mock 的 spy 直接断言 props 透传，行为桩渲染 message）。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmptyStateAction } from './EmptyState';
import { StateBlock } from './StateBlock';

const emptySpy = vi.hoisted(() => vi.fn());

// 只替身 EmptyState 的渲染以捕获透传 props；类型导出（EmptyStateAction）编译期
// 使用，运行时 mock 工厂只需提供同名组件
vi.mock('./EmptyState', () => ({
  EmptyState: (props: { message: string; action?: EmptyStateAction }) => {
    emptySpy(props);
    return <div data-testid="empty-stub">{props.message}</div>;
  },
}));

function renderBlock(props: Parameters<typeof StateBlock>[0]) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <StateBlock {...props} />
    </FluentProvider>,
  );
}

afterEach(cleanup);

describe('StateBlock 三态', () => {
  it('loading：Spinner（progressbar）+ 文案，容器无 alert 语义', () => {
    const { getByRole, queryByRole } = renderBlock({ state: 'loading', label: '加载中' });
    expect(getByRole('progressbar')).toBeTruthy();
    expect(screen.getByText('加载中')).toBeTruthy();
    expect(queryByRole('alert')).toBeNull();
  });

  it('error：容器 role="alert"（读屏即时播报）+ 文案 + 重试钮回调', () => {
    const onRetry = vi.fn();
    const { getByRole } = renderBlock({
      state: 'error',
      label: '加载失败',
      onRetry: { label: '重试', onClick: onRetry },
    });
    expect(getByRole('alert').textContent).toContain('加载失败');
    fireEvent.click(getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('error 省略 onRetry：只展示错误文案，无重试钮', () => {
    const { getByRole, queryByRole } = renderBlock({ state: 'error', label: '加载失败' });
    expect(getByRole('alert').textContent).toContain('加载失败');
    expect(queryByRole('button')).toBeNull();
  });

  it('empty：原样透传 EmptyState（message = label，action 引用不变）', () => {
    const onClick = vi.fn();
    const action: EmptyStateAction = { label: '去新建', onClick };
    renderBlock({ state: 'empty', label: '还没有场景', action });
    expect(emptySpy).toHaveBeenCalledWith({ message: '还没有场景', action });
    expect(screen.getByTestId('empty-stub').textContent).toBe('还没有场景');
  });
});
