// 演出参数行组（AnimParamRows）：null = 跟随全局的行描述插值、滑杆拖动写卡、
// 「跟随全局」还原钮清空、标点微停三态下拉。i18n 固定中文，断言 zh 文案。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../i18n';
import { AnimParamRows } from './AnimParamRows';

function renderUi(node: ReactNode) {
  return render(<FluentProvider theme={webLightTheme}>{node}</FluentProvider>);
}

const DEFAULTS = { durationMs: 450, msPerChar: 45, punctPause: true };

function renderRows(overrides: {
  durationMs?: number | null;
  rhythmMs?: number | null;
  punctPause?: boolean | null;
  onDurationChange?: (v: number | null) => void;
  onRhythmChange?: (v: number | null) => void;
  onPunctChange?: (v: boolean | null) => void;
} = {}) {
  return renderUi(
    <AnimParamRows
      durationMs={overrides.durationMs ?? null}
      rhythmMs={overrides.rhythmMs ?? null}
      punctPause={overrides.punctPause ?? null}
      defaults={DEFAULTS}
      onDurationChange={overrides.onDurationChange ?? vi.fn()}
      onRhythmChange={overrides.onRhythmChange ?? vi.fn()}
      onPunctChange={overrides.onPunctChange ?? vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe('AnimParamRows（演出参数行组）', () => {
  it('全部跟随全局：行描述展示全局当前值，无还原钮', () => {
    renderRows();
    expect(screen.getByText('跟随全局 · 当前 450ms')).toBeTruthy();
    expect(screen.getByText('跟随全局 · 当前 45ms/字')).toBeTruthy();
    expect(screen.getByText('跟随全局 · 当前 开')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '跟随全局' })).toBeNull();
  });

  it('拖动时长滑杆写卡：回调带滑杆值（覆写态出还原钮）', () => {
    const onDurationChange = vi.fn();
    renderRows({ durationMs: 450, onDurationChange });
    fireEvent.change(screen.getByRole('slider', { name: '动效时长' }), {
      target: { value: '600' }, // 域内值（min 150，Fluent 对域外值自行钳制）
    });
    expect(onDurationChange).toHaveBeenCalledWith(600);
    fireEvent.click(screen.getByRole('button', { name: '跟随全局' }));
    expect(onDurationChange).toHaveBeenCalledWith(null);
  });

  it('标点微停三态下拉：跟随全局 / 开 / 关，选开关写卡', () => {
    const onPunctChange = vi.fn();
    renderRows({ punctPause: null, onPunctChange });
    const combo = screen.getByRole('combobox', { name: '标点微停' });
    expect(combo.textContent).toContain('跟随全局');
    fireEvent.click(combo);
    fireEvent.click(screen.getByRole('option', { name: '关' }));
    expect(onPunctChange).toHaveBeenCalledWith(false);
  });
});
