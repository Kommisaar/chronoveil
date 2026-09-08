import { describe, expect, it } from 'vitest';
import { StreamParser } from './parser';
import { isPara, type StreamUnit } from './queue';

function text(units: StreamUnit[]): string {
  return units.map((u) => ('t' in u ? u.t : '')).join('');
}

describe('markdown-lite 流式解析：闭合路（FR-004）', () => {
  it('*斜体*：闭合后按样式出队，后文回归普通', () => {
    const p = new StreamParser();
    const units = p.push('*动作*台词');
    expect(units).toEqual([
      { t: '动', a: true, b: false },
      { t: '作', a: true, b: false },
      { t: '台', a: false, b: false },
      { t: '词', a: false, b: false },
    ]);
  });

  it('**加粗**：闭合后 b=true，开闭标记不吐字', () => {
    const p = new StreamParser();
    const units = p.push('**加粗**正');
    expect(units).toEqual([
      { t: '加', a: false, b: true },
      { t: '粗', a: false, b: true },
      { t: '正', a: false, b: false },
    ]);
  });
});

describe('markdown-lite 流式解析：延迟判定（ADR-008）', () => {
  it('开标记后尾巴攒着不吐字，跨包闭合则补齐样式单元', () => {
    const p = new StreamParser();
    expect(p.push('*你好')).toEqual([]); // 尾巴攒着
    const units = p.push('*再见');
    expect(units).toEqual([
      { t: '你', a: true, b: false },
      { t: '好', a: true, b: false },
      { t: '再', a: false, b: false },
      { t: '见', a: false, b: false },
    ]);
  });

  it('加粗闭合跨包：单颗星不闭合归入内容，双星才闭合', () => {
    const p = new StreamParser();
    expect(p.push('**重点')).toEqual([]);
    const units = p.push('*词**落');
    expect(units).toEqual([
      { t: '重', a: false, b: true },
      { t: '点', a: false, b: true },
      { t: '*', a: false, b: true },
      { t: '词', a: false, b: true },
      { t: '落', a: false, b: false }, // 闭合后的字符回归普通
    ]);
    expect(p.flush()).toEqual([]); // 闭合后无残留尾巴
  });

  it('段落封存仍未闭合 → 按字面星号吐出', () => {
    const p = new StreamParser();
    p.push('*abc');
    const units = p.sealParagraph();
    expect(units.slice(0, -1)).toEqual([
      { t: '*', a: false, b: false },
      { t: 'a', a: false, b: false },
      { t: 'b', a: false, b: false },
      { t: 'c', a: false, b: false },
    ]);
    expect(units.at(-1)).toEqual({ para: true });
  });

  it('流结束仍未闭合 → flush 按字面星号吐出', () => {
    const p = new StreamParser();
    p.push('**xyz');
    expect(text(p.flush())).toBe('**xyz');
  });

  it('***x***：与 demo 正则一致——两颗字面星夹一颗加粗字', () => {
    const p = new StreamParser();
    const units = p.push('***x***');
    expect(units).toEqual([
      { t: '*', a: false, b: false },
      { t: 'x', a: false, b: true },
    ]);
    expect(text(p.flush())).toBe('*');
  });

  it('加粗内容中的孤立星按内容处理，遇 ** 才闭合', () => {
    const p = new StreamParser();
    const units = p.push('**a*b**');
    expect(units).toEqual([
      { t: 'a', a: false, b: true },
      { t: '*', a: false, b: true },
      { t: 'b', a: false, b: true },
    ]);
  });
});

describe('markdown-lite 流式解析：分段与场景线（FR-004）', () => {
  it('空行（\\n\\n）触发段落封存单元', () => {
    const p = new StreamParser();
    const units = p.push('ab\n\ncd');
    expect(units).toEqual([
      { t: 'a', a: false, b: false },
      { t: 'b', a: false, b: false },
      { para: true },
      { t: 'c', a: false, b: false },
      { t: 'd', a: false, b: false },
    ]);
  });

  it('边界跨包到达（\\n 与后续字符分两次 push）', () => {
    const p = new StreamParser();
    expect(text(p.push('ab\n'))).toBe('ab');
    const units = p.push('\ncd');
    expect(units[0]).toEqual({ para: true });
    expect(text(units.slice(1))).toBe('cd');
  });

  it('单个换行是块内普通字符', () => {
    const p = new StreamParser();
    expect(text(p.push('a\nb'))).toBe('a\nb');
    expect(p.push('').length).toBe(0);
  });

  it('--- 场景线：分隔线块出 {hr} 后随边界 {para}（与 demo 单元序一致）', () => {
    const p = new StreamParser();
    const units = p.push('前\n\n---\n\n后');
    expect(units).toEqual([
      { t: '前', a: false, b: false },
      { para: true },
      { hr: true },
      { para: true },
      { t: '后', a: false, b: false },
    ]);
  });

  it('=== 与 —— 同为场景线', () => {
    for (const line of ['===', '——']) {
      const p = new StreamParser();
      const units = p.push('a\n\n' + line + '\n\nb');
      expect(units.filter(isPara)).toHaveLength(2);
      expect(units.filter((u) => 'hr' in u)).toHaveLength(1);
    }
  });

  it('块首候选被破坏 → 按普通文字吐出，不出场景线', () => {
    const p = new StreamParser();
    const units = p.push('--x');
    expect(text(units)).toBe('--x');
    expect(units.filter((u) => 'hr' in u)).toHaveLength(0);
  });

  it('纯空白块不是场景线，按字面吐出', () => {
    const p = new StreamParser();
    const units = p.push('x\n\n   \n\ny');
    expect(units.filter((u) => 'hr' in u)).toHaveLength(0);
    expect(units.filter(isPara)).toHaveLength(2);
    expect(text(units)).toBe('x   y');
  });

  it('块首前导空白先攒后放，不影响正文', () => {
    const p = new StreamParser();
    expect(text(p.push('  hi'))).toBe('  hi');
  });

  it('流末场景线块只出 {hr} 不补 {para}', () => {
    const p = new StreamParser();
    p.push('a\n\n---');
    const units = p.flush();
    expect(units).toEqual([{ hr: true }]);
  });
});
