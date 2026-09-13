// useGhostIconButtonStyles 档位与状态守卫。
// 验证方式：jsdom 无布局引擎，getComputedStyle 拿不到 Griffel 产物——沿用
// useCardLiftStyles.test 的样式表扫描思路：渲染 fixture 后从元素类名反查
// Griffel 注入的真实样式规则，按选择器形态（裸类 / :hover / :focus-visible /
// '> svg'）分桶，断言具体声明值。快照在这里不适用：类名是内容寻址哈希，
// 断言注入的声明才是行为本身。
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useGhostIconButtonStyles } from './useGhostIconButtonStyles';

function Fixture({ size, disabled }: { size: 'small' | 'medium'; disabled?: boolean }) {
  const s = useGhostIconButtonStyles(size, { disabled });
  return (
    <button type="button" className={s.root} data-testid="btn">
      <svg data-testid="icon" />
    </button>
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

describe('useGhostIconButtonStyles 尺寸档位', () => {
  it('medium 档：36px 容器 + 20px 图标（对齐 Fluent Button size medium 图标规格）', () => {
    const { getByTestId } = render(<Fixture size="medium" />);
    const { base, svg } = collectElementRules(getByTestId('btn'));
    // Griffel 原子化：每条规则单属性，逐属性断言
    expect(base.some((r) => r.style.width === '36px'), '容器宽应为 36px').toBe(true);
    expect(base.some((r) => r.style.height === '36px'), '容器高应为 36px').toBe(true);
    expect(svg.some((r) => r.style.width === '20px'), '图标宽应为 20px').toBe(true);
    expect(svg.some((r) => r.style.height === '20px'), '图标高应为 20px').toBe(true);
    expect(svg.some((r) => r.style.fontSize === '20px'), '图标 fontSize 应为 20px').toBe(true);
  });

  it('small 档：28px 容器 + 16px 图标（对齐 Fluent Button size small 图标规格）', () => {
    const { getByTestId } = render(<Fixture size="small" />);
    const { base, svg } = collectElementRules(getByTestId('btn'));
    expect(base.some((r) => r.style.width === '28px'), '容器宽应为 28px').toBe(true);
    expect(base.some((r) => r.style.height === '28px'), '容器高应为 28px').toBe(true);
    expect(svg.some((r) => r.style.width === '16px'), '图标宽应为 16px').toBe(true);
    expect(svg.some((r) => r.style.height === '16px'), '图标高应为 16px').toBe(true);
    expect(svg.some((r) => r.style.fontSize === '16px'), '图标 fontSize 应为 16px').toBe(true);
  });
});

describe('useGhostIconButtonStyles 反馈状态', () => {
  it('悬停：底色提亮一阶 + 前景升一阶（设计基准 Sidebar iconBtn / ActivityBar 条目）', () => {
    const { getByTestId } = render(<Fixture size="medium" />);
    const { hover } = collectElementRules(getByTestId('btn'));
    expect(
      hover.some((r) => r.style.backgroundColor === 'var(--colorNeutralBackground1Hover)'),
      '悬停底色应为 colorNeutralBackground1Hover',
    ).toBe(true);
    expect(
      hover.some((r) => r.style.color === 'var(--colorNeutralForeground1)'),
      '悬停前景应升为 colorNeutralForeground1',
    ).toBe(true);
  });

  it('键盘焦点：:focus-visible 规则存在且带内嵌焦点环（colorStrokeFocus2）', () => {
    const { getByTestId } = render(<Fixture size="medium" />);
    const { focusVisible } = collectElementRules(getByTestId('btn'));
    expect(focusVisible.length, '应有 :focus-visible 规则').toBeGreaterThan(0);
    expect(
      focusVisible.some((r) => (r.style.boxShadow ?? '').includes('var(--colorStrokeFocus2)')),
      '焦点环应为 Fluent colorStrokeFocus2 内嵌环',
    ).toBe(true);
  });

  it('禁用态：not-allowed 光标 + 禁用前景，悬停底色压回透明（禁用不装可点）', () => {
    const plain = render(<Fixture size="medium" />);
    const plainClass = plain.getByTestId('btn').className;
    plain.unmount(); // 避免两个同名 data-testid 共存干扰查询
    const { getByTestId } = render(<Fixture size="medium" disabled />);
    const el = getByTestId('btn');
    const { base, hover } = collectElementRules(el);
    // 禁用 fixture 的合并类与普通 fixture 不同（disabled 槽位类经 mergeClasses 生效）
    expect(el.className, '禁用态应产出不同的合并类').not.toEqual(plainClass);
    expect(
      base.some((r) => r.style.cursor === 'not-allowed'),
      '光标应为 not-allowed（对齐 Fluent v9 Button 禁用处方）',
    ).toBe(true);
    expect(
      base.some((r) => r.style.color === 'var(--colorNeutralForegroundDisabled)'),
      '前景应降为禁用阶',
    ).toBe(true);
    expect(
      hover.some((r) => r.style.backgroundColor === 'transparent'),
      '悬停底色应压回透明',
    ).toBe(true);
    expect(
      hover.some((r) => r.style.color === 'var(--colorNeutralForegroundDisabled)'),
      '悬停前景应保持禁用阶',
    ).toBe(true);
  });
});
