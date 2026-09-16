/**
 * 塔罗牌随机系统公共入口（纯核心库，无 UI / IPC / i18n 依赖）：牌库 +
 * 均匀洗牌 + 无放回抽取（正逆位 / 大小阿卡纳限定 / 牌阵）。消费方只从本
 * 入口引用，内部文件路径不外泄。
 */
export {
  TAROT_DECK,
  tarotDeckOf,
  type TarotArcana,
  type TarotCard,
  type TarotSuit,
} from './deck';
export {
  drawTarotCards,
  drawTarotSpread,
  type TarotDrawnCard,
  type TarotDrawOptions,
  type TarotSpreadDrawnCard,
} from './draw';
export {
  TAROT_SPREAD_SINGLE,
  TAROT_SPREAD_THREE,
  type TarotSpread,
  type TarotSpreadPosition,
} from './spreads';
export { defaultRandomSource, shuffle, type RandomSource } from './shuffle';
