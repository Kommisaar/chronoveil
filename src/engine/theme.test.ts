/**
 * 语法配色双主题对比度守卫（路线图遗留项：亮色可读性达标）。
 *
 * 锁三件事：
 * 1. 两主题 × 三类语法字色（action/bold/decode）对各自主题正文表面的
 *    WCAG 对比度全部 ≥4.5:1（AA 正文线）——防止未来改色值无据回退；
 * 2. dark 调色板 = demo 暗色原值，且与 engine.css :root 默认值逐项一致
 *    （契约一致性：常量表与 css 默认不许各自漂移）；
 * 3. 引擎挂载行为：亮色表面注入亮色变量、暗色/无底回落 :root（零回归）。
 *
 * 基准背景取聊天正文表面（ChatView .stream 的 Fluent colorNeutralBackground1）：
 * 亮 #ffffff、暗 #292929。白底是亮色系中最严苛的浅表面（暗字对比度最低），
 * 人设预览的 #fafafa 只会更松。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRenderer, type Renderer } from './index';
import { renderStaticMarkdown } from './static';
import {
  ENGINE_SYNTAX_PALETTES,
  applySyntaxTheme,
  contrastRatio,
  parseHexColor,
  relativeLuminance,
} from './theme';

// vitest 的 cwd 恒为仓库根（同 anims/index.test.ts 的取法）
const css = readFileSync(resolve(process.cwd(), 'src/engine/engine.css'), 'utf8');

/** 聊天正文表面（Fluent webLight/webDark 的 colorNeutralBackground1 实测值） */
const SURFACE = { light: '#ffffff', dark: '#292929' } as const;
/** AA 正文线（小字号叙事文本一律按此线，bold 虽可放宽 3:1 仍从紧） */
const WCAG_AA = 4.5;

const renderers: Renderer[] = [];
afterEach(() => {
  for (const r of renderers) r.cancel();
  renderers.length = 0;
  document.body.textContent = '';
});

describe('对比度守卫：两主题 × 三样式 ≥ AA（改色值必过此关）', () => {
  it('dark 表对暗色表面、light 表对亮色表面全部 ≥4.5:1', () => {
    for (const theme of ['dark', 'light'] as const) {
      const bg = parseHexColor(SURFACE[theme]);
      expect(bg, '基准背景色须可解析').not.toBeNull();
      for (const [key, hex] of Object.entries(ENGINE_SYNTAX_PALETTES[theme])) {
        const fg = parseHexColor(hex);
        expect(fg, `${hex} 须可解析`).not.toBeNull();
        const ratio = contrastRatio(fg!, bg!);
        expect(ratio, `${theme}.${key} ${hex} 对 ${SURFACE[theme]}`).toBeGreaterThanOrEqual(WCAG_AA);
      }
    }
  });

  it('light 表同 hue 家族不回退暗色观感（与 dark 表逐通道不同，确系双值适配）', () => {
    // 守卫意图：亮色主题不是靠「抄暗色值」达标，三样式都应有独立亮色值
    for (const key of ['action', 'bold', 'decode'] as const) {
      expect(ENGINE_SYNTAX_PALETTES.light[key]).not.toBe(ENGINE_SYNTAX_PALETTES.dark[key]);
    }
  });
});

describe('契约一致：dark 表 = engine.css :root 默认（零回归锚点）', () => {
  it(':root 里三类语法变量默认值与 dark 调色板逐项一致', () => {
    const rootBlock = css.match(/:root \{([^}]*)\}/)?.[1] ?? '';
    expect(rootBlock, ':root 块须存在').not.toBe('');
    const expected: Record<string, string> = {
      '--cv-action-fg': ENGINE_SYNTAX_PALETTES.dark.action,
      '--cv-bold-fg': ENGINE_SYNTAX_PALETTES.dark.bold,
      '--cv-decode-fg': ENGINE_SYNTAX_PALETTES.dark.decode,
    };
    for (const [name, hex] of Object.entries(expected)) {
      expect(rootBlock).toMatch(new RegExp(`${name}:\\s*${hex}\\b`));
    }
  });
});

