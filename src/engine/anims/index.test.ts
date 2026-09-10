// node 环境的最小类型声明见同目录 node-env.d.ts（tsconfig 不带 @types/node）
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANIM_STYLES,
  applyDuration,
  applyStyle,
  clampDuration,
  isAnimStyle,
  animStyleMeta,
  randomLanding,
  revealAfterDoubleRaf,
  scrambleText,
  settleAllScrambles,
  startDecodeScramble,
} from './index';

describe('18 风格注册（FR-005）', () => {
  it('全量 18 种，命名与 demo 一致', () => {
    expect(ANIM_STYLES).toHaveLength(18);
    expect(ANIM_STYLES.map((s) => s.id)).toEqual([
      'fade', 'caret', 'type', 'rise', 'blur', 'dots', 'neon', 'decode', 'flip',
      'drop', 'scan', 'ink', 'glitch', 'write', 'dust', 'pulse', 'condense', 'spot',
    ]);
  });

  it('带位移/旋转/缩放的风格标记 boxed（display:inline-block，FR-005 踩坑记录）', () => {
    expect(ANIM_STYLES.filter((s) => s.boxed).map((s) => s.id)).toEqual([
      'rise', 'flip', 'drop', 'ink', 'glitch', 'write', 'dust', 'pulse', 'condense',
    ]);
  });

  it('每风格带独立 --dur 倍率', () => {
    expect(animStyleMeta('caret').durFactor).toBe(0.45);
    expect(animStyleMeta('blur').durFactor).toBe(1.5);
    expect(animStyleMeta('pulse').durFactor).toBe(1.6);
  });

  it('isAnimStyle 守卫未知风格', () => {
    expect(isAnimStyle('fade')).toBe(true);
    expect(isAnimStyle('nope')).toBe(false);
  });
});

