// 演出参数行组（AnimParamRows）：null = 跟随全局的行描述插值、滑杆拖动写卡、
// 「跟随全局」还原钮清空、标点微停三态下拉。i18n 固定中文，断言 zh 文案。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../i18n';
import { AnimParamRows } from './AnimParamRows';

function renderUi(node: ReactNode) {
  return render(<FluentProvider theme={webLightTheme}>{node}</FluentProvider>);
}

const DEFAULTS = { durationMs: 450, msPerChar: 45, punctPause: true, renderStyle: 'type', temperature: 0.7, defaultProviderId: 'p1', defaultModelId: 'm1' };

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
  it('全部跟随全局：行描述展示全局当前值，滑条禁用', () => {
    renderRows();
    expect(screen.getByText('跟随全局 · 当前 450ms')).toBeTruthy();
    expect(screen.getByText('跟随全局 · 当前 45ms/字')).toBeTruthy();
    expect(screen.getByText('跟随全局 · 当前 开')).toBeTruthy();
    expect((screen.getByRole('slider', { name: '动效时长' }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('slider', { name: '打字节奏' }) as HTMLInputElement).disabled).toBe(
      true,
    );
  });

  it('自定义态拖动滑杆写卡；切回「跟随」清回 null', () => {
    const onDurationChange = vi.fn();
    renderRows({ durationMs: 450, onDurationChange });
    expect(
      (screen.getByRole('slider', { name: '动效时长' }) as HTMLInputElement).disabled,
    ).toBe(false);
    fireEvent.change(screen.getByRole('slider', { name: '动效时长' }), {
      target: { value: '600' }, // 域内值（min 150，Fluent 对域外值自行钳制）
    });
    expect(onDurationChange).toHaveBeenCalledWith(600);
    // 时长/节奏两行分段同名（跟随全局|自定义），须圈定所在 radiogroup
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: '动效时长' })).getByRole('radio', {
        name: '跟随全局',
      }),
    );
    expect(onDurationChange).toHaveBeenCalledWith(null);
  });

  it('跟随态切「自定义」：以当前展示值（全局基准）写卡解锁滑条', () => {
    const onDurationChange = vi.fn();
    const view = renderRows({ durationMs: null, onDurationChange });
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: '动效时长' })).getByRole('radio', {
        name: '自定义',
      }),
    );
    expect(onDurationChange).toHaveBeenCalledWith(450);
    // 受控 rerender 后滑条解锁
    view.rerender(
      <FluentProvider theme={webLightTheme}>
        <AnimParamRows
          durationMs={450}
          rhythmMs={null}
          punctPause={null}
          defaults={DEFAULTS}
          onDurationChange={vi.fn()}
          onRhythmChange={vi.fn()}
          onPunctChange={vi.fn()}
        />
      </FluentProvider>,
    );
    expect(
      (screen.getByRole('slider', { name: '动效时长' }) as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it('标点微停三态分段选择：跟随全局 / 开 / 关，选关写卡 false', () => {
    const onPunctChange = vi.fn();
    renderRows({ punctPause: null, onPunctChange });
    // 2026-09-14 换 SegmentedControl：radiogroup + radio 语义；时长/节奏行
    // 也有「跟随全局」段，须圈定标点微停的 radiogroup
    const group = within(screen.getByRole('radiogroup', { name: '标点微停' }));
    expect(group.getByRole('radio', { name: '跟随全局' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(group.getByRole('radio', { name: '关' }));
    expect(onPunctChange).toHaveBeenCalledWith(false);
  });

  it('行描述始终显示：覆写态前缀改「自定义」，跟随态回「跟随全局」（无结构跳动）', () => {
    const view = renderRows({ punctPause: false, durationMs: 600 });
    expect(screen.getByText('自定义 · 当前 关')).toBeTruthy();
    expect(screen.getByText('自定义 · 当前 600ms')).toBeTruthy();
    // 受控往返：清回 null 后描述回「跟随全局」前缀
    view.rerender(
      <FluentProvider theme={webLightTheme}>
        <AnimParamRows
          durationMs={null}
          rhythmMs={null}
          punctPause={null}
          defaults={DEFAULTS}
          onDurationChange={vi.fn()}
          onRhythmChange={vi.fn()}
          onPunctChange={vi.fn()}
        />
      </FluentProvider>,
    );
    expect(screen.getByText('跟随全局 · 当前 450ms')).toBeTruthy();
    expect(screen.getByText('跟随全局 · 当前 开')).toBeTruthy();
  });
});
