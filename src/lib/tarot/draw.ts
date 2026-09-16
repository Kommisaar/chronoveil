/**
 * 抽牌（2026-09-16 塔罗核心库）：无放回抽取——同一次抽牌内不重复（标准塔罗
 * 实践：一副牌抽一个阵），每次调用独立重新洗牌。正逆位按 reversalRate 独立
 * 判定（默认 0.5，传 0 关闭逆位）；arcana 限定只抽大牌/小牌子集。
 */
import { tarotDeckOf, type TarotArcana, type TarotCard } from './deck';
import type { TarotSpread } from './spreads';
import { defaultRandomSource, shuffle, type RandomSource } from './shuffle';

export interface TarotDrawnCard {
  card: TarotCard;
  /** 正逆位：true = 逆位（牌义反向或削弱，语义由展示层定义）。 */
  reversed: boolean;
}

export interface TarotDrawOptions {
  /** 限定阿卡纳：'major' 只抽大牌（22 张）/ 'minor' 只抽小牌（56 张）/ 缺省全牌（78 张）。 */
  arcana?: TarotArcana | undefined;
  /** 逆位概率，[0, 1]，默认 0.5。 */
  reversalRate?: number | undefined;
  /** 随机源注入点（测试用固定序列做确定性断言），缺省 crypto。 */
  random?: RandomSource | undefined;
}

/** 抽 count 张：非法参数统一抛 RangeError（消息携带当前合法上/下界，可判定）。 */
export function drawTarotCards(count: number, options: TarotDrawOptions = {}): TarotDrawnCard[] {
  const { arcana, reversalRate = 0.5, random = defaultRandomSource } = options;
  const deck = tarotDeckOf(arcana);
  if (!Number.isInteger(count) || count < 1 || count > deck.length) {
    throw new RangeError(`抽牌数须为 1–${deck.length} 的整数，收到 ${count}`);
  }
  if (reversalRate < 0 || reversalRate > 1) {
    throw new RangeError(`逆位概率须在 [0, 1]，收到 ${reversalRate}`);
  }
  return shuffle(deck, random)
    .slice(0, count)
    .map((card) => ({ card, reversed: random() < reversalRate }));
}

/** 阵抽结果：阵位 key 与牌一一对应，顺序即阵位顺序。 */
export interface TarotSpreadDrawnCard extends TarotDrawnCard {
  positionKey: string;
}

/** 按阵抽取：一次抽取 positions.length 张（阵内无放回），逐位配对阵位 key。 */
export function drawTarotSpread(
  spread: TarotSpread,
  options: TarotDrawOptions = {},
): TarotSpreadDrawnCard[] {
  const cards = drawTarotCards(spread.positions.length, options);
  return spread.positions.map((position, i) => {
    // 不变量：drawTarotCards 已按 positions.length 校验并抽牌，i 必落在结果内
    const drawn = cards[i]!;
    return { positionKey: position.key, card: drawn.card, reversed: drawn.reversed };
  });
}
