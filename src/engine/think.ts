/**
 * 思考通道（FR-003，demo playThinking 搬家，TASK-004）：
 * 独立后台通道，不走「节奏」——暗色小字快滚（~24ms/跳 × 2–4 字，定速不自适应）。
 * 阶段时序：起 420–680ms（呼吸点+流光贴士+计时）→ 快滚 → 落定 380ms →
 * 收拢 450ms（折叠为「已深度思考 · Ns ▾」胶囊）→ +520ms 开演正文。胶囊可点击展开回看。
 *
 * - settled 竞态闸门：收拢落闸后，迟到的换词回调不再改写定格文案；
 * - runId 回合代号：所有跨阶段回调先核对代号，杜绝跨回合同调（双路正文僵尸现场）；
 * - visMs 可见时长：只累计页面可见时长，后台/最小化/锁屏不计时；
 *   visibilitychange 回前台重置起算点；秒数分级格式化；
 * - 贴士轮换池：12 条乱序出发、转完一圈前不重样，1200ms 一换、换词 300ms 渐出渐入。
 */

/** demo 阶段时序参数（FR-003 实测值，勿随意调整） */
export const THINK_PHASE = {
  /** 起手延迟：420 + rand×260 ms */
  startDelayMinMs: 420,
  startDelayJitterMs: 260,
  /** 快滚节拍（demo：setInterval(step, 24)） */
  stepIntervalMs: 24,
  /** 每跳 2 + floor(rand×3) → 2–4 字 */
  stepCharMin: 2,
  stepCharRange: 3,
  /** 停半拍再收拢，像思考落定 */
  settlePauseMs: 380,
  /** 收拢动画时长（CSS .think-body transition .45s），计时基准 */
  collapseMs: 450,
  /** 等收拢动画走完再开演正文 */
  beginAfterCollapseMs: 520,
  /** 贴士轮换周期 */
  tipIntervalMs: 1200,
  /** 换词渐出 → 换字 → 渐入 */
  tipFadeMs: 300,
} as const;

/** 秒数分级格式化（demo fmtDur）：<10s 一位小数；≥10s 取整；≥60s 走 m:ss */
export function formatThinkDuration(totalSeconds: number): string {
  if (totalSeconds < 10) return totalSeconds.toFixed(1) + 's';
  if (totalSeconds < 60) return Math.round(totalSeconds) + 's';
  return Math.floor(totalSeconds / 60) + ':' + String(Math.round(totalSeconds % 60)).padStart(2, '0');
}

/** 思考小贴士池：过程搞怪、落点正经（demo THINK_TIPS） */
export const DEFAULT_THINK_TIPS: readonly string[] = [
  '正在回忆……',
  '正在判断情势……',
  '正在揣摩你的心思……',
  '正在翻人设小卡片……',
  '正在斟酌措辞……',
  '正在酝酿情绪……',
  '脑内小剧场开演中……',
  '正在检索记忆碎片……',
  '正在和另一个自己吵架……',
  '灵感排队进场中……',
  '正在校准语气……',
  '偷偷瞄了一眼剧本……',
];

export interface ThinkChannelOptions {
  /** 思考正文（reasoning 文本，快滚上屏） */
  text: string;
  /** 轮换贴士池，默认 12 条内置 */
  tips?: readonly string[];
  /** runId 代号核对：回合已过气（runId 变更）时所有回调自行退场 */
  isCurrent: () => boolean;
  /** 收拢动画走完后开演正文（+520ms） */
  onDone: () => void;
  /**
   * 流式模式（TASK-006，FR-003 接通真实 LLM 用）：reasoning 增量经 `appendText`
   * 持续喂入，快滚追平后**不**自动收拢，等显式 `finish()`。默认 false（demo 语义：
   * 全文已知，追平即收拢）。
   */
  streaming?: boolean;
}

