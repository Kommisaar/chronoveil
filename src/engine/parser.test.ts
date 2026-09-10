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

describe('markdown-lite 流式解析：扁平列表（2026-09-10 扩展）', () => {
  function items(units: StreamUnit[]): boolean[] {
    return units.filter((u) => 'item' in u).map((u) => (u as { ordered: boolean }).ordered);
  }

  it('- 无序列表项：item 单元 + • 项目符，标记本身吞掉', () => {
    const p = new StreamParser();
    const units = p.push('- 甲');
    expect(items(units)).toEqual([false]);
    expect(text(units)).toBe('• 甲');
  });

  it('连续行各成一项，单换行处开启新列表项', () => {
    const p = new StreamParser();
    const units = p.push('- 甲\n- 乙\n- 丙');
    expect(items(units)).toEqual([false, false, false]);
    expect(text(units)).toBe('• 甲\n• 乙\n• 丙');
  });

  it('有序列表：序号按原文保留、不重排', () => {
    const p = new StreamParser();
    const units = p.push('1. 甲\n2. 乙');
    expect(items(units)).toEqual([true, true]);
    expect(text(units)).toBe('1. 甲\n2. 乙');
  });

  it('多位序号成立，非换行行首序号不成立', () => {
    const p = new StreamParser();
    expect(items(p.push('12. 起'))).toEqual([true]);
    expect(items(p.push('前缀- 甲'))).toEqual([]);
    expect(text(p.push('前缀- 甲'))).toBe('前缀- 甲');
  });

  it('-x / 1.5 候选失败按字面直出', () => {
    const p = new StreamParser();
    expect(items(p.push('-x'))).toEqual([]);
    expect(text(p.push('-x'))).toBe('-x');
    expect(items(p.push('1.5 倍'))).toEqual([]);
    expect(text(p.push('1.5 倍'))).toBe('1.5 倍');
  });

  it('--- 仍是场景线：列表候选失败移交场景线判定', () => {
    const p = new StreamParser();
    const units = [...p.push('---'), ...p.flush()];
    expect(units.filter((u) => 'hr' in u)).toHaveLength(1);
    expect(items(units)).toEqual([]);
  });

  it('空行结束列表，后续普通段落不再成项', () => {
    const p = new StreamParser();
    const units = p.push('- 甲\n\n正文');
    expect(items(units)).toEqual([false]);
    expect(units.filter(isPara)).toHaveLength(1);
    expect(text(units)).toBe('• 甲正文');
  });

  it('列表项内 *斜体* 照常生效', () => {
    const p = new StreamParser();
    const units = p.push('- *动*作');
    const italic = units.filter((u) => 't' in u && u.a).map((u) => ('t' in u ? u.t : ''));
    expect(italic.join('')).toBe('动');
  });

  it('流末未定型的 - 候选按字面吐出（flush）', () => {
    const p = new StreamParser();
    p.push('-');
    expect(text(p.flush())).toBe('-');
  });

  // —— 发现 5（demo 对齐）：`- ` 遇空格进待决 hold，下一个非空白字符裁决 ——

  it('行首 `- - -` 不是列表项：整体按字面吐出（demo 语义）', () => {
    const p = new StreamParser();
    const units = [...p.push('- - -'), ...p.flush()];
    expect(items(units)).toEqual([]);
    expect(units.filter((u) => 'hr' in u)).toHaveLength(0); // 空格打散，不成场景线
    expect(text(units)).toBe('- - -');
  });

  it('`- - -` 逐字符喂入（半包任意切分）与整块喂入同构', () => {
    for (const chunk of ['- - -', '- ', '- -', '-', '- - -']) {
      const p = new StreamParser();
      let units: StreamUnit[] = [];
      for (const ch of chunk) units = [...units, ...p.push(ch)];
      units = [...units, ...p.flush()];
      expect(text(units), `按 "${chunk}" 切分`).toBe(chunk);
      expect(items(units)).toEqual([]);
    }
  });

  it('待决后普通正文仍定型列表项：`- 甲` 语义不变', () => {
    const p = new StreamParser();
    const units = p.push('- 甲');
    expect(items(units)).toEqual([false]);
    expect(text(units)).toBe('• 甲');
  });

  it('标记后余量空白按正文保留：`-  甲` 出 `•  甲`（与即刻定型版一致）', () => {
    const p = new StreamParser();
    const units = p.push('-  甲');
    expect(items(units)).toEqual([false]);
    expect(text(units)).toBe('•  甲');
  });

  it('待决后空格换行无正文：整行按字面，不成列表项', () => {
    const p = new StreamParser();
    const units = [...p.push('- \n\n正文'), ...p.flush()];
    expect(items(units)).toEqual([]);
    expect(text(units)).toBe('- 正文');
    expect(units.filter(isPara)).toHaveLength(1);
  });

  it('流末停在 `- `：待决 hold 按字面吐出（含空格）', () => {
    const p = new StreamParser();
    p.push('- ');
    expect(text(p.flush())).toBe('- ');
    const q = new StreamParser();
    q.push('- ');
    expect(items(q.flush())).toEqual([]);
  });

  it('`- =` 同为潜在场景线形态：候选失败按字面吐出', () => {
    const p = new StreamParser();
    const units = [...p.push('- ='), ...p.flush()];
    expect(items(units)).toEqual([]);
    expect(text(units)).toBe('- =');
  });

  it('待决失败后再遇正文：`- - 甲` 整体按字面（divider 被正文破坏）', () => {
    const p = new StreamParser();
    const units = [...p.push('- - 甲'), ...p.flush()];
    expect(items(units)).toEqual([]);
    expect(text(units)).toBe('- - 甲');
  });
});
