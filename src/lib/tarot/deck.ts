/**
 * 塔罗牌库（2026-09-16 核心库定稿）：78 张 = 22 大阿卡纳（编号 0–21）+
 * 56 小阿卡纳（4 花色 × 1–14，11–14 为宫廷牌）。库内只承载结构字段
 * （id / arcana / suit / number），不含牌名与牌义等本地化文案——展示文案
 * 属 UI 层，后续接界面时按 id 作 key 走 i18next，避免核心库绑死语言。
 */

export type TarotArcana = 'major' | 'minor';

/** 小阿卡纳四花色：权杖 / 圣杯 / 宝剑 / 星币。 */
export type TarotSuit = 'wands' | 'cups' | 'swords' | 'pentacles';

export interface TarotCard {
  /** 稳定标识：`major-0`…`major-21`、`wands-1`…`wands-14`（i18n 与 UI 锚点）。 */
  id: string;
  arcana: TarotArcana;
  /** 大阿卡纳无花色，恒 null。 */
  suit: TarotSuit | null;
  /** 大阿卡纳 = 愚者到世界的序号 0–21；小阿卡纳 = 1(Ace)–14(King)。 */
  number: number;
}

const MAJOR_COUNT = 22;
const MINOR_SUITS: readonly TarotSuit[] = ['wands', 'cups', 'swords', 'pentacles'];
const MINOR_RANK_COUNT = 14;

const majorArcana: readonly TarotCard[] = Array.from(
  { length: MAJOR_COUNT },
  (_, number): TarotCard => ({ id: `major-${number}`, arcana: 'major', suit: null, number }),
);

const minorArcana: readonly TarotCard[] = MINOR_SUITS.flatMap((suit) =>
  Array.from({ length: MINOR_RANK_COUNT }, (_, i): TarotCard => {
    const number = i + 1;
    return { id: `${suit}-${number}`, arcana: 'minor', suit, number };
  }),
);

export const TAROT_DECK: readonly TarotCard[] = [...majorArcana, ...minorArcana];

/** 按阿卡纳取牌库子集：缺省全牌 78，'major' 只取大牌 22，'minor' 只取小牌 56。 */
export function tarotDeckOf(arcana?: TarotArcana | undefined): readonly TarotCard[] {
  if (arcana === undefined) return TAROT_DECK;
  return TAROT_DECK.filter((card) => card.arcana === arcana);
}
