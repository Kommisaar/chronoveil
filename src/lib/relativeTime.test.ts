// @vitest-environment node —— 纯逻辑测试无 DOM 依赖，跳过 jsdom 环境创建（测试提速）
// relativeTime 纯函数全覆盖（审计批次 C：Intl 边界最易补）。
// fake timers 钉死 Date.now 让取整边界落到确定分支；文案断言取 Node 22
// （full-icu，本机实测）的 zh/en auto 输出——zh 有「此刻 / 昨天 / 前天」
// 等惯用语、无空格窄间隔，en 的 0 值是「this minute」而非「now」。
// 异常输入无显式守卫，用例钉住源码实际行为（Intl 的拒绝方式）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatClock, formatRelative } from './relativeTime';

const NOW = new Date(2026, 8, 10, 12, 0, 0).getTime(); // 本地时区 2026-09-10 12:00
const MIN = 60_000;

// fake timers 只包住 formatRelative（formatClock 传显式时间戳，不依赖
// Date.now；且 vitest 桩掉 Date 后 Intl 对 NaN 的拒绝路径会失真，见下）。
describe('formatRelative 分支路由（diffMin 取整边界）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('不足 1 分钟走 format(0, minute) 分支：zh「此刻」/ en「this minute」', () => {
    // Math.round(0.33) = 0：diffMin < 1 成立
    expect(formatRelative(NOW - 20_000, 'zh')).toBe('此刻');
    expect(formatRelative(NOW - 20_000, 'en')).toBe('this minute');
    expect(formatRelative(NOW, 'zh')).toBe('此刻');
  });

  it('半分钟整（0.5 四舍五入进位）已离开 <1 分支，落在「1分钟前」', () => {
    expect(formatRelative(NOW - 30_000, 'zh')).toBe('1分钟前');
  });

  it('未来时间戳（负 diff）同样被 <1 分支收口，不显示「N 分钟后」', () => {
    expect(formatRelative(NOW + 5 * MIN, 'zh')).toBe('此刻');
    expect(formatRelative(NOW + 5 * MIN, 'en')).toBe('this minute');
  });

  it('分钟分支：1–59 分钟原值输出', () => {
    expect(formatRelative(NOW - MIN, 'zh')).toBe('1分钟前');
    expect(formatRelative(NOW - 59 * MIN, 'zh')).toBe('59分钟前');
    expect(formatRelative(NOW - 3 * MIN, 'en')).toBe('3 minutes ago');
  });

  it('小时分支：60 分钟进位、90 分钟（1.5）四舍五入进到 2 小时', () => {
    expect(formatRelative(NOW - 60 * MIN, 'zh')).toBe('1小时前');
    expect(formatRelative(NOW - 90 * MIN, 'zh')).toBe('2小时前');
    expect(formatRelative(NOW - 2 * 60 * MIN, 'en')).toBe('2 hours ago');
  });

  it('跨天：≥24h 进天分支，1/2 天出 zh 惯用语「昨天 / 前天」', () => {
    expect(formatRelative(NOW - 24 * 60 * MIN, 'zh')).toBe('昨天');
    expect(formatRelative(NOW - 2 * 24 * 60 * MIN, 'zh')).toBe('前天');
    expect(formatRelative(NOW - 24 * 60 * MIN, 'en')).toBe('yesterday');
    expect(formatRelative(NOW - 3 * 24 * 60 * MIN, 'zh')).toBe('3天前');
  });
});

describe('formatRelative 异常输入（源码无守卫，按 Intl 实际行为钉住）', () => {
  it('+Infinity：diffMin 为 -Infinity 仍被 <1 分支收口为「此刻」', () => {
    expect(formatRelative(Number.POSITIVE_INFINITY, 'zh')).toBe('此刻');
  });

  it('NaN：三处大小比较全为 false 落入天分支，Intl 拒绝非有限值抛 RangeError', () => {
    expect(() => formatRelative(Number.NaN, 'zh')).toThrow(RangeError);
  });

  it('结构非法的语言标签由 Intl 构造期拒绝（RangeError），非应用层回落', () => {
    expect(() => formatRelative(NOW - MIN, 'en_')).toThrow(RangeError);
  });

  it('未知但结构合法的语言标签不抛出：交给 Intl 回落默认区域格式', () => {
    expect(typeof formatRelative(NOW - 3 * MIN, 'not-a-lang')).toBe('string');
  });
});

describe('formatClock（消息头钟面时间）', () => {
  it('按语言出 HH:mm：zh 24 小时制，en 12 小时制带上下午标记', () => {
    const at = new Date(2026, 8, 10, 14, 5).getTime();
    expect(formatClock(at, 'zh')).toBe('14:05');
    expect(formatClock(at, 'en')).toBe('02:05 PM');
  });

  it('非法时间戳无守卫：NaN 被 Intl 以 RangeError 拒绝（实际行为）', () => {
    expect(() => formatClock(Number.NaN, 'zh')).toThrow(RangeError);
  });
});
