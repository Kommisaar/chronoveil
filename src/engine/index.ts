/**
 * 渲染引擎公开 API（CMP-001 / TASK-004）：纯 TS/DOM/CSS，零 React 依赖（ADR-010，可单测）。
 * 三段式（FR-002）：生产者只管 enqueue（token/结构单元）→ 单元队列 → 16ms tick 信用消费者；
 * 动画仪式全部交给 CSS（容器 data-anim + --dur 基准），高频更新直插 DOM。
 *
 * 回合生命周期：beginTurn()（直接开演）或 think(text)（思考收拢后自动开演）；
 * 生产者 finish() 后队列排空即收尾（定格、摘光标、清乱码）；done 落在思考阶段
 * 时先收拢胶囊再收尾，不瞬时拆除（审计发现 4）。
 */
import './engine.css';
import {
  AnimStyleId,
  DUR_DEFAULT_MS,
  applyDuration,
  applyStyle,
  isAnimStyle,
  randomLanding,
  revealAfterDoubleRaf,
  settleAllScrambles,
  startDecodeScramble,
} from './anims/index';
import { CreditClock, TICK_MS, microPauseMs } from './clock';
import { StreamParser } from './parser';
import { StreamUnit, UnitQueue, isHr, isItem, isPara } from './queue';
import { ParagraphStream } from './seal';
import { Granularity, takeUnit } from './take-unit';
import { DEFAULT_THINK_TIPS, ThinkChannel } from './think';

export { ANIM_STYLES, DUR_DEFAULT_MS, DUR_MAX_MS, DUR_MIN_MS, clampDuration } from './anims/index';
export type { AnimStyleId, AnimStyleMeta } from './anims/index';
export { CreditClock, TICK_MS, microPauseMs, speedFactor, tickIntervalMs } from './clock';
export { StreamParser } from './parser';
export { renderStaticMarkdown } from './static';
export { ParagraphStream } from './seal';
export type { Granularity } from './take-unit';
export { takeUnit } from './take-unit';
export { DEFAULT_THINK_TIPS, THINK_PHASE, ThinkChannel, formatThinkDuration } from './think';
export type { StreamUnit, TextUnit, ParaUnit, HrUnit, ItemUnit } from './queue';
export { UnitQueue } from './queue';

/** 节奏可调范围（FR-002：10–160ms/字，默认 45ms，全局设置「打字机速度」） */
export const RHYTHM_MIN_MS = 10;
export const RHYTHM_MAX_MS = 160;
export const RHYTHM_DEFAULT_MS = 45;

function clampRhythm(ms: number): number {
  if (Number.isNaN(ms)) return RHYTHM_DEFAULT_MS;
  return Math.min(RHYTHM_MAX_MS, Math.max(RHYTHM_MIN_MS, ms));
}

export interface RendererOptions {
  /** 出场动画风格，默认 fade */
  style?: AnimStyleId;
  /** --dur 动效基准 ms（150–1200），默认 450 */
  durationMs?: number;
  /** 节奏 ms/字（10–160），默认 45 */
  msPerChar?: number;
  /** 标点微停开关，默认开 */
  punctPause?: boolean;
  /** 发射粒度 1/2/4，内部默认 2（不暴露 UI，FR-002） */
  granularity?: Granularity;
  /** 光标随行，默认开 */
  cursor?: boolean;
  /** 思考贴士池，默认内置 12 条 */
  thinkTips?: readonly string[];
  /** 回合收尾（正文排空定格）回调 */
  onFinish?: (info: { chars: number }) => void;
}

export interface Renderer {
  /** 当前回合代号：所有跨阶段回调以它核对，防跨回合僵尸回调（FR-003） */
  readonly runId: number;
  /** 队列中待发射的单元数（积压） */
  readonly pending: number;
  /** 本回合已输出字符数（不含空白，口径同 demo） */
  readonly charsEmitted: number;
  /** 生产者：到达文本入队（走 markdown-lite 流式解析） */
  enqueue(chunk: string): void;
  /** 生产者：直接入队一个单元（如外部预解析的结构单元） */
  enqueueUnit(unit: StreamUnit): void;
  /** 开新回合：清屏重置并立即开始正文消费（无思考阶段） */
  beginTurn(): void;
  /** 开新回合并进入思考阶段：快滚 → 收拢胶囊，随后自动开演正文 */
  think(text: string): void;
  /**
   * 开新回合并进入思考阶段（流式变体，TASK-006）：思考文本随后经 `appendThink`
   * 增量喂入、`finishThinking` 显式收拢（FR-003 接通真实 LLM——reasoning 增量到达时
   * 快滚逐字追上，追平不收拢）。
   */
  thinkStreaming(): void;
  /** 增量喂入思考文本（`thinkStreaming` 回合内有效） */
  appendThink(delta: string): void;
  /** 思考流结束：提前收拢（落定 → 收拢胶囊 → 自动开演正文），幂等 */
  finishThinking(): void;
  /**
   * 立即（不经节奏队列）把已累积正文渲染上屏：会话切回重挂时回放积压
   * （ADR-007 降级渲染——不在场会话只入队不渲染，回到前台一次性补齐）。
   */
  replayInstant(chunk: string): void;
  /** 生产者完毕：解析器尾巴落队，队列排空后收尾定格；思考阶段则先收拢胶囊
      （走完落定+收拢动画）再开演正文并收尾（审计发现 4） */
  finish(): void;
  /** 立即中止当前回合：停一切计时/乱码，清队列（保留已上屏内容） */
  cancel(): void;
  /** 中途切换出场风格：改 data-anim 即时生效，不重播已上屏 token（FR-005） */
  setStyle(style: AnimStyleId): void;
  /** 调 --dur 基准（150–1200ms，范围外钳制） */
  setDuration(ms: number): void;
  /** 调节奏与标点微停开关，下一拍即生效 */
  setRhythm(msPerChar: number, punctPauseEnabled: boolean): void;
  /** 调发射粒度（1/2/4） */
  setGranularity(n: Granularity): void;
  /** 开关光标随行 */
  setCursorEnabled(visible: boolean): void;
}

