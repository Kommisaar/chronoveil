// 称号 chip 编辑器（2026-09-15 chip 形态定稿）：点「添加称号」出现编辑态
// chip（内嵌输入框），Enter / 失焦确认写回，Esc 取消，空文本确认即移除
// （添加后不填字 = 没加）；已有 chip 点文本进入编辑、× 删除。受控组件用
// 带状态包装器驱动，断言回调序列与 chip 上屏文本。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../i18n';
import { TitlesChips } from './TitlesChips';

function renderUi(node: ReactNode) {
  return render(<FluentProvider theme={webLightTheme}>{node}</FluentProvider>);
}

/** 受控包装器：持有 titles 状态并回传，模拟父级表单接线。 */
function Harness(props: { initial: string[]; onTitlesChange?: (value: string[]) => void }) {
  const [titles, setTitles] = useState(props.initial);
  return (
    <TitlesChips
      titles={titles}
      onTitlesChange={(v) => {
        props.onTitlesChange?.(v);
        setTitles(v);
      }}
    />
  );
}

/** 添加一枚 chip 并以给定文本确认（空串 = 不填直接确认）。 */
function addChip(text: string): void {
  fireEvent.click(screen.getByRole('button', { name: '添加称号' }));
  const input = screen.getByPlaceholderText('如：布拉维坎的屠夫');
  if (text !== '') {
    fireEvent.change(input, { target: { value: text } });
  }
  fireEvent.keyDown(input, { key: 'Enter' });
}

afterEach(cleanup);

describe('TitlesChips（称号 chip 编辑器）', () => {
  it('初始称号渲染为 chip；点添加出现编辑框，Enter 确认后 chip 上屏', () => {
    const onTitlesChange = vi.fn();
    renderUi(<Harness initial={['布拉维坎的屠夫']} onTitlesChange={onTitlesChange} />);
    expect(screen.getByText('布拉维坎的屠夫')).toBeTruthy();
    expect(screen.queryByPlaceholderText('如：布拉维坎的屠夫')).toBeNull();

    addChip('利维亚的战士');
    expect(onTitlesChange).toHaveBeenLastCalledWith(['布拉维坎的屠夫', '利维亚的战士']);
    expect(screen.getByText('利维亚的战士')).toBeTruthy();
    // 确认后编辑框消失，chip 是唯一形态
    expect(screen.queryByPlaceholderText('如：布拉维坎的屠夫')).toBeNull();
  });

  it('添加后不填字直接确认（Enter / 失焦）：不留空 chip', () => {
    const onTitlesChange = vi.fn();
    renderUi(<Harness initial={['甲']} onTitlesChange={onTitlesChange} />);
    addChip('');
    expect(onTitlesChange).toHaveBeenLastCalledWith(['甲']);
    expect(screen.queryByPlaceholderText('如：布拉维坎的屠夫')).toBeNull();
  });

  it('Esc 取消：新加未命名的 chip 被移除，已有 chip 还原原文', () => {
    const onTitlesChange = vi.fn();
    renderUi(<Harness initial={['甲']} onTitlesChange={onTitlesChange} />);
    // 新加 Esc：移除
    fireEvent.click(screen.getByRole('button', { name: '添加称号' }));
    fireEvent.keyDown(screen.getByPlaceholderText('如：布拉维坎的屠夫'), { key: 'Escape' });
    expect(onTitlesChange).toHaveBeenLastCalledWith(['甲']);
    // 已有 chip 点文本进入编辑，Esc 还原
    fireEvent.click(screen.getByText('甲'));
    const input = screen.getByPlaceholderText('如：布拉维坎的屠夫');
    fireEvent.change(input, { target: { value: '错字' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onTitlesChange).toHaveBeenLastCalledWith(['甲']);
    expect(screen.getByText('甲')).toBeTruthy();
  });

  it('点已有 chip 文本进入编辑，Enter 写回 trim 后文本；× 删除 chip', () => {
    const onTitlesChange = vi.fn();
    renderUi(
      <Harness initial={[' 布拉维坎的屠夫 ', '利维亚的战士']} onTitlesChange={onTitlesChange} />,
    );
    // RTL 文本匹配做空白规范化：带空格的原样串仍按 trim 后文本命中
    fireEvent.click(screen.getByText('布拉维坎的屠夫'));
    const input = screen.getByPlaceholderText('如：布拉维坎的屠夫') as HTMLInputElement;
    expect(input.value).toBe(' 布拉维坎的屠夫 ');
    fireEvent.change(input, { target: { value: ' 猎魔人 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onTitlesChange).toHaveBeenLastCalledWith(['猎魔人', '利维亚的战士']);

    // 删除第 0 枚（× 按钮 aria-label = 删除称号）：猎魔人消失、另一枚保留
    const dismissButtons = screen.getAllByRole('button', { name: '删除称号' });
    expect(dismissButtons).toHaveLength(2);
    fireEvent.click(dismissButtons[0]!);
    expect(onTitlesChange).toHaveBeenLastCalledWith(['利维亚的战士']);
    expect(screen.queryByText('猎魔人')).toBeNull();
    expect(screen.getByText('利维亚的战士')).toBeTruthy();
  });

  it('失焦即确认（act 包裹 blur：回调触发父级渲染）', () => {
    const onTitlesChange = vi.fn();
    renderUi(<Harness initial={['甲']} onTitlesChange={onTitlesChange} />);
    fireEvent.click(screen.getByRole('button', { name: '添加称号' }));
    const input = screen.getByPlaceholderText('如：布拉维坎的屠夫');
    fireEvent.change(input, { target: { value: '乙' } });
    act(() => {
      fireEvent.blur(input);
    });
    expect(onTitlesChange).toHaveBeenLastCalledWith(['甲', '乙']);
  });
});
