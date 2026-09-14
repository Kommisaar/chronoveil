// SegmentedControl（qfluentwidgets SegmentedWidget 复刻件）单测：radiogroup
// 语义、单选段互斥、点击上抛与指示条元素在位。指示条滑动依赖真实布局
// 矩形（jsdom 全零矩形下 moveIndicator 初次定位直接就位），动画行为由
// 浏览器实测验证，不在此断言（同 DropdownPushButton 复刻件口径）。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl';

const OPTIONS = [
  { value: '', label: '跟随' },
  { value: 'on', label: '开' },
  { value: 'off', label: '关' },
];

// 受控包装：点选后父态推进，可断言选中标记真实迁移
function StatefulCombo(props: { onChange: (v: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <FluentProvider theme={webLightTheme}>
      <SegmentedControl
        options={OPTIONS}
        value={value}
        onChange={(v) => {
          props.onChange(v);
          setValue(v);
        }}
        ariaLabel="测试分段"
      />
    </FluentProvider>
  );
}

afterEach(cleanup);

describe('SegmentedControl（分段选择器复刻件）', () => {
  it('radiogroup 语义；初始值段 aria-checked，其余未选，指示条元素在位', () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <SegmentedControl options={OPTIONS} value="on" onChange={vi.fn()} ariaLabel="测试分段" />
      </FluentProvider>,
    );
    expect(screen.getByRole('radiogroup', { name: '测试分段' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '开' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: '跟随' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('radio', { name: '关' }).getAttribute('aria-checked')).toBe('false');
    // 指示条元素挂在轨道内（滑动动画的载体）
    const group = screen.getByRole('radiogroup', { name: '测试分段' });
    expect(group.querySelector('[data-indicator-bar]')).toBeTruthy();
  });

  it('受控切换：点击段上抛 onChange，选中标记随受控值迁移（单选互斥）', () => {
    const onChange = vi.fn();
    render(<StatefulCombo onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: '关' }));
    expect(onChange).toHaveBeenCalledWith('off');
    expect(screen.getByRole('radio', { name: '关' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: '跟随' }).getAttribute('aria-checked')).toBe('false');
  });
});
