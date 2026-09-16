// @vitest-environment node
// 牌阵测试：内置阵数据形状 + 按阵抽取的逐位配对与无放回、arcana 透传。
import { describe, expect, it } from 'vitest';
import { drawTarotSpread } from './draw';
import { TAROT_SPREAD_SINGLE, TAROT_SPREAD_THREE } from './spreads';

describe('内置牌阵', () => {
  it('单张阵：1 位 card', () => {
    expect(TAROT_SPREAD_SINGLE.id).toBe('single');
    expect(TAROT_SPREAD_SINGLE.positions.map((p) => p.key)).toEqual(['card']);
  });

  it('三张阵：past / present / future', () => {
    expect(TAROT_SPREAD_THREE.id).toBe('three');
    expect(TAROT_SPREAD_THREE.positions.map((p) => p.key)).toEqual([
      'past',
      'present',
      'future',
    ]);
  });
});

describe('drawTarotSpread', () => {
  it('三张阵：3 张、positionKey 逐位对应、阵内无放回', () => {
    const drawn = drawTarotSpread(TAROT_SPREAD_THREE);
    expect(drawn).toHaveLength(3);
    expect(drawn.map((d) => d.positionKey)).toEqual(['past', 'present', 'future']);
    expect(new Set(drawn.map((d) => d.card.id)).size).toBe(3);
  });

  it('单张阵：1 张，positionKey = card', () => {
    const drawn = drawTarotSpread(TAROT_SPREAD_SINGLE);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.positionKey).toBe('card');
  });

  it('arcana 限定透传：major 阵抽出的牌全为大牌', () => {
    const drawn = drawTarotSpread(TAROT_SPREAD_THREE, { arcana: 'major' });
    expect(drawn.every((d) => d.card.arcana === 'major')).toBe(true);
  });
});