class StreamRenderer implements Renderer {
  private readonly queue = new UnitQueue();
  private readonly parser = new StreamParser();
  private readonly clock = new CreditClock();
  private readonly sealer: ParagraphStream;
  private readonly cursorEl: HTMLSpanElement;
  private readonly thinkTips: readonly string[];
  private readonly onFinish: ((info: { chars: number }) => void) | undefined;

  private styleId: AnimStyleId;
  private msPerChar: number;
  private punctPause: boolean;
  private granularity: Granularity;
  private cursorEnabled: boolean;

  private runIdN = 0;
  private chars = 0;
  private producerDone = false;
  private bodyBegan = false;
  private thinkChannel: ThinkChannel | null = null;
  private consumerTimer: number | null = null;
  private dotsEl: HTMLSpanElement | null = null;

  constructor(private readonly root: HTMLElement, options: RendererOptions = {}) {
    this.sealer = new ParagraphStream(root);
    this.styleId = options.style && isAnimStyle(options.style) ? options.style : 'fade';
    this.msPerChar = clampRhythm(options.msPerChar ?? RHYTHM_DEFAULT_MS);
    this.punctPause = options.punctPause ?? true;
    this.granularity = options.granularity ?? 2;
    this.cursorEnabled = options.cursor ?? true;
    this.thinkTips = options.thinkTips ?? DEFAULT_THINK_TIPS;
    this.onFinish = options.onFinish;

    this.cursorEl = document.createElement('span');
    this.cursorEl.className = 'stream-cursor';
    applyStyle(root, this.styleId);
    applyDuration(root, options.durationMs ?? DUR_DEFAULT_MS);
  }

  get runId(): number {
    return this.runIdN;
  }

  get pending(): number {
    return this.queue.length;
  }

  get charsEmitted(): number {
    return this.chars;
  }

  enqueue(chunk: string): void {
    if (!chunk) return;
    this.queue.enqueue(this.parser.push(chunk));
  }

  enqueueUnit(unit: StreamUnit): void {
    this.queue.enqueue(unit);
  }

  beginTurn(): void {
    this.newTurn();
    this.beginBody();
  }

  think(text: string): void {
    this.newTurn();
    this.startThinkChannel(text, false);
  }

  thinkStreaming(): void {
    this.newTurn();
    this.startThinkChannel('', true);
  }

  appendThink(delta: string): void {
    // 过气回合（runId 已换代）不喂：ThinkChannel 已被 cancel 置空
    this.thinkChannel?.appendText(delta);
  }

  finishThinking(): void {
    this.thinkChannel?.finish();
  }

  replayInstant(chunk: string): void {
    if (!chunk) return;
    for (const unit of this.parser.push(chunk)) {
      this.renderUnit(unit);
    }
  }

  /** 开思考通道（demo 全文模式 / 流式增量模式共用），收拢后自动开演正文 */
  private startThinkChannel(text: string, streaming: boolean): void {
    const id = this.runIdN;
    this.thinkChannel = new ThinkChannel(this.root, {
      text,
      streaming,
      tips: this.thinkTips,
      isCurrent: () => this.runIdN === id,
      onDone: () => {
        this.thinkChannel = null;
        if (this.runIdN === id) this.beginBody();
      },
    });
    this.thinkChannel.start();
  }

  finish(): void {
    this.queue.enqueue(this.parser.flush());
    this.producerDone = true;
    if (this.thinkChannel) {
      // 思考通道活跃：不立即收尾（审计发现 4，2026-09-10）——立即 finishTurn 会
      // stopAll 把未收拢的思考胶囊连同收拢动画一并 cancel，观众看到胶囊瞬移消失。
      // 生产者完毕即收拢思考（幂等；流式回合本就等这次收拢），胶囊走完落定 +
      // 收拢动画后 onDone → beginBody 开演正文，tick 发现队列空且 producerDone
      // 再 finishTurn 回报。
      this.thinkChannel.finish();
      return;
    }
    if (!this.queue.length) {
      this.finishTurn();
    } else if (!this.bodyBegan) {
      // 生产者完毕但正文消费尚未开演（无思考阶段且未显式 beginTurn）：兜底开演后排空
      this.beginBody();
    }
    // 其余情况（正文消费中）由 tick 在排空后收尾
  }

