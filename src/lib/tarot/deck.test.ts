// @vitest-environment node
// 牌库结构测试：78 张完整性 + tarotDeckOf 子集容量（纯逻辑，node 环境跳 jsdom）。
import { describe, expect, it } from 'vitest';
import { TAROT_DECK, tarotDeckOf } from './deck';

describe('塔罗牌库（78 张结构数据）', () => {
  it('全牌恰 78 张且 id 唯一', () => {
    expect(TAROT_DECK).toHaveLength(78);
    expect(new Set(TAROT_DECK.map((card) => card.id)).size).toBe(78);
  });

  it('大阿卡纳 22 张，编号 0–21 连续且无花色', () => {
    const majors = TAROT_DECK.filter((card) => card.arcana === 'major');
    expect(majors).toHaveLength(22);
    expect(majors.map((card) => card.number)).toEqual([...Array(22).keys()]);
    expect(majors.every((card) => card.suit === null)).toBe(true);
  });

  it('小阿卡纳 56 张：4 花色 × 1–14 全组合无缺漏', () => {
    const suits = ['wands', 'cups', 'swords', 'pentacles'] as const;
    for (const suit of suits) {
      const cards = TAROT_DECK.filter((card) => card.suit === suit);
      expect(cards).toHaveLength(14);
      expect(cards.map((card) => card.number)).toEqual([...Array(14).keys()].map((n) => n + 1));
      expect(cards.every((card) => card.arcana === 'minor')).toBe(true);
    }
  });

  it('tarotDeckOf：缺省全牌 78 / major 22 / minor 56，元素 arcana 一致', () => {
    expect(tarotDeckOf()).toHaveLength(78);
    const majors = tarotDeckOf('major');
    expect(majors).toHaveLength(22);
    expect(majors.every((card) => card.arcana === 'major')).toBe(true);
    const minors = tarotDeckOf('minor');
    expect(minors).toHaveLength(56);
    expect(minors.every((card) => card.arcana === 'minor')).toBe(true);
  });
});
