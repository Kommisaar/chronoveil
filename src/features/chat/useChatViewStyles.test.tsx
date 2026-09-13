// useChatViewStyles 合成钩子守卫（审计 C2 / A2 聊天侧落点）：
// - ledgerToggle = useGhostIconButtonStyles('medium') + 浮置特例 mergeClasses——
//   jsdom 无布局引擎，getComputedStyle 拿不到 Griffel 产物，沿用
//   useGhostIconButtonStyles.test 的样式表扫描思路：渲染 fixture 后从元素类名
//   反查 Griffel 注入的真实样式规则，断言具体声明值（类名是内容寻址哈希，
//   断言注入的声明才是行为本身）；
// - composerCard 圆角必须来自页面级卡面档常量（surfaceSpec 两档规范，A2）；
// - reasoningEnter 思考收尾淡化（M4）：声明值走 motion.ts token，
//   动画声明只落在 no-preference 门控内（reduce 分支结构）。
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CROSSFADE_MS, DECELERATE_CURVE } from '../../components/motion';
import { SURFACE_RADIUS_PAGE_CARD } from '../../components/surfaceSpec';
import { useChatViewStyles } from './useChatViewStyles';

function Fixture() {
  const styles = useChatViewStyles();
  return (
    <div>
      <button type="button" className={styles.ledgerToggle} data-testid="toggle">
        <svg data-testid="icon" />
      </button>
      <div className={styles.composerCard} data-testid="composer" />
      <div className={styles.reasoningEnter} data-testid="reasoning" />
    </div>
  );
}

interface StyleBuckets {
  base: CSSStyleRule[];
  hover: CSSStyleRule[];
  focusVisible: CSSStyleRule[];
  svg: CSSStyleRule[];
}

/** 从元素类名反查文档样式表中的 Griffel 规则，按选择器形态分桶。 */
function collectElementRules(el: Element): StyleBuckets {
  const classes = el.className.split(/\s+/).filter(Boolean);
  const buckets: StyleBuckets = { base: [], hover: [], focusVisible: [], svg: [] };
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      const style = rule as CSSStyleRule;
      const sel = style.selectorText ?? '';
      const cls = classes.find((c) => sel.startsWith(`.${c}`));
      if (cls === undefined) continue;
      const suffix = sel.slice(cls.length + 1);
      // jsdom 序列化子选择器不带空格（.cls>svg）
      if (sel.includes('>svg')) buckets.svg.push(style);
      else if (suffix === ':hover') buckets.hover.push(style);
      else if (suffix === ':focus-visible') buckets.focusVisible.push(style);
      else if (suffix === '') buckets.base.push(style);
    }
  }
  return buckets;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ledgerToggle 幽灵图标钮合成（C2）', () => {
  it('medium 档外观由统一钩子供给：36px 容器 + 20px 图标 + 悬停提亮', () => {
    const { getByTestId } = render(<Fixture />);
    const { base, hover, svg } = collectElementRules(getByTestId('toggle'));
    expect(base.some((r) => r.style.width === '36px'), '容器宽应为 36px（medium 档）').toBe(true);
    expect(base.some((r) => r.style.height === '36px'), '容器高应为 36px（medium 档）').toBe(true);
    expect(svg.some((r) => r.style.width === '20px'), '图标应为 20px（与旧实现同规格）').toBe(true);
    expect(
      hover.some((r) => r.style.backgroundColor === 'var(--colorNeutralBackground1Hover)'),
      '悬停底色提亮一阶（与旧实现同值）',
    ).toBe(true);
    expect(
      hover.some((r) => r.style.color === 'var(--colorNeutralForeground1)'),
      '悬停前景升一阶（与旧实现同值）',
    ).toBe(true);
  });

  it('浮置特例在合并类中生效：绝对定位 + 不透明底（滚动内容不透出）', () => {
    const { getByTestId } = render(<Fixture />);
    const { base } = collectElementRules(getByTestId('toggle'));
    expect(base.some((r) => r.style.position === 'absolute'), '应保持绝对定位').toBe(true);
    expect(
      base.some((r) => r.style.backgroundColor === 'var(--colorNeutralBackground1)'),
      '本地特例应把透明底覆写为不透明底',
    ).toBe(true);
  });

  it('键盘焦点环随统一钩子获得（:focus-visible 内嵌环，旧实现没有）', () => {
    const { getByTestId } = render(<Fixture />);
    const { focusVisible } = collectElementRules(getByTestId('toggle'));
    expect(
      focusVisible.some((r) => (r.style.boxShadow ?? '').includes('var(--colorStrokeFocus2)')),
      '应有 Fluent 内嵌焦点环',
    ).toBe(true);
  });
});

