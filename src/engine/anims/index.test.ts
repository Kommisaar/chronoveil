import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANIM_STYLES,
  applyDuration,
  applyStyle,
  clampDuration,
  isAnimStyle,
  animStyleMeta,
  randomLanding,
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
});