describe('风格元数据与 engine.css 一致（TASK-06 复核固化）', () => {
  // vitest 的 cwd 恒为仓库根；不用 new URL(import.meta.url) 是为绕开 vite 的资源改写
  const css = readFileSync(resolve(process.cwd(), 'src/engine/engine.css'), 'utf8');

  it('id 唯一且每风格带非空中文 label', () => {
    const ids = ANIM_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of ANIM_STYLES) {
      expect(s.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('每风格在 engine.css 都有 [data-anim=<id>] .tok 基础规则', () => {
    for (const { id } of ANIM_STYLES) {
      expect(css).toMatch(new RegExp(`\\[data-anim=${id}\\] \\.tok \\{`));
    }
  });

  it('boxed ⇔ .tok 规则带 display:inline-block（transform 对 inline 无效）', () => {
    for (const s of ANIM_STYLES) {
      const block = css.match(new RegExp(`\\[data-anim=${s.id}\\] \\.tok \\{([^}]*)\\}`))?.[1] ?? '';
      expect(block.includes('inline-block')).toBe(s.boxed);
    }
  });

  it('durFactor = 该风格规则里 var(--dur) 的最大倍率（无 calc 倍率则应为 0/1）', () => {
    for (const s of ANIM_STYLES) {
      const rules = css.match(new RegExp(`\\[data-anim=${s.id}\\][^{]*\\{[^}]*\\}`, 'g')) ?? [];
      const factors = [...rules
        .join('\n')
        .matchAll(/calc\(var\(--dur\)\s*\*\s*([0-9.]+)\)/g)]
        .map((m) => Number(m[1]));
      if (factors.length === 0) {
        expect([0, 1]).toContain(s.durFactor); // fade/dots/decode 直用 --dur；type 无过渡
      } else {
        expect(Math.max(...factors)).toBeCloseTo(s.durFactor, 10);
      }
    }
  });
});

describe('--dur 基准（FR-005：150–1200ms，默认 450ms）', () => {
  it('clampDuration 范围钳制', () => {
    expect(clampDuration(100)).toBe(150);
    expect(clampDuration(450)).toBe(450);
    expect(clampDuration(2000)).toBe(1200);
    expect(clampDuration(Number.NaN)).toBe(450);
  });

  it('applyStyle / applyDuration 写入容器', () => {
    const el = document.createElement('div');
    applyStyle(el, 'rise');
    applyDuration(el, 2000);
    expect(el.dataset.anim).toBe('rise'); // 即时切换：只改 data-anim
    expect(el.style.getPropertyValue('--dur')).toBe('1200ms');
  });

  it('applyDuration 下界与 NaN 兜底（DUR_MIN 150 / 默认 450）', () => {
    const el = document.createElement('div');
    applyDuration(el, 50);
    expect(el.style.getPropertyValue('--dur')).toBe('150ms');
    applyDuration(el, Number.NaN);
    expect(el.style.getPropertyValue('--dur')).toBe('450ms');
  });
});

describe('双 rAF 显影（FR-005 踩坑记录，jsdom 行为固化）', () => {
  it('jsdom 有 rAF：双帧后才加 .show（初始隐藏帧先渲染）', async () => {
    const el = document.createElement('span');
    revealAfterDoubleRaf(el);
    expect(el.classList.contains('show')).toBe(false); // 未过双帧保持隐藏态
    await vi.waitFor(() => expect(el.classList.contains('show')).toBe(true));
  });

  it('无 rAF 环境退化为立即显示', () => {
    const g = globalThis as { requestAnimationFrame?: typeof requestAnimationFrame | undefined };
    const raf = g.requestAnimationFrame;
    g.requestAnimationFrame = undefined;
    try {
      const el = document.createElement('span');
      revealAfterDoubleRaf(el);
      expect(el.classList.contains('show')).toBe(true);
    } finally {
      g.requestAnimationFrame = raf;
    }
  });
});

describe('随机落点 --dx/--dy/--rot（FR-005）', () => {
  it('数值在 demo 参数范围内并带单位', () => {
    for (let i = 0; i < 200; i++) {
      const { dx, dy, rot } = randomLanding();
      expect(Math.abs(parseFloat(dx))).toBeLessThanOrEqual(0.7);
      expect(Math.abs(parseFloat(dy))).toBeLessThanOrEqual(0.6);
      expect(Math.abs(parseFloat(rot))).toBeLessThanOrEqual(12);
      expect(dx.endsWith('em')).toBe(true);
      expect(dy.endsWith('em')).toBe(true);
      expect(rot.endsWith('deg')).toBe(true);
    }
  });
});

describe('字符解码乱码（FR-005）', () => {
  afterEach(() => {
    settleAllScrambles();
    vi.useRealTimers();
  });

  it('乱码化保留空白、替换其余字符', () => {
    const out = scrambleText('你好 world');
    expect(out.replace(/\S/g, '#')).toBe('## #####'); // 空白位置原样保留
    expect(out.replace(/\s/g, '')).not.toContain('你');
    expect(out.replace(/\s/g, '')).not.toContain('好');
    expect(out.replace(/\s/g, '')).not.toContain('w');
  });

  it('轮换 7–12 跳后定格真文并加 .settled', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const el = document.createElement('span');
    startDecodeScramble(el, '密');
    vi.advanceTimersByTime(42 * 3);
    expect(el.classList.contains('settled')).toBe(false);
    expect(el.textContent).not.toBe('密'); // 轮换中是乱码
    vi.advanceTimersByTime(42 * 20);
    expect(el.classList.contains('settled')).toBe(true);
    expect(el.textContent).toBe('密'); // 定格真文
  });

  it('settleAllScrambles 统一收尾定格（cancel/finish 路径）', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const el = document.createElement('span');
    startDecodeScramble(el, '真文');
    vi.advanceTimersByTime(42);
    settleAllScrambles();
    expect(el.textContent).toBe('真文');
    expect(el.classList.contains('settled')).toBe(true);
    vi.advanceTimersByTime(42 * 30); // 残留轮换已清，不再改写
    expect(el.textContent).toBe('真文');
  });

  it('startDecodeScramble 登记真文于 dataset.real，轮换期间长度不变', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const el = document.createElement('span');
    startDecodeScramble(el, '密文 X');
    expect(el.dataset.real).toBe('密文 X');
    vi.advanceTimersByTime(42);
    expect(el.textContent).toHaveLength('密文 X'.length); // 乱码与真文逐字对应
    settleAllScrambles();
  });

  it('settleAllScrambles 幂等：登记表清空后重复调用安全', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const el = document.createElement('span');
    startDecodeScramble(el, '真');
    vi.advanceTimersByTime(42);
    settleAllScrambles();
    settleAllScrambles(); // 二次调用：登记表已空，无异常且状态不变
    expect(el.textContent).toBe('真');
    expect(el.classList.contains('settled')).toBe(true);
    vi.advanceTimersByTime(42 * 20);
    expect(el.textContent).toBe('真');
  });

  it('多个乱码同时登记：统一收尾全部定格真文', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const texts = ['一', '二', '三'];
    const els = texts.map((t) => {
      const el = document.createElement('span');
      startDecodeScramble(el, t);
      return el;
    });
    vi.advanceTimersByTime(42);
    settleAllScrambles();
    els.forEach((el, i) => {
      expect(el.textContent).toBe(texts[i]);
      expect(el.classList.contains('settled')).toBe(true);
    });
  });
});
