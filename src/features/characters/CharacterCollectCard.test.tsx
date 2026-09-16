// CharacterCollectCard 单元测试（collect 档，2026-09-16）。组件直挂（不经
// CharactersView）：register/revealDelay 传桩——本文件测卡面内容与交互契约，
// 入场接线（useRevealOnScroll）与 collect 档网格由 CharactersView.test 覆盖。
// shared 组 isolate:false 无自动 cleanup，文件自行 afterEach(cleanup)。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CharacterSummary } from '../../api/types';
import { TITLES_ROTATE_MS } from '../../components/motion';
import '../../i18n';
import { CharacterCollectCard } from './CharacterCollectCard';

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
  modelTopP: null,
  modelFrequencyPenalty: null,
  modelPresencePenalty: null,
  accentColor: null,
  animDurationMs: null,
  animRhythmMs: null,
  animPunctPause: null,
  updatedAt: 100,
  sessionCount: 3,
};

// 空称号 + 空人设的对照卡（苏鸢形）：身份两行整行不渲染（同海报卡拍板）
const SU: CharacterSummary = { ...LIN, id: 1, name: '苏鸢', titles: [], persona: '' };

const register = vi.fn(() => () => {});

function renderCard(character: CharacterSummary, onOpen = vi.fn()) {
  render(
    <FluentProvider theme={webLightTheme}>
      <CharacterCollectCard
        character={character}
        index={0}
        revealDelay={0}
        register={register}
        onOpen={onOpen}
      />
    </FluentProvider>,
  );
  return { onOpen };
}

afterEach(cleanup);

it('卡面常显承载名字/称号/人设摘录与元信息行（主题表面无揭示层，无 aria-hidden）', () => {
  renderCard(LIN);
  expect(screen.getByText('林深')).toBeTruthy();
  // 多称号轮换（见下用例）：初始显第一个
  expect(screen.getByText('「守夜人」')).toBeTruthy();
  // 称号内联名字同行（2026-09-16 拍板）：名字与称号外层（穿过渐变内层 span）
  // 是同一个 flex 行容器
  expect(screen.getByText('林深').parentElement).toBe(
    screen.getByText('「守夜人」').closest('div'),
  );
  // excerptOf 已剥 ** 加粗标记（48 字档全文无省略号）
  expect(screen.getByText('旧书店老板，雨天总在擦一盏灯。')).toBeTruthy();
  expect(screen.getByText('3 个会话')).toBeTruthy();
  // 常显内容不在 aria-hidden 子树内（读屏可达是正文区落主题表面的前提）
  const titles = screen.getByText('「守夜人」');
  expect(titles.closest('[aria-hidden="true"]')).toBeNull();
});

it('多称号轮换：激活项 opacity 1、其余 0，按 TITLES_ROTATE_MS 周期轮转并回绕', () => {
  vi.useFakeTimers();
  try {
    renderCard(LIN);
    // 交叉淡化布局：两个称号同框常驻 DOM，透明度表达激活位（换题即新旧
    // 同时过渡）
    const first = screen.getByText('「守夜人」');
    const second = screen.getByText('「旧书店主」');
    expect((first as HTMLElement).style.opacity).toBe('1');
    expect((second as HTMLElement).style.opacity).toBe('0');
    act(() => {
      vi.advanceTimersByTime(TITLES_ROTATE_MS);
    });
    expect((screen.getByText('「守夜人」') as HTMLElement).style.opacity).toBe('0');
    expect((screen.getByText('「旧书店主」') as HTMLElement).style.opacity).toBe('1');
    act(() => {
      vi.advanceTimersByTime(TITLES_ROTATE_MS);
    });
    // 回绕到首个
    expect((screen.getByText('「守夜人」') as HTMLElement).style.opacity).toBe('1');
  } finally {
    vi.useRealTimers();
  }
});

it('空称号 + 空人设：身份两行整行不渲染（留白比占位干净）', () => {
  renderCard(SU);
  expect(screen.getByText('苏鸢')).toBeTruthy();
  expect(screen.queryByText('「」')).toBeNull();
  expect(screen.queryByText('旧书店老板，雨天总在擦一盏灯。')).toBeNull();
});

it('入场接线：register 收到序号（卡片自证入场弹跳挂载）', () => {
  renderCard(LIN);
  screen.getByText('林深');
  expect(register).toHaveBeenCalledWith(0);
});

it('整卡点击与 Enter/Space 键盘路径均进编辑且恰好一次（回调收 character）', () => {
  const { onOpen } = renderCard(LIN);
  const card = screen.getByText('林深').closest('.fui-Card') as HTMLElement;
  fireEvent.click(card);
  expect(onOpen).toHaveBeenCalledTimes(1);
  // 键盘路径与点击等价（Enter / Space，照既有卡组件键盘用例形态）
  fireEvent.keyDown(card, { key: 'Enter' });
  expect(onOpen).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(card, { key: ' ' });
  expect(onOpen).toHaveBeenCalledTimes(3);
  expect(onOpen).toHaveBeenLastCalledWith(LIN);
});
