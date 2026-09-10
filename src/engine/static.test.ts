// 静态 markdown-lite 渲染测试：与流式同语义（parser.test.ts 覆盖语法本身），
// 这里只验证 DOM 产出结构、同风格 span 合并与字面星号路径。
import { describe, expect, it } from 'vitest';
import { renderStaticMarkdown } from './static';

function render(text: string): HTMLDivElement {
  const root = document.createElement('div');
  renderStaticMarkdown(root, text);
  return root;
}

describe('renderStaticMarkdown', () => {
  it('空文本：清空容器且不产出节点', () => {
    const root = render('');
    expect(root.childNodes).toHaveLength(0);
    // 复用容器重渲染：旧内容先清空
    root.appendChild(document.createElement('span'));
    renderStaticMarkdown(root, '');
    expect(root.childNodes).toHaveLength(0);
  });

  it('纯文本：单个 .para 内一个 .tok span', () => {
    const root = render('雨夜来电');
    expect(root.querySelectorAll('.para')).toHaveLength(1);
    const toks = root.querySelectorAll('span.tok');
    expect(toks).toHaveLength(1);
    expect(toks[0]?.textContent).toBe('雨夜来电');
    expect(toks[0]?.className).toBe('tok');
  });

  it('*斜体* / **加粗**：action / bold 样式类', () => {
    const root = render('*动作*与**重音**');
    const action = root.querySelectorAll('span.tok.action');
    const bold = root.querySelectorAll('span.tok.bold');
    expect(action).toHaveLength(1);
    expect(action[0]?.textContent).toBe('动作');
    expect(bold).toHaveLength(1);
    expect(bold[0]?.textContent).toBe('重音');
  });

  it('同风格连续字符合并为单 span，风格切换才分段', () => {
    const root = render('*一字*plain*二字*');
    expect(root.querySelectorAll('span.tok')).toHaveLength(3);
    const actions = root.querySelectorAll('span.tok.action');
    expect(actions[0]?.textContent).toBe('一字');
    expect(actions[1]?.textContent).toBe('二字');
  });

  it('空行分段：两个 .para，段间封存', () => {
    const root = render('第一段\n\n第二段');
    expect(root.querySelectorAll('.para')).toHaveLength(2);
  });

  it('场景线：--- 产出 hr.scene 而非文本', () => {
    const root = render('前情\n\n---\n\n后续');
    expect(root.querySelectorAll('hr.scene')).toHaveLength(1);
    expect(root.textContent).not.toContain('---');
  });

  it('未闭合标记：按字面星号吐出（与流式 flush 同路）', () => {
    const root = render('未闭合*斜体');
    expect(root.querySelectorAll('span.tok.action')).toHaveLength(0);
    expect(root.textContent).toContain('未闭合*斜体');
  });

  it('列表：uli/oli 段落类，无序补项目符、有序保留序号（2026-09-10）', () => {
    const root = render('- 甲\n- 乙\n\n1. 丙\n2. 丁');
    const ulis = root.querySelectorAll('.para.uli');
    const olis = root.querySelectorAll('.para.oli');
    expect(ulis).toHaveLength(2);
    expect(olis).toHaveLength(2);
    expect(ulis[0]?.textContent).toBe('• 甲\n'); // 行尾单换行是块内字符，随项保留（渲染不可见）
    expect(ulis[1]?.textContent).toBe('• 乙');
    expect(olis[0]?.textContent).toBe('1. 丙\n');
    expect(olis[1]?.textContent).toBe('2. 丁');
    // 列表项是普通 .para：不在项内的正文仍是无类段落
    expect(root.querySelectorAll('.para:not(.uli):not(.oli)')).toHaveLength(0);
  });
});
