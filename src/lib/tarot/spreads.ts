/**
 * 牌阵（2026-09-16 塔罗核心库）：阵即纯数据——位置数与语义 key 的组合，
 * 不绑定抽取逻辑。key 是稳定标识（位名/位义文案由展示层按 key 经 i18n
 * 提供），扩展新阵 = 追加一条数据，零逻辑改动。
 */

export interface TarotSpreadPosition {
  /** 稳定语义标识（如 'past'），位名文案由展示层经 i18n 提供。 */
  key: string;
}

export interface TarotSpread {
  id: string;
  positions: readonly TarotSpreadPosition[];
}

/** 单张阵：一问一牌。 */
export const TAROT_SPREAD_SINGLE: TarotSpread = {
  id: 'single',
  positions: [{ key: 'card' }],
};

/** 三张阵（时间流）：过去 / 现在 / 未来。 */
export const TAROT_SPREAD_THREE: TarotSpread = {
  id: 'three',
  positions: [{ key: 'past' }, { key: 'present' }, { key: 'future' }],
};
