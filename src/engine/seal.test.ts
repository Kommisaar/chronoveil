import { describe, expect, it } from 'vitest';
import { ParagraphStream } from './seal';

describe('段落封存（FR-004）', () => {
  it('尾段容器惰性创建并挂在根下', () => {
    const root = document.createElement('div');
    const ps = new ParagraphStream(root);
    const tail = ps.tail();
    expect(tail.className).toBe('para');
    expect(root.contains(tail)).toBe(true);
    expect(ps.tail()).toBe(tail); // 未封存前复用同一容器
  });

  it('封存后尾部追加改投新容器，旧段固化不受影响', () => {
    const root = document.createElement('div');
    const ps = new ParagraphStream(root);
    const first = ps.tail();
    first.appendChild(document.createElement('span'));
    ps.seal();

    expect(ps.sealedParagraphs).toBe(1);
    const second = ps.tail();
    expect(second).not.toBe(first);
    second.appendChild(document.createElement('span'));

    // 已封存段落不再受尾部追加影响
    expect(first.childNodes).toHaveLength(1);
    expect(second.childNodes).toHaveLength(1);
  });

  it('无活动段时 seal 是空操作', () => {
    const root = document.createElement('div');
    const ps = new ParagraphStream(root);
    ps.seal();
    expect(ps.sealedParagraphs).toBe(0);
  });

  it('场景线：根级 hr.scene，同时封存当前段', () => {
    const root = document.createElement('div');
    const ps = new ParagraphStream(root);
    ps.tail();
    const hr = ps.sceneLine();
    expect(hr.tagName).toBe('HR');
    expect(hr.className).toBe('scene');
    expect(root.lastElementChild).toBe(hr);
    expect(ps.sealedParagraphs).toBe(1);
    expect(ps.tail()).not.toBe(hr);
  });

  it('reset 清空封存计数与尾段指针', () => {
    const root = document.createElement('div');
    const ps = new ParagraphStream(root);
    ps.tail();
    ps.seal();
    ps.reset();
    expect(ps.sealedParagraphs).toBe(0);
  });
});
