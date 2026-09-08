/**
 * 16ms 节拍器 + 信用记账 + 自适应追速（FR-002 / NFR-001，demo tick/pauseAfter 搬家，TASK-004）。
 * - 信用上限 3；空队列清零（空转不攒速度）；标点微停 = 负信用；
 * - 追速 k = max(0.25, 1/(1+积压/45))：积压 45 字 → 2 倍速，封顶 ×4；interval 下限 10ms；
 * - 标点微停：段落/场景线 260ms+节奏；句末 150ms+节奏×0.8；逗号类 55ms+节奏×0.4；
 * - 不设积压熔断（ADR-003）：表演优先，供给持续超速时接受延迟增长。
 */
import { isHr, isPara, isText, StreamUnit } from './queue';

/** 消费者 tick 周期（demo：setInterval(tick, 16)） */
export const TICK_MS = 16;
/** 信用上限（demo：if (credit > 3) credit = 3） */
export const CREDIT_CAP = 3;
/** 发射间隔下限 ms（demo：Math.max(10, base * k)） */
export const INTERVAL_FLOOR_MS = 10;
/** 单次 tick 的 dt 钳制（后台标签节流时不补发，demo：Math.min(100, ...)） */
export const DT_CLAMP_MS = 100;
/** 追速平滑常数：积压 45 字 → 2 倍速（demo 实测 NFR-001） */
export const BACKLOG_SMOOTHING = 45;

/** 句末标点（demo pauseAfter） */
const SENTENCE_END_RE = /[。！？…\n]/;
/** 逗号类标点（demo pauseAfter） */
const CLAUSE_PAUSE_RE = /[，、；：）】》”’—]/;

/**
 * 追速因子 k：积压越大吐字越快。
 * k = max(0.25, 1/(1 + backlog/45))，即积压 45 字 → ×2，封顶 ×4（k 下限 0.25）。
 */
export function speedFactor(backlog: number): number {
  return Math.max(0.25, 1 / (1 + backlog / BACKLOG_SMOOTHING));
}

/** 一次发射的间隔：max(10ms, 节奏 × k) */
export function tickIntervalMs(backlog: number, msPerChar: number): number {
  return Math.max(INTERVAL_FLOOR_MS, msPerChar * speedFactor(backlog));
}

/**
 * 标点微停（毫秒，demo pauseAfter）：轻微呼吸感，不是打字机式大停顿。
 * 结构单元固定深呼吸（不受开关影响）；开关关闭时文本微停放空。
 */
export function microPauseMs(unit: StreamUnit, msPerChar: number, punctPauseEnabled: boolean): number {
  if (isPara(unit) || isHr(unit)) return 260 + msPerChar;
  if (!punctPauseEnabled) return 0;
  const last = isText(unit) ? unit.t.slice(-1) : '';
  if (SENTENCE_END_RE.test(last)) return 150 + msPerChar * 0.8;
  if (CLAUSE_PAUSE_RE.test(last)) return 55 + msPerChar * 0.4;
  return 0;
}

/**
 * 信用钟：消费侧的节拍记账器。
 * 每次 16ms tick 先 begin()（按积压算 interval、记信用），随后每发射一个单元 charge()
 * 扣 1 信用并叠加微停折算的负信用；canEmit() 为真才继续发射。
 */
export class CreditClock {
  private credit = 0;
  private lastTick: number | null = null;
  private intervalMs = INTERVAL_FLOOR_MS;

  /** 开演时对表：信用清零，lastMark 定在现在（demo：lastTick = performance.now()） */
  reset(now: number): void {
    this.credit = 0;
    this.lastTick = now;
  }

  /**
   * 开始一次 tick：按积压算 interval、记信用（上限 3）。
   * 空队列直接清零信用（空转不攒速度），与 demo 一致。
   */
  begin(now: number, backlog: number, msPerChar: number): void {
    const dt = this.lastTick === null ? 0 : Math.min(DT_CLAMP_MS, now - this.lastTick);
    this.lastTick = now;
    if (backlog <= 0) {
      this.credit = 0;
      return;
    }
    this.intervalMs = tickIntervalMs(backlog, msPerChar);
    this.credit = Math.min(CREDIT_CAP, this.credit + dt / this.intervalMs);
  }

  /** 发射一个单元后的记账：1 信用 + 微停折算的负信用（demo：credit -= p / interval） */
  charge(pauseMs: number): void {
    this.credit -= pauseMs > 0 ? 1 + pauseMs / this.intervalMs : 1;
  }

  /** 是否还有整份信用可发射（demo：while (credit >= 1 && queue.length)） */
  canEmit(): boolean {
    return this.credit >= 1;
  }

  get currentCredit(): number {
    return this.credit;
  }

  get currentIntervalMs(): number {
    return this.intervalMs;
  }
}