export class ThinkChannel {
  private readonly tips: string[];
  private box: HTMLDivElement | null = null;
  private label: HTMLSpanElement | null = null;
  private time: HTMLSpanElement | null = null;
  private body: HTMLDivElement | null = null;
  private intervals: number[] = [];
  private timeouts: number[] = [];
  private visMs = 0;
  private lastMark = 0;
  private shown = 0;
  private tipIndex = 0;
  private settled = false;
  /** finishScroll 幂等闸（流式 finish 与快滚追平竞争时只走一次） */
  private finishRequested = false;
  /** 思考文本：流式模式下经 appendText 增长（opts.text 只作初值） */
  private text: string;
  private readonly streaming: boolean;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: ThinkChannelOptions,
  ) {
    this.tips = [...(opts.tips ?? DEFAULT_THINK_TIPS)].sort(() => Math.random() - 0.5);
    this.text = opts.text;
    this.streaming = opts.streaming ?? false;
  }

  /**
   * 增量喂入思考文本（流式模式）：快滚逐步追上。已收拢（settled）后到达的迟到增量
   * 只累积不展示（正文已开演，完整 reasoning 以落库为准）。
   */
  appendText(delta: string): void {
    if (!delta) return;
    this.text += delta;
  }

  /**
   * 显式收拢（流式模式用）：思考流结束（首条正文到达 / done），提前走「落定 → 收拢
   * 胶囊 → 开演正文」。与快滚追平触发的收拢同一路径，幂等。
   */
  finish(): void {
    this.finishScroll();
  }

  start(): void {
    const box = document.createElement('div');
    box.className = 'think';
    // 静态结构，无用户输入拼插
    box.innerHTML =
      '<button class="think-head" type="button">'
      + '<span class="tk-dot"></span><span class="tk-label">思考中</span>'
      + '<span class="tk-time"></span><span class="tk-chev">▾</span>'
      + '</button><div class="think-body"></div>';
    this.root.appendChild(box);
    this.box = box;
    this.label = box.querySelector('.tk-label');
    this.time = box.querySelector('.tk-time');
    this.body = box.querySelector('.think-body');
    box.querySelector('.think-head')?.addEventListener('click', this.onHeadClick);

    // 计时只累计页面可见的时长：后台标签被浏览器节流的挂钟时间不计入「思考用时」
    this.lastMark = performance.now();
    document.addEventListener('visibilitychange', this.onVisChange);

    // 小贴士轮换：乱序出发，转完一圈前不重样；换词走渐出 → 换字 → 渐入
    if (this.label) this.label.textContent = this.tips[0] ?? '';
    this.every(() => this.rotateTip(), THINK_PHASE.tipIntervalMs);

    this.delay(
      () => {
        this.step();
        this.every(() => this.step(), THINK_PHASE.stepIntervalMs);
      },
      THINK_PHASE.startDelayMinMs + Math.random() * THINK_PHASE.startDelayJitterMs,
    );
  }

  /** 取消回合：停全部计时、摘监听、移除胶囊 */
  cancel(): void {
    this.disarm();
    this.box?.remove();
    this.box = null;
  }

  private alive(): boolean {
    return this.opts.isCurrent();
  }

  private onHeadClick = (): void => {
    // 胶囊点击展开回看：只有收拢完成后可开合
    if (this.box?.classList.contains('done')) this.box.classList.toggle('collapsed');
  };

  private onVisChange = (): void => {
    if (!this.alive()) {
      document.removeEventListener('visibilitychange', this.onVisChange);
      return;
    }
    this.lastMark = performance.now(); // 回到前台，从现在重新起算
  };

  private rotateTip(): void {
    if (!this.alive() || !this.label) {
      this.disarm();
      return;
    }
    this.tipIndex = (this.tipIndex + 1) % this.tips.length;
    this.label.style.opacity = '0';
    this.delay(() => {
      // settled 闸门：收拢定格后换词回调不再动标签
      if (!this.alive() || this.settled || !this.label) return;
      this.label.textContent = this.tips[this.tipIndex] ?? '';
      this.label.style.opacity = '1';
    }, THINK_PHASE.tipFadeMs);
  }

  private step(): void {
    if (!this.alive() || !this.body || !this.time) {
      this.disarm();
      return;
    }
    const now = performance.now();
    if (!document.hidden) this.visMs += now - this.lastMark;
    this.lastMark = now;
    this.shown = Math.min(this.text.length, this.shown + THINK_PHASE.stepCharMin + Math.floor(Math.random() * THINK_PHASE.stepCharRange));
    this.body.textContent = this.text.slice(0, this.shown);
    this.time.textContent = formatThinkDuration(this.visMs / 1000);
    // 流式模式：追平不收拢（增量还在路上），等显式 finish()；demo 模式：追平即收拢
    if (!this.streaming && this.shown >= this.text.length) this.finishScroll();
  }

  private finishScroll(): void {
    if (this.finishRequested) return; // 幂等：追平触发与显式 finish 只走一次
    this.finishRequested = true;
    // 流式 finish 可能早于快滚追平（真实 reasoning 数千字，~125 字/秒追不平，done 即收拢）。
    // demo 语义确立「收拢前全文可见、胶囊展开回看全文」，并非有意截断——故收拢前把 body
    // 冲平为全文，否则停滚后未上屏的尾巴永久不可回看；demo 追平路径下此冲平为恒等操作。
    this.shown = this.text.length;
    if (this.body) this.body.textContent = this.text;
    this.disarm();
    const total = formatThinkDuration(this.visMs / 1000);
    this.delay(() => {
      if (!this.alive() || !this.box || !this.label || !this.time) return;
      this.settled = true;
      this.label.style.opacity = '1'; // 若正卡在换词渐出中，拉回来
      this.box.classList.add('done', 'collapsed');
      this.label.textContent = '已深度思考';
      this.time.textContent = '· ' + total;
      this.delay(() => {
        // 等收拢动画走完再开演
        if (this.alive()) this.opts.onDone();
      }, THINK_PHASE.beginAfterCollapseMs);
    }, THINK_PHASE.settlePauseMs);
  }

  private delay(fn: () => void, ms: number): void {
    this.timeouts.push(window.setTimeout(fn, ms));
  }

  private every(fn: () => void, ms: number): void {
    this.intervals.push(window.setInterval(fn, ms));
  }

  /** 停全部计时器、摘 visibility 监听（不动 DOM） */
  private disarm(): void {
    for (const id of this.timeouts) window.clearTimeout(id);
    for (const id of this.intervals) window.clearInterval(id);
    this.timeouts = [];
    this.intervals = [];
    document.removeEventListener('visibilitychange', this.onVisChange);
  }
}