describe('composerCard 圆角规格（A2）', () => {
  it('页面级卡面 16px 来自 surfaceSpec 常量（Griffel 展开为四角长手）', () => {
    const { getByTestId } = render(<Fixture />);
    const { base } = collectElementRules(getByTestId('composer'));
    // Griffel 把 borderRadius 展开为四角长手规则；断言任一角携带常量值即可钉住
    // 「composerCard 消费 SURFACE_RADIUS_PAGE_CARD」这一事实
    const radiusText = base
      .map((r) => r.cssText)
      .filter((t) => t.includes('radius'))
      .join('');
    expect(radiusText).toContain(SURFACE_RADIUS_PAGE_CARD);
  });
});

describe('reasoningEnter 思考收尾淡化（M4）', () => {
  /** 反查元素类名命中的全部 Griffel 规则，附所在 @media 条件（null = 无门控）。
      集合扫描版 collectElementRules：Griffel 把 @media 内的原子类发成媒体规则，
      需下钻才能看到；Griffel 原子化后每条规则只带一个声明，属性值统一用
      getPropertyValue 取（不依赖驼峰访问器的属性支持面）。 */
  function collectRulesWithMedia(el: Element): Array<{ rule: CSSStyleRule; media: string | null }> {
    const classes = el.className.split(/\s+/).filter(Boolean);
    const hits: Array<{ rule: CSSStyleRule; media: string | null }> = [];
    const walk = (rules: CSSRuleList, media: string | null): void => {
      for (const entry of Array.from(rules)) {
        const mediaRule = entry as CSSMediaRule;
        if (mediaRule.conditionText !== undefined && mediaRule.cssRules !== undefined) {
          walk(mediaRule.cssRules, mediaRule.conditionText);
          continue;
        }
        const style = entry as CSSStyleRule;
        if (style.selectorText !== undefined && classes.some((c) => style.selectorText.startsWith(`.${c}`))) {
          hits.push({ rule: style, media });
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules, null);
    return hits;
  }

  it('动画声明走 token：reasoning-fade-in + CROSSFADE_MS + 减速进场曲线', () => {
    const { getByTestId } = render(<Fixture />);
    const hits = collectRulesWithMedia(getByTestId('reasoning'));
    // Griffel 原子化：每个声明独立成类，同一属性的值取任一命中规则即真值
    const valueOf = (prop: string): string => {
      const value = hits
        .map((h) => h.rule.style.getPropertyValue(prop))
        .find((v) => v !== '');
      expect(value, `类应携带 ${prop} 声明`).toBeTruthy();
      return value!;
    };
    expect(valueOf('animation-name')).toBe('reasoning-fade-in');
    expect(valueOf('animation-duration')).toBe(`${CROSSFADE_MS}ms`);
    expect(valueOf('animation-timing-function').replace(/\s+/g, '')).toBe(
      DECELERATE_CURVE.replace(/\s+/g, ''),
    );
  });

  it('reduce 分支结构：动画声明只在 no-preference 门控内，门控外零动画声明', () => {
    const { getByTestId } = render(<Fixture />);
    const hits = collectRulesWithMedia(getByTestId('reasoning'));
    // conditionText 按媒体查询原文序列化（特性查询带括号）
    const GATED = '(prefers-reduced-motion: no-preference)';
    for (const prop of ['animation-name', 'animation-duration', 'animation-timing-function']) {
      const carrying = hits.filter((h) => h.rule.style.getPropertyValue(prop) !== '');
      expect(carrying.length, `${prop} 应有声明`).toBeGreaterThan(0);
      expect(
        carrying.every((h) => h.media === GATED),
        `${prop} 应只存在于 no-preference 门控内（reduce 下直接切换无过渡）`,
      ).toBe(true);
    }
  });
});
