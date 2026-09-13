// @vitest-environment node —— 纯逻辑测试无 DOM 依赖，跳过 jsdom 环境创建（测试提速）
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

  it('粒度 1：逐字出队（CJK 无词约束）', () => {
    const q = filled('甲乙丙丁');
    expect(tok(takeUnit(q, 1))?.t).toBe('甲');
    expect(tok(takeUnit(q, 1))?.t).toBe('乙');
    expect(q.length).toBe(2);
  });

  it('粒度 2：相同 a/b 的相邻字符合并', () => {
    const q = filled('你好世界');
    expect(takeUnit(q, 2)).toEqual({ t: '你好', a: false, b: false });
    expect(takeUnit(q, 2)).toEqual({ t: '世界', a: false, b: false });
    expect(q.length).toBe(0);
  });

  it('粒度 4：跨越不足一块的尾部', () => {
    const q = filled('你好世界');
    expect(tok(takeUnit(q, 4))?.t).toBe('你好世界');
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

describe('takeUnit 拉丁词完整性（发现 7，demo splitChunks L384 对齐）', () => {
  it('粒度窗口落在词中间时整词并入当前单元（单元长于粒度 n）', () => {
    const q = filled('abcd');
    expect(takeUnit(q, 2)).toEqual({ t: 'abcd', a: false, b: false });
    expect(q.length).toBe(0);
  });

  it('词与词之间仍按粒度合并：空白参与计数', () => {
    const q = filled('foo bar baz');
    expect(tok(takeUnit(q, 2))?.t).toBe('foo');
    expect(tok(takeUnit(q, 2))?.t).toBe(' bar');
    expect(tok(takeUnit(q, 2))?.t).toBe(' baz');
    expect(q.length).toBe(0);
  });

  it('词尾标点不黏连：边界落在词与标点之间照常断块', () => {
    const q = filled('ab, cd');
    expect(tok(takeUnit(q, 2))?.t).toBe('ab');
    expect(tok(takeUnit(q, 2))?.t).toBe(', ');
    expect(tok(takeUnit(q, 2))?.t).toBe('cd');
  });

  it('数字与字母同为词字符：v2 不拆断', () => {
    const q = filled('v2 v3');
    expect(tok(takeUnit(q, 2))?.t).toBe('v2');
    expect(tok(takeUnit(q, 2))?.t).toBe(' v3');
  });

  it('样式变化处仍断块：斜体词不吞入前块', () => {
    const q = new UnitQueue();
    q.enqueue([...'ab'].map((ch) => textUnit(ch, false, false)));
    q.enqueue([...'cd'].map((ch) => textUnit(ch, true, false)));
    expect(tok(takeUnit(q, 4))?.t).toBe('ab');
    expect(takeUnit(q, 4)).toEqual({ t: 'cd', a: true, b: false });
  });

  it('词首对齐：拆完前块后下一块从词首起，不再中途断开', () => {
    const q = filled('你好 hello');
    expect(tok(takeUnit(q, 2))?.t).toBe('你好');
    expect(tok(takeUnit(q, 2))?.t).toBe(' hello');
    expect(q.length).toBe(0);
  });
});
