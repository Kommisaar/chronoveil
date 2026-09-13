// useCardLiftStyles 悬停动效的 reduced-motion 门控守卫（2026-09-13 补漏，
// 此前是全仓唯一无 reduce 分支的 Griffel 动效类）。
// 替代验证说明：jsdom 无布局引擎，@media 查询不会真求值，matchMedia mock
// 影响不了 Griffel 的产物（媒体门控是静态 CSS 不是运行时分支）——因此
// 断言 Griffel 注入的真实样式表结构：悬停位移/阴影规则只存在于
// prefers-reduced-motion: no-preference 媒体块内、块外零出现。reduce
// 用户加载到的规则集里没有这条 :hover 位移，即「reduce 时无位移」。
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useCardLiftStyles } from './useCardLiftStyles';

function Fixture() {
  const styles = useCardLiftStyles();
  return <div className={styles.root} />;
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

const LIFT_TRANSFORM = 'translateY(-6px)';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useCardLiftStyles reduced-motion 门控', () => {
  it('悬停位移与阴影规则存在于 no-preference 媒体块内（正常用户保留浮起）', () => {
    render(<Fixture />);
    const { inNoPreference } = collectStyleRules();
    const hoverRules = inNoPreference.filter((r) => r.selectorText?.includes(':hover'));
    expect(
      hoverRules.some((r) => (r.style.transform ?? '').includes(LIFT_TRANSFORM)),
      '媒体块内应有悬停位移规则',
    ).toBe(true);
    expect(
      hoverRules.some((r) => (r.style.boxShadow ?? '') !== ''),
      '媒体块内应有悬停阴影规则',
    ).toBe(true);
  });

  it('媒体块外零位移规则（reduce 用户加载不到悬停位移 = 无位移）', () => {
    render(<Fixture />);
    const { outside } = collectStyleRules();
    const offenders = outside.filter((r) => (r.style.transform ?? '').includes(LIFT_TRANSFORM));
    expect(
      offenders.map((r) => r.selectorText),
      'no-preference 媒体块之外不得出现悬停位移规则',
    ).toEqual([]);
  });
});
