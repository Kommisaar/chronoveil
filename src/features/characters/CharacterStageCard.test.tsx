// CharacterStageCard 单元测试（stage 档，Task-05）。组件直挂（不经
// CharactersView）：register/revealDelay 传桩——本文件测卡面内容与交互契约，
// 入场接线（useRevealOnScroll）与 stage 档网格由 CharactersView.test 覆盖。
// shared 组 isolate:false 无自动 cleanup，文件自行 afterEach(cleanup)。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CharacterSummary } from '../../api/types';
import '../../i18n';
import { CharacterStageCard } from './CharacterStageCard';

// 种子对齐 mock data.ts 的林深：titles + markdown persona（excerptOf 剥 **
// 加粗标记后断言）
const LIN: CharacterSummary = {
  id: 2,
  name: '林深',
  avatar: null,
  gender: '男',
  age: '31',
  titles: ['守夜人', '旧书店主'],
  persona: '**旧书店老板**，雨天总在擦一盏灯。',
  renderStyle: 'ink',
  modelProviderId: null,
  modelName: null,
  modelTemperature: null,
  accentColor: null,
  animDurationMs: null,
  animRhythmMs: null,
  animPunctPause: null,
  updatedAt: 100,
  sessionCount: 3,
};

// 空称号 + 空人设的对照卡（苏鸢形）：揭示层两行均不渲染
const SU: CharacterSummary = { ...LIN, id: 1, name: '苏鸢', titles: [], persona: '' };

const register = vi.fn(() => () => {});

function renderCard(character: CharacterSummary, onOpen = vi.fn()) {
  render(
    <FluentProvider theme={webLightTheme}>
      <CharacterStageCard
        character={character}
        index={0}
        revealDelay={0}
        register={register}
        onOpen={onOpen}
      />
    </FluentProvider>,
  );
}

afterEach(cleanup);

it('静息态承载名字与会话数；称号与人设摘录常驻 DOM 且不设 aria-hidden（读屏可达是设计点）', () => {
  renderCard(LIN);
  expect(screen.getByText('林深')).toBeTruthy();
  expect(screen.getByText('3 个会话')).toBeTruthy();
  // 揭示层内容常驻 DOM：不依赖 hover/focus 状态即可直接查到（opacity 过渡
  // 只是视觉态，条件挂载会让读屏与测试同时失查——这正是断言的契约）
  expect(screen.getByText('「守夜人 · 旧书店主」')).toBeTruthy();
  // excerptOf 已剥 ** 加粗标记（64 字档全文无省略号）
  expect(screen.getByText('旧书店老板，雨天总在擦一盏灯。')).toBeTruthy();
  // 常驻可达 = 不在 aria-hidden 子树内（aria-hidden 会把整支子树摘出 a11y 树）
  const titles = screen.getByText('「守夜人 · 旧书店主」');
  expect(titles.closest('[aria-hidden="true"]')).toBeNull();
});

it('空称号 + 空人设：揭示层整层不渲染（无内容可揭示），名字与会话数仍承载', () => {
  renderCard(SU);
  expect(screen.getByText('苏鸢')).toBeTruthy();
  expect(screen.getByText('3 个会话')).toBeTruthy();
  expect(screen.queryByText('「」')).toBeNull();
  expect(screen.queryByText('旧书店老板，雨天总在擦一盏灯。')).toBeNull();
});

it('aria-label 含名字；点击与 Enter/Space 键盘路径均进编辑（回调收 character）', () => {
  const onOpen = vi.fn();
  renderCard(LIN, onOpen);
  const card = screen.getByRole('button', { name: '林深' });
  fireEvent.click(card);
  expect(onOpen).toHaveBeenCalledWith(LIN);
  // 键盘路径与点击等价（Enter / Space，参照既有卡组件键盘用例形态）
  fireEvent.keyDown(card, { key: 'Enter' });
  expect(onOpen).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(card, { key: ' ' });
  expect(onOpen).toHaveBeenCalledTimes(3);
  // 非激活键不触发
  fireEvent.keyDown(card, { key: 'Tab' });
  expect(onOpen).toHaveBeenCalledTimes(3);
  expect(onOpen).toHaveBeenLastCalledWith(LIN);
});

it('FLIP 锚点与入场接线：data-editor-trigger 按角色 id、register 收到序号', () => {
  renderCard(LIN);
  const card = screen.getByRole('button', { name: '林深' });
  expect(card.getAttribute('data-editor-trigger')).toBe('2');
  expect(register).toHaveBeenCalledWith(0);
});
