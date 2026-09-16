/**
 * 洗牌（2026-09-16 塔罗核心库）：Fisher-Yates 均匀洗牌——每个排列等概率，
 * 单趟 O(n)。随机源可注入：生产走 crypto.getRandomValues（密码学级，浏览器
 * 与 Node ≥19 全局原生提供，不加环境防御）；测试注入固定序列做确定性断言。
 */

/** 均匀分布 [0, 1) 的随机数源。 */
export type RandomSource = () => number;

/** 默认随机源：crypto 32 位无符号整数折算到 [0, 1)（粒度 2⁻³²，上界开区间）。 */
export const defaultRandomSource: RandomSource = () => {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0]! / 2 ** 32;
};

/** Fisher-Yates：返回新数组（不改入参），调用方持有原序不受影响。 */
export function shuffle<T>(items: readonly T[], random: RandomSource = defaultRandomSource): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    // 不变量：j ≤ i < result.length，两处索引必然存在——noUncheckedIndexedAccess
    // 下 TS 无法推导越界不可能，`!` 是有不变量背书的收窄而非绕过检查
    const picked = result[j]!;
    result[j] = result[i]!;
    result[i] = picked;
  }
  return result;
}
