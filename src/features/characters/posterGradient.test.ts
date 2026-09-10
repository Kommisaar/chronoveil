// 海报渐变派生纯函数单测（强调色派生回归防线）：合法 #RRGGBB 原色直出、
// 非法 accent 串按未设置回落 id 取模、None 跟随派生、小圆点用 id+1 邻位色对、
// rgba 叠加色非法输入落黑。全部为纯函数，不涉及 DOM。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTER_GRADIENT,
  POSTER_GRADIENTS,
  accentColorOf,
  dotGradientOf,
  gradientOf,
  gradientPairOf,
  posterGradientOf,
  withAlpha,
} from './posterGradient';

describe('gradientPairOf（按 id 取模的恒定色对）', () => {
  it('id 0 取首组靛紫；越界按调色板长度取模回绕', () => {
    expect(gradientPairOf(0)).toEqual(POSTER_GRADIENTS[0]);
    expect(gradientPairOf(6)).toEqual(POSTER_GRADIENTS[0]); // 6 % 6 = 0
    expect(gradientPairOf(7)).toEqual(POSTER_GRADIENTS[1]);
  });
  it('负 id 取绝对值再取模（同人不同处配色漂移不可接受，恒定映射）', () => {
    expect(gradientPairOf(-1)).toEqual(POSTER_GRADIENTS[1]);
    expect(gradientPairOf(-6)).toEqual(POSTER_GRADIENTS[0]);
  });
});

describe('gradientOf（css linear-gradient 串）', () => {
  it('固定 150deg 起止写法，两端取色对首尾', () => {
    expect(gradientOf(0)).toBe('linear-gradient(150deg, #332a6e 0%, #6b46b8 100%)');
  });
});

describe('posterGradientOf（显式强调色原色直出，2026-09-09 定稿）', () => {
  it('合法 #RRGGBB（含大写）双色 stop 同色直出，不走 id 取模', () => {
    expect(posterGradientOf({ id: 3, accentColor: '#ff00aa' })).toBe(
      'linear-gradient(150deg, #ff00aa 0%, #ff00aa 100%)',
    );
    expect(posterGradientOf({ id: 3, accentColor: '#FF00AA' })).toBe(
      'linear-gradient(150deg, #FF00AA 0%, #FF00AA 100%)',
    );
  });
  it('null 跟随海报：按 id 取模色对', () => {
    expect(posterGradientOf({ id: 2, accentColor: null })).toBe(gradientOf(2));
  });
  it('非法 accent 串一律按未设置处理（列无库级格式约束，前端收口）', () => {
    for (const bad of ['red', '#fff', '#ff00a', '#ff00aab', 'ff00aa', '']) {
      expect(posterGradientOf({ id: 2, accentColor: bad })).toBe(gradientOf(2));
    }
  });
});

describe('dotGradientOf（元信息小圆点）', () => {
  it('有强调色：与海报同色直出', () => {
    expect(dotGradientOf({ id: 1, accentColor: '#123456' })).toBe(
      'linear-gradient(150deg, #123456 0%, #123456 100%)',
    );
  });
  it('无强调色：沿用隔壁色对（id + 1），与海报错开', () => {
    expect(dotGradientOf({ id: 1, accentColor: null })).toBe(gradientOf(2));
    // 回绕：id 5 的隔壁是 6 → 取模回首组
    expect(dotGradientOf({ id: 5, accentColor: null })).toBe(gradientOf(6));
  });
  it('非法 accent 串按未设置处理', () => {
    expect(dotGradientOf({ id: 1, accentColor: '#12g456' })).toBe(gradientOf(2));
  });
});

describe('accentColorOf（界面着色基础色）', () => {
  it('显式配置优先原样返回', () => {
    expect(accentColorOf({ id: 4, accentColor: '#abcdef' })).toBe('#abcdef');
  });
  it('null / 非法串取海报渐变亮端（色对第二色）', () => {
    expect(accentColorOf({ id: 0, accentColor: null })).toBe('#6b46b8');
    expect(accentColorOf({ id: 0, accentColor: 'nope' })).toBe('#6b46b8');
    expect(accentColorOf({ id: 1, accentColor: null })).toBe(gradientPairOf(1)[1]);
  });
});

describe('withAlpha（#RRGGBB → rgba 叠加色）', () => {
  it('合法 hex 拆通道，透明度原样内插', () => {
    expect(withAlpha('#ff8000', 0.25)).toBe('rgba(255, 128, 0, 0.25)');
    expect(withAlpha('#FF8000', 1)).toBe('rgba(255, 128, 0, 1)');
  });
  it('非法输入落黑（r=g=b=0），不抛异常', () => {
    expect(withAlpha('#12345', 0.5)).toBe('rgba(0, 0, 0, 0.5)');
    expect(withAlpha('', 0)).toBe('rgba(0, 0, 0, 0)');
  });
});

describe('DEFAULT_POSTER_GRADIENT（新建角色尚无 id 的默认渐变）', () => {
  it('取调色板首组靛紫（gradientOf(0)）', () => {
    expect(DEFAULT_POSTER_GRADIENT).toBe(gradientOf(0));
  });
});
