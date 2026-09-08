import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

// 界面语言默认「跟随系统」（FR-009），jsdom 的 navigator.language 是
// en-US；固定为 zh-CN 使断言与生产默认（中文）一致
Object.defineProperty(window.navigator, 'language', {
  value: 'zh-CN',
  configurable: true,
});

describe('App', () => {
  afterEach(cleanup);

  it('渲染应用外壳与品牌名', () => {
    render(<App />);
    expect(screen.getByLabelText('ChronoVeil')).toBeTruthy();
  });

  it('默认视图为聊天空态', () => {
    render(<App />);
    expect(screen.getByText('选择左侧会话，或从角色页开始新对话')).toBeTruthy();
  });
});
