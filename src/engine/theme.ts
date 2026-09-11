/**
 * 引擎语法配色双主题适配（路线图遗留项：亮色对比度达标）。
 *
 * 背景：engine.css :root 的引擎命名空间变量默认 = demo 暗色硬编码（无覆写
 * 即零回归）。挂载侧此前只覆写了场景线两变量（ChatView engineThemeVars）与
 * 加粗（personaMarkdown），聊天流亮色主题下 .action / .tok.bold / decode
 * 字色仍是暗色调值，实测对比度（WCAG 2.x，对亮色正文表面 #ffffff）：
 *   .action   #93a5c8 → 2.48:1   （bold 1.22:1、decode 1.94:1 同病）
 * 全部低于 AA 正文线 4.5:1。修复策略：两套配色收敛为本文件常量（守卫测试
 * 直读此表做双主题对比度断言，engine.css 的 :root 默认值与 dark 表锁死），
 * 引擎在拿到容器时探测所在表面明暗并注入亮色变量——features 侧零改动。
 *
 * 主题判别：从容器沿祖先链找第一个不透明背景色（聊天正文表面 =
 * Fluent colorNeutralBackground1：亮 #ffffff 亮度 1.0 / 暗 #292929 亮度
 * 0.027，间隔极大），相对亮度 ≥ 0.5 判为亮色表面。找不到 painted 表面
 * （jsdom 单测、全透明祖先链）按暗色处理 = 现状默认，零回归。
 */

/** 三类语法字色：*动作* 斜体 / **加粗** / decode 乱码期（其余变量不随主题翻转） */
export interface EngineSyntaxPalette {
  /** .action 蓝灰斜体（同 hue 降明度：亮色 #54658a 对白底 5.82:1） */
  action: string;
  /** 加粗字色（米白 → 暖深灰墨，亮色 #4a4438 对白底 9.65:1） */
  bold: string;
  /** decode 乱码期字色（琥珀系同 hue 降明度：亮色 #8a5c1a 对白底 5.79:1） */
  decode: string;
}

/**
 * 双主题调色板常量表（对比度守卫测试直读）。dark 表 = demo 暗色原值，
 * 对暗色正文表面 #292929 实测 5.86 / 11.91 / 7.52（≥4.5），不得改动；
 * light 表为同色相降明度的达标值（对白底 5.82 / 9.65 / 5.79）。
 */
export const ENGINE_SYNTAX_PALETTES: Readonly<Record<'dark' | 'light', EngineSyntaxPalette>> = {
  dark: { action: '#93a5c8', bold: '#f2e7d8', decode: '#e8b06a' },
  light: { action: '#54658a', bold: '#4a4438', decode: '#8a5c1a' },
};

/** 调色板 → engine.css 命名空间变量名（写入容器内联样式的键） */
const PALETTE_VAR_NAMES: Readonly<Record<keyof EngineSyntaxPalette, string>> = {
  action: '--cv-action-fg',
  bold: '--cv-bold-fg',
  decode: '--cv-decode-fg',
};

/** 亮色表面判别阈值：正文表面亮度 #ffffff=1.0 / #292929≈0.027，0.5 为中点 */
const LIGHT_SURFACE_LUMINANCE = 0.5;

/** #rrggbb → [r, g, b]（0–255）；非法串返回 null（按无色处理） */
export function parseHexColor(hex: string): [number, number, number] | null {
  const hex6 = /^#([0-9a-f]{6})$/i.exec(hex.trim())?.[1];
  if (!hex6) return null;
  const n = parseInt(hex6, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** WCAG 2.x 相对亮度（sRGB 通道线性化后加权） */
export function relativeLuminance(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x 对比度（亮暗归一，(L亮+0.05)/(L暗+0.05)） */
export function contrastRatio(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 从容器沿祖先链（含自身）找第一个不透明背景色，按亮度判别亮/暗表面。
 * 找不到 painted 表面（全透明 / jsdom 无级联样式）返回 null，由调用方
 * 按暗色默认处理（零回归兜底）。仅依赖 getComputedStyle + DOM，纯引擎层。
 */
export function detectSurfaceTheme(el: HTMLElement): 'light' | 'dark' | null {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const bg = node.ownerDocument.defaultView?.getComputedStyle(node).backgroundColor ?? '';
    const m = /^rgba?\(([^)]+)\)$/i.exec(bg.trim());
    const body = m?.[1];
    if (!body) continue;
    const parts = body.split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) continue;
    const rgb = parts.slice(0, 3).map((v) => Number(v)) as [number, number, number];
    // alpha 通道（rgb() 第 4 段或 / 后的值）：不透明才算「这块表面有底色」
    const alpha = parts.length >= 4 ? Number(parts[3]) : 1;
    if (!rgb.every((c) => Number.isFinite(c)) || alpha < 1) continue;
    return relativeLuminance(rgb) >= LIGHT_SURFACE_LUMINANCE ? 'light' : 'dark';
  }
  return null;
}

/**
 * 按探测结果把语法配色注入容器内联变量（亮色写三变量；暗色改为移除——
 * 回落到 engine.css :root 暗色默认，容器不留冗余内联值）。幂等：重复调用
 * 以最后一次探测为准（beginTurn / renderStaticMarkdown 入口都会重估，
 * 兜住会话中途切主题后同容器复用的场景）。
 */
export function applySyntaxTheme(root: HTMLElement): void {
  const theme = detectSurfaceTheme(root) ?? 'dark';
  const style = root.style;
  for (const key of Object.keys(PALETTE_VAR_NAMES) as Array<keyof EngineSyntaxPalette>) {
    const varName = PALETTE_VAR_NAMES[key];
    if (theme === 'light') {
      style.setProperty(varName, ENGINE_SYNTAX_PALETTES.light[key]);
    } else {
      style.removeProperty(varName);
    }
  }
}
