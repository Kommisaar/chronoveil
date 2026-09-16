// @vitest-environment node
// 洗牌测试：注入固定随机源做 Fisher-Yates 确定性断言 + 纯度与平凡情形。
import { describe, expect, it } from 'vitest';
import { shuffle, type RandomSource } from './shuffle';

/** 固定序列随机源：依序吐出值，耗尽后从头循环（确定性、可复现）。 */
function sequenceRandom(values: readonly number[]): RandomSource {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('Fisher-Yates 洗牌', () => {
  it('恒 0 随机源 → j 恒为 0 的确定性排列（下界边界钉死）', () => {
    // i=4..1 依次与位 0 交换：[1,2,3,4,5] → [2,3,4,5,1]
    expect(shuffle([1, 2, 3, 4, 5], () => 0)).toEqual([2, 3, 4, 5, 1]);
  });

  it('恒 0.999 随机源 → j 恒为 i 的恒等排列（上界边界钉死）', () => {
    expect(shuffle([1, 2, 3, 4, 5], () => 0.999)).toEqual([1, 2, 3, 4, 5]);
  });

  it('不改入参数组（纯函数）', () => {
    const input = [1, 2, 3, 4, 5];
    shuffle(input, sequenceRandom([0.1, 0.5, 0.9, 0.3]));
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });

  it('平凡情形：空数组与单元素', () => {
    expect(shuffle([], () => 0)).toEqual([]);
    expect(shuffle(['only'], () => 0)).toEqual(['only']);
  });

  it('默认 crypto 随机源：结果为输入的全排列（多重集相等）', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const output = shuffle(input);
    expect([...output].sort((a, b) => a - b)).toEqual(input);
  });
});
