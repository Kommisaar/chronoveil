import { describe, expect, it } from 'vitest';
import { UnitQueue, isHr, isPara, isText, textUnit, type StreamUnit } from './queue';

function chars(s: string, a = false, b = false): StreamUnit[] {
  return [...s].map((ch) => textUnit(ch, a, b));
}

function t(u: StreamUnit | undefined): string | undefined {
  return u && 't' in u ? u.t : undefined;
}

describe('UnitQueue（CMP-001 / FR-002）', () => {
  it('单个与批量入队，FIFO 出队', () => {
    const q = new UnitQueue();
    q.enqueue(textUnit('a'));
    q.enqueue(chars('bc'));
    expect(q.length).toBe(3);
    expect(t(q.dequeue())).toBe('a');
    expect(t(q.dequeue())).toBe('b');
    expect(t(q.dequeue())).toBe('c');
    expect(q.dequeue()).toBeUndefined();
  });

  it('peek 只看不取', () => {
    const q = new UnitQueue();
    q.enqueue(textUnit('x'));
    expect(t(q.peek())).toBe('x');
    expect(q.length).toBe(1);
  });

  it('clear 清空', () => {
    const q = new UnitQueue();
    q.enqueue(chars('abc'));
    q.clear();
    expect(q.length).toBe(0);
    expect(q.dequeue()).toBeUndefined();
  });

  it('结构单元原样进出', () => {
    const q = new UnitQueue();
    q.enqueue({ para: true });
    q.enqueue({ hr: true });
    const p = q.dequeue();
    const h = q.dequeue();
    expect(p && isPara(p)).toBe(true);
    expect(h && isHr(h)).toBe(true);
  });

  it('类型守卫区分文本与结构单元', () => {
    expect(isText(textUnit('x'))).toBe(true);
    expect(isText({ para: true })).toBe(false);
    expect(isHr({ hr: true })).toBe(true);
  });
});
