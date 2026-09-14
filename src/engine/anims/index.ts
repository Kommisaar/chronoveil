/**
 * 18 种出场动画风格（FR-005，demo CSS + JS 搬家，TASK-004）：
 * 注册表只收拢每风格的时长倍率与盒化（inline-block）标记——真正的动画在 engine.css，
 * 命名与关键帧与 demo 逐一对照。保持纯 CSS：不引 React/Fluent（ADR-010 引擎纯净层，ADR-011 动画不入 Griffel）。
 */

/** 18 风格注册表（顺序即 demo 芯片序）：id/label 与 demo 一致；durFactor 取主 transition/animation 倍率；
 * boxed = 带位移/旋转/缩放、必须 display:inline-block（transform 对 inline 无效） */
export const ANIM_STYLES = [
  { id: 'fade', label: '平滑浮现', durFactor: 1, boxed: false },
  { id: 'caret', label: '光标随行', durFactor: 0.45, boxed: false },
  { id: 'type', label: '打字机', durFactor: 0, boxed: false },
  { id: 'rise', label: '浮现上移', durFactor: 1.3, boxed: true },
  { id: 'blur', label: '聚焦显影', durFactor: 1.5, boxed: false },
  { id: 'dots', label: '思考点', durFactor: 1, boxed: false },
  { id: 'neon', label: '霓虹通电', durFactor: 1.4, boxed: false },
  { id: 'decode', label: '字符解码', durFactor: 1, boxed: false },
  { id: 'flip', label: '翻牌登场', durFactor: 0.8, boxed: true },
  { id: 'drop', label: '坠落弹跳', durFactor: 0.95, boxed: true },
  { id: 'scan', label: '光束扫描', durFactor: 1.1, boxed: false },
  { id: 'ink', label: '墨晕沉淀', durFactor: 1.3, boxed: true },
  { id: 'glitch', label: '信号撕裂', durFactor: 0.9, boxed: true },
  { id: 'write', label: '笔迹生长', durFactor: 0.75, boxed: true },
  { id: 'dust', label: '星尘落定', durFactor: 1.1, boxed: true },
  { id: 'pulse', label: '心跳脉冲', durFactor: 1.6, boxed: true },
  { id: 'condense', label: '收拢凝字', durFactor: 0.9, boxed: true },
  { id: 'spot', label: '聚光点亮', durFactor: 1.6, boxed: false },
] as const;

export type AnimStyleId = (typeof ANIM_STYLES)[number]['id'];

/** 默认风格（跟随全局语义的全局端默认值，2026-09-14）：与 Rust
 *  infra/config.rs 的 DEFAULT_RENDER_STYLE 互指（同一约束两端）。 */
export const DEFAULT_RENDER_STYLE: AnimStyleId = 'type';

export interface AnimStyleMeta {
  id: AnimStyleId;
  /** 中文展示名（与 demo 芯片文案一致） */
  label: string;
  /** 主时长的 --dur 倍率（取该风格主 transition/animation 的倍率） */
  durFactor: number;
  /** 带位移/旋转/缩放的风格必须 display:inline-block（transform 对 inline 无效） */
  boxed: boolean;
}

/** --dur 基准范围（demo 控件 150–1200，默认 450） */
export const DUR_MIN_MS = 150;
export const DUR_MAX_MS = 1200;
export const DUR_DEFAULT_MS = 450;

export function clampDuration(ms: number): number {
  if (Number.isNaN(ms)) return DUR_DEFAULT_MS;
  return Math.min(DUR_MAX_MS, Math.max(DUR_MIN_MS, ms));
}

export function isAnimStyle(id: string): id is AnimStyleId {
  return ANIM_STYLES.some((s) => s.id === id);
}

export function animStyleMeta(id: AnimStyleId): AnimStyleMeta {
  return ANIM_STYLES.find((s) => s.id === id) ?? ANIM_STYLES[0];
}

/** 切换风格：改 data-anim 即时生效，已上屏 token 不重播（FR-005） */
export function applyStyle(root: HTMLElement, style: AnimStyleId): void {
  root.dataset.anim = style;
}

/** 调 --dur 基准（写入容器内联样式），范围外钳制 */
export function applyDuration(root: HTMLElement, ms: number): void {
  root.style.setProperty('--dur', clampDuration(ms) + 'ms');
}

/**
 * 双 rAF 后再加 .show：确保初始帧（隐藏态）先渲染，transition/animation 才会生效（FR-005 踩坑记录）。
 * 无 rAF 环境（极端内嵌）退化为立即显示。
 */
export function revealAfterDoubleRaf(el: HTMLElement): void {
  if (typeof requestAnimationFrame !== 'function') {
    el.classList.add('show');
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
}

/**
 * 随机落点属性（demo renderTok）：星尘落定等风格消费，其余风格无视。
 * dx ∈ ±0.7em，dy ∈ ±0.6em，rot ∈ ±12deg。
 */
export function randomLanding(): { dx: string; dy: string; rot: string } {
  return {
    dx: (Math.random() - 0.5) * 1.4 + 'em',
    dy: (Math.random() - 0.5) * 1.2 + 'em',
    rot: (Math.random() - 0.5) * 24 + 'deg',
  };
}

/* ---------- 字符解码（demo decode 分支）：乱码轮换 + 全局登记统一收尾定格 ---------- */

const DECODE_GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺ0123456789#$%&';
export const DECODE_STEP_MS = 42;
export const DECODE_ROUNDS_MIN = 7;
export const DECODE_ROUNDS_RANGE = 6;

interface Scramble {
  iv: number;
  el: HTMLSpanElement;
}

/** 全局乱码轮换登记：中断/重播统一收尾定格（demo scrambles） */
const scrambles: Scramble[] = [];

/** 乱码化：保留空白，其余字符随机替换（demo 的 glyph 映射） */
export function scrambleText(text: string): string {
  return [...text]
    .map((ch) => (/\s/.test(ch) ? ch : DECODE_GLYPHS[Math.floor(Math.random() * DECODE_GLYPHS.length)]))
    .join('');
}

/**
 * 对一个 token 启动乱码轮换：42ms 一跳，7–12 跳后定格真文并加 .settled；
 * 轮换期间登记进全局 scrambles。
 */
export function startDecodeScramble(el: HTMLSpanElement, realText: string): void {
  el.dataset.real = realText;
  let n = 0;
  const total = DECODE_ROUNDS_MIN + Math.floor(Math.random() * DECODE_ROUNDS_RANGE);
  const iv = window.setInterval(() => {
    n++;
    if (n >= total) {
      el.textContent = realText;
      el.classList.add('settled');
      window.clearInterval(iv);
      const i = scrambles.findIndex((x) => x.iv === iv);
      if (i >= 0) scrambles.splice(i, 1);
      return;
    }
    el.textContent = scrambleText(realText);
  }, DECODE_STEP_MS);
  scrambles.push({ iv, el });
}

/** 统一收尾定格：清轮换、还原真文、加 .settled（finish/cancel 时调用） */
export function settleAllScrambles(): void {
  for (const x of scrambles) {
    window.clearInterval(x.iv);
    x.el.textContent = x.el.dataset.real ?? '';
    x.el.classList.add('settled');
  }
  scrambles.length = 0;
}
