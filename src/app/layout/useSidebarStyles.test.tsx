// useSidebarStyles 宽度过渡的 reduced-motion 门控守卫（2026-09-13 补漏，
// 修法与 useCardLiftStyles.test 同源）。
// 替代验证说明：jsdom 无布局引擎，@media 查询不会真求值，matchMedia mock
// 影响不了 Griffel 的产物（媒体门控是静态 CSS 不是运行时分支）——因此
// 断言 Griffel 注入的真实样式表结构：侧栏宽度过渡规则只存在于
// prefers-reduced-motion: no-preference 媒体块内、块外零出现。reduce
// 用户加载到的规则集里没有这条过渡，即「reduce 时收起/展开瞬时完成」。
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useSidebarStyles } from './useSidebarStyles';

function Fixture() {
  const styles = useSidebarStyles();
  return <aside className={styles.root} />;
}

interface Collected {
  inNoPreference: CSSStyleRule[];
  outside: CSSStyleRule[];
}

/** 遍历文档全部样式表：no-preference 媒体块内的样式规则与块外规则分桶。 */
function collectStyleRules(): Collected {
  const result: Collected = { inNoPreference: [], outside: [] };
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      const media = rule as CSSMediaRule;
      if (media.media && media.media.length > 0) {
        if (media.conditionText === '(prefers-reduced-motion: no-preference)') {
          for (const inner of Array.from(media.cssRules)) {
            result.inNoPreference.push(inner as CSSStyleRule);
          }
        }
      } else {
        result.outside.push(rule as CSSStyleRule);
      }
    }
  }
  return result;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useSidebarStyles 宽度过渡 reduced-motion 门控', () => {
  it('width 过渡规则存在于 no-preference 媒体块内（正常用户保留收展动画）', () => {
    render(<Fixture />);
    const { inNoPreference } = collectStyleRules();
    const transitionRules = inNoPreference.filter(
      (r) => r.style.transitionProperty === 'width',
    );
    expect(
      transitionRules.length,
      '媒体块内应有侧栏宽度过渡规则',
    ).toBeGreaterThan(0);
  });

  it('媒体块外零 width 过渡规则（reduce 用户加载不到 = 收展瞬时完成）', () => {
    render(<Fixture />);
    const { outside } = collectStyleRules();
    const offenders = outside.filter((r) => r.style.transitionProperty === 'width');
    expect(
      offenders.map((r) => r.selectorText),
      'no-preference 媒体块之外不得出现侧栏宽度过渡规则',
    ).toEqual([]);
  });
});
