// @vitest-environment node
// 抽牌测试：无放回、arcana 限定、参数校验、正逆位判定与均匀性 sanity。
import { describe, expect, it } from 'vitest';
import { drawTarotCards } from './draw';

describe('drawTarotCards：无放回抽取', () => {
  it('抽 10 张 id 互异；抽满 78 张为全牌且不重复', () => {
    const ten = drawTarotCards(10);
    expect(new Set(ten.map((d) => d.card.id)).size).toBe(10);
    const full = drawTarotCards(78);
    expect(full).toHaveLength(78);
    expect(new Set(full.map((d) => d.card.id)).size).toBe(78);
  });

  it('arcana major：恰能抽满 22 张且全为大牌', () => {
    const majors = drawTarotCards(22, { arcana: 'major' });
    expect(majors).toHaveLength(22);
    expect(majors.every((d) => d.card.arcana === 'major')).toBe(true);
    expect(() => drawTarotCards(23, { arcana: 'major' })).toThrow(RangeError);
  });

  it('arcana minor：恰能抽满 56 张且全为小牌', () => {
    const minors = drawTarotCards(56, { arcana: 'minor' });
    expect(minors).toHaveLength(56);
    expect(minors.every((d) => d.card.arcana === 'minor')).toBe(true);
    expect(() => drawTarotCards(57, { arcana: 'minor' })).toThrow(RangeError);
  });

  it('非法 count（0 / 超全牌上限 / 非整数）抛 RangeError', () => {
    expect(() => drawTarotCards(0)).toThrow(RangeError);
    expect(() => drawTarotCards(79)).toThrow(RangeError);
    expect(() => drawTarotCards(1.5)).toThrow(RangeError);
  });

  it('reversalRate 越界抛 RangeError', () => {
    expect(() => drawTarotCards(1, { reversalRate: -0.5 })).toThrow(RangeError);
    expect(() => drawTarotCards(1, { reversalRate: 1.5 })).toThrow(RangeError);
  });
});

describe('正逆位判定（注入固定随机源）', () => {
  it('reversalRate 0 → 全正位；1 → 全逆位（恒定随机源边界）', () => {
    const upright = drawTarotCards(5, { reversalRate: 0, random: () => 0.999 });
    expect(upright.every((d) => !d.reversed)).toBe(true);
    const reversed = drawTarotCards(5, { reversalRate: 1, random: () => 0.999 });
    expect(reversed.every((d) => d.reversed)).toBe(true);
  });

  it('默认 0.5 + 交替序列 → 恰一半逆位（确定断言，无统计容差）', () => {
    const alternate = () => {
      let flip = false;
      return () => {
        flip = !flip;
        return flip ? 0.99 : 0.01; // 0.99 ≥ 0.5 正位，0.01 < 0.5 逆位
      };
    };
    const drawn = drawTarotCards(10, { random: alternate() });
    expect(drawn.filter((d) => d.reversed)).toHaveLength(5);
  });
});

describe('均匀性 sanity（真实 crypto 随机源，宽容差防 flaky）', () => {
  it('7800 次单抽：78 张全部出现且频次落 [期望/3, 期望×3]', () => {
    const trials = 78 * 100;
    const counts = new Map<string, number>();
    for (let i = 0; i < trials; i += 1) {
      const [drawn] = drawTarotCards(1);
      counts.set(drawn!.card.id, (counts.get(drawn!.card.id) ?? 0) + 1);
    }
    const expected = trials / 78; // 期望 100 次/张
    expect(counts.size).toBe(78);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(expected / 3);
      expect(count).toBeLessThan(expected * 3);
    }
  });
});
