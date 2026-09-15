// MarkdownPreviewBox 冒烟（2026-09-15 随组件自角色编辑器 pieces.test 迁来）：
// 引擎直插 DOM、场景线挖空底按 bg1 表面注入、文本变化整容器重渲染、空态提示
// 开关。shared 组 isolate:false，RTL 不自动 cleanup，需自行 afterEach。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { MarkdownPreviewBox } from './MarkdownPreviewBox';

const HINT = '这个角色是谁？说话习惯、背景、底线……';

function renderUi(node: ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{node}</FluentProvider>);
}

afterEach(cleanup);

describe('MarkdownPreviewBox（markdown 静态预览）', () => {
  it('markdown 直插 DOM：加粗产出 tok.bold，正文上屏', () => {
    renderUi(<MarkdownPreviewBox text="**加粗**冷句" hint={HINT} />);
    const box = document.querySelector('[data-markdown-preview]');
    expect(box).toBeTruthy();
    expect(box!.querySelector('.tok.bold')?.textContent).toBe('加粗');
    expect(box!.textContent).toContain('冷句');
  });

  it('场景线挖空底按所在表面注入：容器行内 --cv-scene-line-bg = 主题 bg1（编辑器 DialogSurface / 设置卡均为 bg1 表面）', () => {
    renderUi(<MarkdownPreviewBox text={'前情\n\n---\n\n后续'} hint={HINT} />);
    const box = document.querySelector<HTMLElement>('[data-markdown-preview]')!;
    // 注入的是 Fluent 主题变量引用（tokens.* 即 var(...)，FluentProvider 按主题
    // 解析，同聊天侧 engineThemeVars）：指向 bg1 而非 bg2 才是与所在表面同色
    expect(box.style.getPropertyValue('--cv-scene-line-bg')).toBe(
      'var(--colorNeutralBackground1)',
    );
    // 两表面在主题里确为异色（引用指错表面即出异色矩形，此断言保证上述契约有效）
    expect(webLightTheme.colorNeutralBackground1).not.toBe(
      webLightTheme.colorNeutralBackground2,
    );
    // 含 --- 的文本渲染不回归：静态渲染与聊天同语法语义，场景线仍产出 hr.scene
    expect(box.querySelectorAll('hr.scene')).toHaveLength(1);
    expect(box.textContent).not.toContain('---');
  });

  it('文本变化即整容器重渲染', () => {
    const { rerender } = renderUi(<MarkdownPreviewBox text="第一版" hint={HINT} />);
    expect(document.querySelector('[data-markdown-preview]')!.textContent).toContain('第一版');
    rerender(
      <FluentProvider theme={webLightTheme}>
        <MarkdownPreviewBox text="第二版" hint={HINT} />
      </FluentProvider>,
    );
    const box = document.querySelector('[data-markdown-preview]')!;
    expect(box.textContent).toContain('第二版');
    expect(box.textContent).not.toContain('第一版');
  });

  it('空文本默认出占位提示；showHint=false 不出（编辑态 textarea 已有 placeholder）', () => {
    const { rerender } = renderUi(<MarkdownPreviewBox text="   " hint={HINT} />);
    expect(screen.getByText(HINT)).toBeTruthy();
    rerender(
      <FluentProvider theme={webLightTheme}>
        <MarkdownPreviewBox text="" hint={HINT} showHint={false} />
      </FluentProvider>,
    );
    expect(screen.queryByText(HINT)).toBeNull();
  });
});
