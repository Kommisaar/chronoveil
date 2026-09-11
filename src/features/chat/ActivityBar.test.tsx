/**
 * ActivityBar 单测（Task-07）：幕后活动条的四条行为规则——
 * 1. 折叠态文案随 phase：researchStart / toolCall / toolResult →「正在回忆…」，
 *    dossierReady →「翻到了。」（短暂完成态）；
 * 2. researchSkipped（快车道）零打扰：不渲染任何内容；
 * 3. 展开态（点击折叠行）：技术步骤列表——phase 本地化标签 + detail 原文，
 *    dossierReady 的 detail 即卷宗预览；
 * 4. 让位（yielded）：首个 token / reasoning 后折叠条收起为「已回忆」小标记，
 *    仍可点开回看（终态前）；空轨迹（终态清空 / mock 无事件流）整条不渲染。
 *
 * props 直驱（轨迹数据在 streamHub 层单测，此处只测呈现）；i18n 固定中文
 * （i18n/index 以 lng:'zh' 初始化），断言用 zh 文案。
 */
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import '../../i18n';
import { ActivityBar } from './ActivityBar';
import type { ActivityStep } from './streamHub';

/** 轨迹构造：ActivityStep 只含 phase + detail（呈现层无时间维度） */
function step(phase: ActivityStep['phase'], detail: string | null): ActivityStep {
  return { phase, detail };
}

function bar(activity: readonly ActivityStep[], yielded = false) {
  return (
    <FluentProvider theme={webLightTheme}>
      <ActivityBar activity={activity} yielded={yielded} />
    </FluentProvider>
  );
}

afterEach(() => {
  cleanup();
});

describe('折叠态：文案随 phase 变化（规则 1）', () => {
  it('researchStart / toolCall / toolResult 都显示「正在回忆…」', () => {
    const { rerender } = render(bar([step('researchStart', null)]));
    expect(screen.getByRole('button', { name: '正在回忆…' })).toBeDefined();

    rerender(bar([step('researchStart', null), step('toolCall', 'search_memory(q=雨夜)')]));
    expect(screen.getByRole('button', { name: '正在回忆…' })).toBeDefined();

    rerender(bar([step('researchStart', null), step('toolCall', 'a'), step('toolResult', 'b')]));
    expect(screen.getByRole('button', { name: '正在回忆…' })).toBeDefined();
  });

  it('dossierReady 换完成态文案「翻到了。」', () => {
    render(bar([step('researchStart', null), step('dossierReady', '卷宗前若干字')]));
    expect(screen.getByRole('button', { name: '翻到了。' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '正在回忆…' })).toBeNull();
  });
});

describe('快车道零打扰（规则 2）', () => {
  it('researchSkipped 为唯一步骤时整条不渲染', () => {
    const { container } = render(bar([step('researchSkipped', null)]));
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('');
  });
});

describe('展开态：技术步骤列表（规则 3）', () => {
  it('点击折叠行展开：phase 标签 + detail 原文，dossierReady 显示卷宗预览', () => {
    render(
      bar([
        step('researchStart', null),
        step('toolCall', 'search_memory(q=雨夜)'),
        step('toolResult', '命中 3 条'),
        step('dossierReady', '【卷宗】她提过一把伞…'),
      ]),
    );
    fireEvent.click(screen.getByRole('button', { name: '翻到了。' }));

    expect(screen.getByText('进入探索')).toBeDefined();
    expect(screen.getByText('工具调用')).toBeDefined();
    expect(screen.getByText('search_memory(q=雨夜)')).toBeDefined(); // detail 原文
    expect(screen.getByText('工具结果')).toBeDefined();
    expect(screen.getByText('命中 3 条')).toBeDefined();
    expect(screen.getByText('卷宗就绪')).toBeDefined();
    expect(screen.getByText('【卷宗】她提过一把伞…')).toBeDefined(); // 卷宗预览
    // 再次点击收起
    fireEvent.click(screen.getByRole('button', { name: '翻到了。' }));
    expect(screen.queryByText('search_memory(q=雨夜)')).toBeNull();
  });

  it('detail 为 null 的步骤只显示 phase 标签，不渲染空占位', () => {
    render(bar([step('researchStart', null)]));
    fireEvent.click(screen.getByRole('button', { name: '正在回忆…' }));
    expect(screen.getByText('进入探索')).toBeDefined();
    expect(screen.getByText('正在回忆…')).toBeDefined(); // 折叠行仍在
  });
});

describe('让位与清空（规则 4）', () => {
  it('yielded 后折叠条收起为「已回忆」小标记，点击仍可展开回看', () => {
    render(bar([step('researchStart', null), step('dossierReady', '卷宗')], true));
    expect(screen.queryByRole('button', { name: '正在回忆…' })).toBeNull();
    expect(screen.queryByRole('button', { name: '翻到了。' })).toBeNull();
    const mark = screen.getByRole('button', { name: '已回忆' });

    fireEvent.click(mark);
    expect(screen.getByText('卷宗就绪')).toBeDefined(); // 一次展开入口保留
    expect(screen.getByText('卷宗')).toBeDefined();
  });

  it('空轨迹整条不渲染（终态清空后 / mock 无事件流）', () => {
    const { container } = render(bar([], false));
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('');
  });
});
