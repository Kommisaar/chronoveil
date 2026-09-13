import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { useUiStore } from '../stores/ui';

// 界面语言默认「跟随系统」（FR-009），jsdom 的 navigator.language 是
// en-US；固定为 zh-CN 使断言与生产默认（中文）一致
Object.defineProperty(window.navigator, 'language', {
  value: 'zh-CN',
  configurable: true,
});

describe('App', () => {
  afterEach(() => {
    cleanup();
    // 侧栏收起态是模块级 store 的残留面：复位避免泄漏到其他用例
    useUiStore.setState({ sidebarCollapsed: false });
  });

  it('渲染应用外壳与品牌名', () => {
    render(<App />);
    expect(screen.getByLabelText('ChronoVeil')).toBeTruthy();
  });

  it('默认视图为聊天空态', () => {
    render(<App />);
    // 文案不再指认具体入口位置：空态自带「新建会话」直达钮（U5），侧栏「+」
    // 在侧栏收起时不可见，指引不能依赖它
    expect(screen.getByText('选择左侧会话，或新建一个对话')).toBeTruthy();
  });

  it('C3：侧栏收起时展开钮提示迁移 Fluent Tooltip——原生 title 移除，聚焦后 content 挂载', async () => {
    useUiStore.setState({ sidebarCollapsed: true });
    render(<App />);
    const expandBtn = screen.getByRole('button', { name: '展开会话栏' });
    expect(expandBtn.getAttribute('title')).toBeNull();
    // label 关系：Fluent 把文案写到 trigger 的 aria-label（与原 aria-label
    // 同值）；content 仅在显示时挂载（label 模式无需常驻 DOM）——聚焦触发
    // 挂载，真实浏览器中的视觉浮现由 Fluent Tooltip 保证（jsdom 断言不到
    // CSS 显示）
    expect(expandBtn.getAttribute('aria-label')).toBe('展开会话栏');
    fireEvent.focus(expandBtn);
    expect(await screen.findByRole('tooltip')).toBeTruthy();
    expect(screen.getByRole('tooltip').textContent).toBe('展开会话栏');
  });
});
