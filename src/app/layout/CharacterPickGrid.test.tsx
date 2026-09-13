// CharacterPickGrid 组件测试（A1 三态收编 + 选人卡基础契约）：characters=
// null 出 StateBlock loading 占位（此前返回 null 留白）、空库出提示行、
// 有数据出迷你海报卡（点选回调 / aria-pressed / 选中对勾 / 扮演位徽标）。
// 纯展示件直接挂载，不需要对话框壳。i18n 固定中文，断言 zh 文案。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CharacterSummary } from '../../api/types';
import '../../i18n';
import { CharacterPickGrid } from './CharacterPickGrid';

function renderUi(node: ReactNode) {
  return render(<FluentProvider theme={webLightTheme}>{node}</FluentProvider>);
}

const LIN: CharacterSummary = {
  id: 2,
  name: '林深',
  avatar: null,
  persona: '',
  gender: null,
  age: null,
  renderStyle: 'ink',
  modelConfig: null,
  accentColor: null,
  updatedAt: 100,
  sessionCount: 3,
};

const SUY: CharacterSummary = {
  ...LIN,
  id: 1,
  name: '苏鸢',
  updatedAt: 200,
};

afterEach(cleanup);

describe('CharacterPickGrid 三态（A1 收编）', () => {
  it('characters = null（加载中）：StateBlock loading 占位，不出网格', () => {
    renderUi(
      <CharacterPickGrid
        characters={null}
        selectedIds={[]}
        onToggle={vi.fn()}
        userBadgeId={null}
        disabled={false}
      />,
    );
    expect(screen.getByText('角色加载中…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '林深' })).toBeNull();
  });

  it('空角色库：一行提示', () => {
    renderUi(
      <CharacterPickGrid
        characters={[]}
        selectedIds={[]}
        onToggle={vi.fn()}
        userBadgeId={null}
        disabled={false}
      />,
    );
    expect(screen.getByText('还没有角色——先到角色页创建一个吧')).toBeTruthy();
  });
});

describe('CharacterPickGrid 选人卡契约', () => {
  it('点选回调与 aria-pressed 选中态；选中出对勾角标', () => {
    const onToggle = vi.fn();
    renderUi(
      <CharacterPickGrid
        characters={[SUY, LIN]}
        selectedIds={[2]}
        onToggle={onToggle}
        userBadgeId={null}
        disabled={false}
      />,
    );
    const lin = screen.getByRole('button', { name: '林深' });
    expect(lin.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('✓')).toBeTruthy();
    const suy = screen.getByRole('button', { name: '苏鸢' });
    expect(suy.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(suy);
    expect(onToggle).toHaveBeenCalledWith(1);
  });

  it('「你的扮演位」徽标只标在 userBadgeId 指向的卡', () => {
    renderUi(
      <CharacterPickGrid
        characters={[SUY, LIN]}
        selectedIds={[]}
        onToggle={vi.fn()}
        userBadgeId={1}
        disabled={false}
      />,
    );
    expect(screen.getByText('你的扮演位')).toBeTruthy();
  });

  it('disabled：卡片禁点', () => {
    renderUi(
      <CharacterPickGrid
        characters={[LIN]}
        selectedIds={[]}
        onToggle={vi.fn()}
        userBadgeId={null}
        disabled
      />,
    );
    expect(
      (screen.getByRole('button', { name: '林深' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