describe('applySyntaxTheme：按所在表面明暗注入/回落', () => {
  it('白底祖先 → 注入三个亮色变量（值 = light 表）', () => {
    const surface = document.createElement('div');
    surface.style.backgroundColor = '#ffffff';
    const container = document.createElement('div');
    surface.appendChild(container);
    document.body.appendChild(surface);
    applySyntaxTheme(container);
    const light = ENGINE_SYNTAX_PALETTES.light;
    expect(container.style.getPropertyValue('--cv-action-fg')).toBe(light.action);
    expect(container.style.getPropertyValue('--cv-bold-fg')).toBe(light.bold);
    expect(container.style.getPropertyValue('--cv-decode-fg')).toBe(light.decode);
  });

  it('暗底祖先 → 不注入（回落 :root 暗色默认，零回归）', () => {
    const surface = document.createElement('div');
    surface.style.backgroundColor = '#292929';
    const container = document.createElement('div');
    surface.appendChild(container);
    document.body.appendChild(surface);
    applySyntaxTheme(container);
    expect(container.style.getPropertyValue('--cv-action-fg')).toBe('');
    expect(container.style.getPropertyValue('--cv-bold-fg')).toBe('');
    expect(container.style.getPropertyValue('--cv-decode-fg')).toBe('');
  });

  it('无 painted 表面（jsdom 裸容器）→ 按暗色默认处理', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    applySyntaxTheme(container);
    expect(container.style.getPropertyValue('--cv-action-fg')).toBe('');
  });

  it('幂等翻转：先亮后暗重估，内联变量被移除', () => {
    const surface = document.createElement('div');
    surface.style.backgroundColor = '#ffffff';
    const container = document.createElement('div');
    surface.appendChild(container);
    document.body.appendChild(surface);
    applySyntaxTheme(container);
    expect(container.style.getPropertyValue('--cv-bold-fg')).not.toBe('');
    surface.style.backgroundColor = '#292929';
    applySyntaxTheme(container);
    expect(container.style.getPropertyValue('--cv-bold-fg')).toBe('');
  });

  it('createRenderer 挂载即适配：白底祖先下流式容器带亮色变量', () => {
    const surface = document.createElement('div');
    surface.style.backgroundColor = '#ffffff';
    const container = document.createElement('div');
    surface.appendChild(container);
    document.body.appendChild(surface);
    renderers.push(createRenderer(container));
    expect(container.style.getPropertyValue('--cv-action-fg')).toBe(
      ENGINE_SYNTAX_PALETTES.light.action,
    );
  });

  it('renderStaticMarkdown 同路适配：白底下静态正文带亮色变量', () => {
    const surface = document.createElement('div');
    surface.style.backgroundColor = '#ffffff';
    const container = document.createElement('div');
    surface.appendChild(container);
    document.body.appendChild(surface);
    renderStaticMarkdown(container, '**加粗**与*动作*');
    expect(container.style.getPropertyValue('--cv-bold-fg')).toBe(ENGINE_SYNTAX_PALETTES.light.bold);
    expect(container.querySelector('.tok.bold')).not.toBeNull();
  });
});

describe('WCAG 数学自检（相对亮度/对比度实现基准）', () => {
  it('黑白对比度 = 21:1，已知色对数值落在公布值邻域', () => {
    const black = relativeLuminance([0, 0, 0]);
    const white = relativeLuminance([255, 255, 255]);
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 0);
    expect(black).toBe(0);
    expect(white).toBeCloseTo(1, 10);
    // WCAG 例子：#767676 对白 ≈ 4.54:1（常见「白底最低达标灰」）
    expect(contrastRatio(parseHexColor('#767676')!, [255, 255, 255])).toBeCloseTo(4.54, 1);
  });
});
