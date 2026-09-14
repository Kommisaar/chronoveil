// DropdownPushButton（qfluentwidgets DropDownPushButton/RoundMenu 复刻件）
// 单测：开合交互、选择上抛、退场定时卸载与 maxVisibleItems 契约。
// 落位翻转分支依赖真实布局矩形（jsdom 全零矩形恒走「下方默认」路径，
// offsetHeight 恒 0 也量不出菜单高），浏览器行为由实测截图验证，不在此断言。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DropdownPushButton } from './DropdownPushButton';
import { DROPDOWN_POP_MS } from './motion';

const OPTIONS = [
  { value: 'a', label: '甲', detail: 'a' },
  { value: 'b', label: '乙', detail: 'b' },
  { value: 'c', label: '丙' },
];

function renderCombo(overrides: Partial<Parameters<typeof DropdownPushButton>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <FluentProvider theme={webLightTheme}>
      <DropdownPushButton
        options={OPTIONS}
        value="a"
        onChange={onChange}
        ariaLabel="测试下拉"
        maxVisibleItems={2}
        {...overrides}
      />
    </FluentProvider>,
  );
  return { onChange };
}

const trigger = (): HTMLElement => screen.getByRole('button', { name: '测试下拉' });

afterEach(cleanup);

describe('DropdownPushButton（RoundMenu 复刻件）', () => {
  it('触发钮显当前值 label（不显 detail）；展开后列全选项，选中行标 aria-selected', () => {
    renderCombo();
    expect(trigger().textContent).toBe('甲');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(trigger());
    expect(screen.getByRole('listbox', { name: '测试下拉' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '甲 · a' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('option', { name: '乙 · b' }).getAttribute('aria-selected')).toBe(
      'false',
    );
    expect(screen.getByRole('option', { name: '丙' })).toBeTruthy();
  });

  it('级联：触发钮组合「父 / 叶」上下文，二级菜单叶子显裸名，叶子命中上抛', () => {
    const { onChange } = renderCombo({
      options: [
        {
          value: 'p1',
          label: '服务甲',
          children: [
            { value: 'p1::m1', label: '模型一' },
            { value: 'p1::m2', label: '模型二' },
          ],
        },
      ],
      value: 'p1::m1',
      maxVisibleItems: 8,
    });
    // 触发钮处没有二级菜单的父行上下文，裸名无法指认 → 组合「父 / 叶」
    expect(trigger().textContent).toBe('服务甲 / 模型一');
    fireEvent.click(trigger());
    // 点父行展开二级飞出层（jsdom 全零矩形走默认落位，不影响行渲染）
    fireEvent.click(screen.getByRole('option', { name: '服务甲' }));
    const submenu = screen.getByRole('listbox', { name: '服务甲' });
    const leaves = [...submenu.querySelectorAll('button')].map((b) => b.textContent);
    expect(leaves).toEqual(['模型一', '模型二']);
    // 子菜单列表限高 = maxVisibleItems × 行高（jsdom 全零矩形恒走「下方默认
    // 且空间充裕」分支；翻转/选边由浏览器实测，见组件 openSubmenu 注）
    const subList = submenu.firstElementChild as HTMLElement;
    expect(subList.style.maxHeight).toBe('288px');
    expect(screen.getByRole('option', { name: '模型一' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('option', { name: '模型二' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('p1::m2');
  });

  it('选择即上抛 onChange，退场动画播完才卸载菜单（closing 态）', () => {
    vi.useFakeTimers();
    try {
      const { onChange } = renderCombo();
      fireEvent.click(trigger());
      fireEvent.click(screen.getByRole('option', { name: '乙 · b' }));
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith('b');
      // 退场期内菜单仍在 DOM（DROPDOWN_POP_MS 播完才离场）
      expect(screen.getByRole('listbox')).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(DROPDOWN_POP_MS);
      });
      expect(screen.queryByRole('listbox')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('maxVisibleItems 锁列表 max-height（3 行 × 36px = 108px，超出内滚）', () => {
    renderCombo({ maxVisibleItems: 3 });
    fireEvent.click(trigger());
    const list = screen.getByRole('listbox').firstElementChild as HTMLElement;
    expect(list.style.maxHeight).toBe('108px');
  });

  it('Esc 与点外部都收起，且 closing 期重复触发只记一次退场定时', () => {
    vi.useFakeTimers();
    try {
      renderCombo();
      fireEvent.click(trigger());
      fireEvent.keyDown(document, { key: 'Escape' });
      // 退场期内再点外部（已 closing，不重挂定时重置动画）
      fireEvent.pointerDown(document.body);
      act(() => {
        vi.advanceTimersByTime(DROPDOWN_POP_MS);
      });
      expect(screen.queryByRole('listbox')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('再点触发钮收起；closing 期再点触发钮立即重开（清退场定时）', () => {
    vi.useFakeTimers();
    try {
      renderCombo();
      fireEvent.click(trigger());
      fireEvent.click(trigger());
      act(() => {
        vi.advanceTimersByTime(DROPDOWN_POP_MS / 2);
      });
      // closing 过半时重开：菜单仍在且回到展开态
      fireEvent.click(trigger());
      expect(screen.getByRole('listbox')).toBeTruthy();
      expect(trigger().getAttribute('aria-expanded')).toBe('true');
      // 此前的退场定时已被清掉，不再卸载菜单
      act(() => {
        vi.advanceTimersByTime(DROPDOWN_POP_MS);
      });
      expect(screen.getByRole('listbox')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
