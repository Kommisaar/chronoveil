// @vitest-environment node —— 纯逻辑测试无 DOM 依赖，跳过 jsdom 环境创建（测试提速）
import { describe, expect, it } from 'vitest';
import { CreditClock, microPauseMs, speedFactor, tickIntervalMs } from './clock';
import { textUnit } from './queue';

describe('自适应追速（FR-002 / NFR-001）', () => {
  it('k = max(0.25, 1/(1+积压/45))：无积压 ×1', () => {
    expect(speedFactor(0)).toBe(1);
  });

  it('积压 45 字 → 2 倍速', () => {
    expect(speedFactor(45)).toBe(0.5);
  });

  it('积压 135 字 → 封顶 ×4（k 下限 0.25）', () => {
    expect(speedFactor(135)).toBe(0.25);
    expect(speedFactor(1000)).toBe(0.25);
  });

  it('interval = max(10ms, 节奏 × k)，下限 10ms', () => {
    expect(tickIntervalMs(0, 45)).toBe(45);
    expect(tickIntervalMs(45, 45)).toBeCloseTo(22.5, 10);
    expect(tickIntervalMs(135, 40)).toBe(10);
    expect(tickIntervalMs(1, 10)).toBe(10);
  });
});

describe('标点微停（FR-002，demo pauseAfter）', () => {
  const r = 45;
  it('段落/场景线深呼吸：260 + 节奏（不受开关影响）', () => {
    expect(microPauseMs({ para: true }, r, true)).toBe(305);
    expect(microPauseMs({ hr: true }, r, false)).toBe(305);
  });

  it('句末标点：150 + 节奏 × 0.8', () => {
    expect(microPauseMs(textUnit('。'), r, true)).toBe(150 + r * 0.8);
    expect(microPauseMs(textUnit('！'), r, true)).toBe(150 + r * 0.8);
    expect(microPauseMs(textUnit('…'), r, true)).toBe(150 + r * 0.8);
    expect(microPauseMs(textUnit('\n'), r, true)).toBe(150 + r * 0.8);
  });

  it('逗号类标点：55 + 节奏 × 0.4', () => {
    expect(microPauseMs(textUnit('，'), r, true)).toBe(55 + r * 0.4);
    expect(microPauseMs(textUnit('、'), r, true)).toBe(55 + r * 0.4);
    expect(microPauseMs(textUnit('”'), r, true)).toBe(55 + r * 0.4);
    expect(microPauseMs(textUnit('—'), r, true)).toBe(55 + r * 0.4);
  });

  it('普通字符无微停；开关关闭时文本微停放空', () => {
    expect(microPauseMs(textUnit('字'), r, true)).toBe(0);
    expect(microPauseMs(textUnit('。'), r, false)).toBe(0);
  });
});

describe('信用记账（FR-002，demo tick）', () => {
  it('开演对表后首拍 dt=16，低速下不足一份信用', () => {
    const c = new CreditClock();
    c.reset(0);
    c.begin(16, 1, 45);
    expect(c.canEmit()).toBe(false);
  });

  it('信用随时间累积，攒满即可发射；发射扣 1', () => {
    const c = new CreditClock();
    c.reset(0);
    c.begin(100, 1, 45); // interval ≈ 44.02，credit ≈ 2.27
    expect(c.canEmit()).toBe(true);
    c.charge(0);
    expect(c.canEmit()).toBe(true); // ≈ 1.27
    c.charge(0);
    expect(c.canEmit()).toBe(false); // ≈ 0.27
  });

  it('信用上限 3：积压再大也不连发超过 3 字/拍', () => {
    const c = new CreditClock();
    c.reset(0);
    c.begin(1000, 100, 10); // dt 钳制 100、interval 10 → credit=10 → 封顶 3
    expect(c.currentCredit).toBe(3);
    c.charge(0);
    c.charge(0);
    c.charge(0);
    expect(c.canEmit()).toBe(false);
  });

  it('dt 钳制 100ms：后台节流不补发', () => {
    const c = new CreditClock();
    c.reset(0);
    c.begin(5000, 1, 45);
    expect(c.currentCredit).toBeCloseTo(100 / tickIntervalMs(1, 45), 10);
  });

  it('空队列清零信用：空转不攒速度', () => {
    const c = new CreditClock();
    c.reset(0);
    c.begin(100, 1, 45);
    expect(c.canEmit()).toBe(true);
    c.begin(116, 0, 45);
    expect(c.currentCredit).toBe(0);
    expect(c.canEmit()).toBe(false);
    c.begin(132, 1, 45); // 从 0 重新攒
    expect(c.currentCredit).toBeCloseTo(16 / tickIntervalMs(1, 45), 10);
  });

  it('微停 = 负信用：大停顿把信用扣成负数', () => {
    const c = new CreditClock();
    c.reset(0);
    c.begin(100, 1, 45); // credit ≈ 2.27
    c.charge(500); // 1 + 500/44.02 ≈ 12.36 → 约 -10
    expect(c.currentCredit).toBeLessThan(0);
    expect(c.canEmit()).toBe(false);
    c.begin(116, 0, 45);
    expect(c.currentCredit).toBe(0); // 负值也被空队列清零兜底
  });

  it('句末微停按 interval 折算（150+节奏×0.8）/ interval', () => {
    const c = new CreditClock();
    c.reset(0);
    c.begin(100, 1, 45);
    const interval = c.currentIntervalMs;
    const before = c.currentCredit;
    c.charge(microPauseMs(textUnit('。'), 45, true));
    expect(c.currentCredit).toBeCloseTo(before - 1 - (150 + 45 * 0.8) / interval, 10);
  });
});
