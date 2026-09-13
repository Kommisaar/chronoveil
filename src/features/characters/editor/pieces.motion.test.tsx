// pieces 动效的 reduced-motion 门控守卫（审计 M 批次补漏）：色块选中环
// 过渡（durationFast）与折叠段 chevron 旋转过渡（durationNormal）的
// transition 声明必须只存在于 prefers-reduced-motion: no-preference 媒体
// 块内——减弱动态用户加载到的规则集不含过渡，状态变化（悬停环/旋转）
// 瞬时呈现，不做补间。
//
// 替代验证说明（同 useCardLiftStyles.test.tsx 先例）：jsdom 无布局引擎，
// @media 不会真求值，媒体门控是静态 CSS 不是运行时分支——因此断言 Griffel
// 注入的真实样式表结构。与先例的差异：useFieldStyles 是多类共享钩子，
// 为避免与 FluentProvider 自身注入的组件样式撞值，按 fixture 元素实际
// 持有的 Griffel 类 token 圈定规则（类 hash 唯一对应本钩子的声明）。
import { FluentProvider, mergeClasses, webLightTheme } from '@fluentui/react-components';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useFieldStyles } from './pieces';

function Fixture() {
  const styles = useFieldStyles();
  return (
    <FluentProvider theme={webLightTheme}>
      {/* 色块选中态 = 常态 + 选中环两段声明合并，与 AccentColorPicker 消费一致 */}
      <span
        className={mergeClasses(styles.paletteSwatch, styles.paletteSwatchSelected)}
        data-testid="swatch"
      />
      {/* 展开态 chevron = 过渡类 + rotate 类合并，与 OverrideSection 消费一致 */}
      <span
        className={mergeClasses(styles.chevron, styles.chevronOpen)}
        data-testid="chevron"
      />
    </FluentProvider>
  );
}

interface Collected {
  inside: CSSStyleRule[];
  outside: CSSStyleRule[];
}

/** 按 fixture 类 token 圈定样式表规则：no-preference 媒体块内/块外分桶。 */
function collectFixtureRules(className: string): Collected {
  const classTokens = className.split(/\s+/).filter(Boolean);
  const collected: Collected = { inside: [], outside: [] };
  const matches = (rule: CSSRule): boolean =>
    classTokens.some((token) => (rule as CSSStyleRule).selectorText?.includes(token));
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      const media = rule as CSSMediaRule;
      if (media.media && media.media.length > 0) {
        if (media.conditionText === '(prefers-reduced-motion: no-preference)') {
          for (const inner of Array.from(media.cssRules)) {
            if (matches(inner)) collected.inside.push(inner as CSSStyleRule);
          }
        }
      } else if (matches(rule)) {
        collected.outside.push(rule as CSSStyleRule);
      }
    }
  }
  return collected;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('pieces 动效 reduced-motion 门控', () => {
  it('色块选中环过渡只在 no-preference 媒体块内（reduce 下悬停环瞬时出现）', () => {
    render(<Fixture />);
    const swatch = document.querySelector('[data-testid="swatch"]')!;
    const { inside, outside } = collectFixtureRules(swatch.className);
    expect(
      inside.some((r) => (r.style.transitionProperty ?? '').includes('box-shadow')),
      '媒体块内应有 box-shadow 过渡声明',
    ).toBe(true);
    expect(
      inside.some((r) => (r.style.transitionDuration ?? '') !== ''),
      '媒体块内应有过渡时长声明',
    ).toBe(true);
    expect(
      outside.filter((r) => (r.style.transitionProperty ?? '').includes('box-shadow')),
      'no-preference 媒体块之外不得出现 box-shadow 过渡声明',
    ).toEqual([]);
  });

  it('chevron 旋转过渡只在 no-preference 媒体块内；rotate(90deg) 本身不门控（状态反馈保留）', () => {
    render(<Fixture />);
    const chevron = document.querySelector('[data-testid="chevron"]')!;
    const { inside, outside } = collectFixtureRules(chevron.className);
    expect(
      inside.some((r) => (r.style.transitionProperty ?? '').includes('transform')),
      '媒体块内应有 transform 过渡声明',
    ).toBe(true);
    expect(
      outside.filter((r) => (r.style.transitionProperty ?? '').includes('transform')),
      'no-preference 媒体块之外不得出现 transform 过渡声明',
    ).toEqual([]);
    // chevronOpen 的旋转是 aria-expanded 的可视冗余：不门控，reduce 下瞬时切换
    expect(
      outside.some((r) => (r.style.transform ?? '').includes('rotate(90deg)')),
      '块外应存在 rotate(90deg)（chevronOpen 不门控）',
    ).toBe(true);
  });
});