  cancel(): void {
    this.runIdN++; // 作废所有跨阶段回调（runId 回合代号）
    this.stopAll();
    this.queue.clear();
    this.parser.reset();
    this.producerDone = false;
    this.bodyBegan = false;
  }

  setStyle(style: AnimStyleId): void {
    this.styleId = style;
    applyStyle(this.root, style);
  }

  setDuration(ms: number): void {
    applyDuration(this.root, ms);
  }

  setRhythm(msPerChar: number, punctPauseEnabled: boolean): void {
    this.msPerChar = clampRhythm(msPerChar);
    this.punctPause = punctPauseEnabled;
  }

  setGranularity(n: Granularity): void {
    this.granularity = n;
  }

  setCursorEnabled(visible: boolean): void {
    this.cursorEnabled = visible;
    if (!visible) this.cursorEl.remove();
  }

  /** 新回合：拆旧（含 runId++）→ 清屏 → 复位计数 */
  private newTurn(): void {
    this.cancel();
    this.root.textContent = '';
    this.sealer.reset();
    this.chars = 0;
  }

  /** 正文开演：思考点样式先插入加载点；对表后启动 16ms 消费者 */
  private beginBody(): void {
    if (this.bodyBegan) return;
    this.bodyBegan = true;
    if (this.styleId === 'dots') {
      const dots = document.createElement('span');
      dots.className = 'dots';
      dots.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
      this.sealer.tail().appendChild(dots);
      this.dotsEl = dots;
    }
    this.clock.reset(performance.now());
    this.consumerTimer = window.setInterval(this.tick, TICK_MS);
  }

  private stopAll(): void {
    if (this.consumerTimer !== null) {
      window.clearInterval(this.consumerTimer);
      this.consumerTimer = null;
    }
    settleAllScrambles();
    this.cursorEl.remove();
    this.removeDots();
    if (this.thinkChannel) {
      this.thinkChannel.cancel();
      this.thinkChannel = null;
    }
  }

  private removeDots(): void {
    this.dotsEl?.remove();
    this.dotsEl = null;
  }

  /** 回合收尾：定格一切（乱码、光标、思考点）并回报字数 */
  private finishTurn(): void {
    this.stopAll();
    this.producerDone = false;
    this.bodyBegan = false;
    this.onFinish?.({ chars: this.chars });
  }

  /** 消费者：16ms 一拍，信用记账 + 粒度合并 + 标点微停（demo tick 搬家） */
  private tick = (): void => {
    const backlog = this.queue.length;
    this.clock.begin(performance.now(), backlog, this.msPerChar);
    if (backlog === 0) {
      // 空转不攒速度（begin 已清零信用）；生产者完毕且排空 → 收尾
      if (this.producerDone) this.finishTurn();
      return;
    }
    while (this.queue.length && this.clock.canEmit()) {
      const u = takeUnit(this.queue, this.granularity);
      if (!u) break;
      this.renderUnit(u);
      this.clock.charge(microPauseMs(u, this.msPerChar, this.punctPause));
    }
  };

  /** 上屏一个单元（demo renderTok 搬家）：段落封存 / 场景线 / 列表项 /
      带动画仪式的 token */
  private renderUnit(u: StreamUnit): void {
    if (isPara(u)) {
      this.sealer.seal(); // 段落封存，后续进新容器
      return;
    }
    if (isHr(u)) {
      this.sealer.sceneLine();
      return;
    }
    if (isItem(u)) {
      // 列表项：封存前段，开带列表类的段（• 前缀/序号文本已由解析器吐出）
      this.sealer.seal();
      this.sealer.tail(u.ordered ? 'oli' : 'uli');
      return;
    }
    if (this.dotsEl) this.removeDots();
    const s = document.createElement('span');
    s.className = 'tok' + (u.a ? ' action' : '') + (u.b ? ' bold' : '');
    s.textContent = u.t;
    // 随机落点：星尘落定等风格用，其余风格无视
    const landing = randomLanding();
    s.style.setProperty('--dx', landing.dx);
    s.style.setProperty('--dy', landing.dy);
    s.style.setProperty('--rot', landing.rot);
    const tail = this.sealer.tail();
    tail.insertBefore(s, this.cursorEl.parentNode === tail ? this.cursorEl : null);
    if (this.cursorEnabled) tail.appendChild(this.cursorEl);
    // 解码：乱码快速轮换后定格，像破译一行密文
    if (this.root.dataset.anim === 'decode' && u.t.trim()) startDecodeScramble(s, u.t);
    revealAfterDoubleRaf(s);
    this.chars += u.t.trim().length;
  }
}

/** 创建渲染实例并绑定容器元素（容器持有 data-anim / --dur / .para / .think 结构） */
export function createRenderer(container: HTMLElement, options: RendererOptions = {}): Renderer {
  return new StreamRenderer(container, options);
}
