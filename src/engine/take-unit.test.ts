import { describe, expect, it } from 'vitest';
import { TextUnit, UnitQueue, textUnit } from './queue';
import { takeUnit } from './take-unit';

function filled(s: string, a = false, b = false): UnitQueue {
  const q = new UnitQueue();
  q.enqueue([...s].map((ch) => textUnit(ch, a, b)));
  return q;
}

function tok(u: ReturnType<typeof takeUnit>): TextUnit | undefined {
  return u && 't' in u ? u : undefined;
}

describe('takeUnit 发射粒度合并（FR-002）', () => {
  it('空队列返回 undefined', () => {
    expect(takeUnit(new UnitQueue(), 2)).toBeUndefined();
  });

  it('粒度 1：逐字出队', () => {
    const q = filled('abcd');
    expect(tok(takeUnit(q, 1))?.t).toBe('a');
    expect(tok(takeUnit(q, 1))?.t).toBe('b');
    expect(q.length).toBe(2);
  });

  it('粒度 2：相同 a/b 的相邻字符合并', () => {
    const q = filled('abcd');
    expect(takeUnit(q, 2)).toEqual({ t: 'ab', a: false, b: false });
    expect(takeUnit(q, 2)).toEqual({ t: 'cd', a: false, b: false });
    expect(q.length).toBe(0);
  });

  it('粒度 4：跨越不足一块的尾部', () => {
    const q = filled('abc');
    expect(tok(takeUnit(q, 4))?.t).toBe('abc');
  });

  it('a/b 标记变化处断块，样式随块携带', () => {
    const q = new UnitQueue();
    q.enqueue([...('aa' + 'BB')].map((ch, i) => textUnit(ch, i >= 2, false)));
    expect(takeUnit(q, 4)).toEqual({ t: 'aa', a: false, b: false });
    expect(takeUnit(q, 4)).toEqual({ t: 'BB', a: true, b: false });
  });

  it('斜体+加粗组合（demo *…* / **…** 单元）', () => {
    const q = new UnitQueue();
    q.enqueue([...'ab'].map((ch) => textUnit(ch, false, true)));
    expect(takeUnit(q, 2)).toEqual({ t: 'ab', a: false, b: true });
  });

  it('结构单元原子出队、不可拆分', () => {
    const q = new UnitQueue();
    q.enqueue({ para: true });
    q.enqueue(textUnit('x'));
    q.enqueue({ hr: true });
    expect(takeUnit(q, 4)).toEqual({ para: true });
    expect(tok(takeUnit(q, 4))?.t).toBe('x');
    expect(takeUnit(q, 4)).toEqual({ hr: true });
  });

  it('列表项单元原子出队（2026-09-10 扩展）', () => {
    const q = new UnitQueue();
    q.enqueue({ item: true, ordered: false });
    q.enqueue(textUnit('a'));
    expect(takeUnit(q, 4)).toEqual({ item: true, ordered: false });
    expect(tok(takeUnit(q, 4))?.t).toBe('a');
  });

  it('合并不会跨越结构单元', () => {
    const q = new UnitQueue();
    q.enqueue(textUnit('a'));
    q.enqueue({ para: true });
    q.enqueue(textUnit('b'));
    expect(tok(takeUnit(q, 4))?.t).toBe('a');
    expect(takeUnit(q, 4)).toEqual({ para: true });
    expect(tok(takeUnit(q, 4))?.t).toBe('b');
  });

  it('空白字符照常参与合并（demo splitChunks 白名单外直通）', () => {
    const q = filled('a b');
    expect(tok(takeUnit(q, 4))?.t).toBe('a b');
  });
});
