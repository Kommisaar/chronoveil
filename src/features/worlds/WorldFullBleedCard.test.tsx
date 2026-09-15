// WorldFullBleedCard 单元测试（stage 档，Task-05）。组件直挂（不经
// WorldsView）：register/revealDelay 传桩——本文件测卡面内容与交互契约，
// 入场接线与 stage 档网格由 WorldsView.test 覆盖。
// shared 组 isolate:false 无自动 cleanup，文件自行 afterEach(cleanup)。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorldSummary } from '../../api/types';
import '../../i18n';
import { WorldFullBleedCard } from './WorldFullBleedCard';

// 种子对齐 mock data.ts 的 SEED_WORLDS：雾灯航线（七曜和历 + 世界观示范）
const MIST: WorldSummary = {
  id: 2,
  name: '雾灯航线',
  worldbook: '永夜的海上城市，雾从海面漫上甲板。灯船按七曜轮值巡线，灯光的明灭节奏是水手间通行的暗语。',
  calendar: { name: '七曜和历', months: [], daysPerMonth: 30, dayNames: [], festivals: {} },
  updatedAt: 100,
};

// 空 worldbook + null 历法的对照卡（空白舞台形）
const BLANK: WorldSummary = { id: 1, name: '空白舞台', worldbook: '', calendar: null, updatedAt: 100 };

const register = vi.fn(() => () => {});

function renderCard(world: WorldSummary, onOpen = vi.fn()) {
  render(
    <FluentProvider theme={webLightTheme}>
      <WorldFullBleedCard
        world={world}
        index={0}
        revealDelay={0}
        register={register}
        onOpen={onOpen}
      />
    </FluentProvider>,
  );
}

afterEach(cleanup);

it('全部常显内容：世界名 / 历法徽章 / 世界观摘录（excerptOf 64 字档全文）', () => {
  renderCard(MIST);
  expect(screen.getByText('雾灯航线')).toBeTruthy();
  // 历法徽章 pill：带历法显历法名
  expect(screen.getByText('七曜和历')).toBeTruthy();
  // 种子 44 字 ≤ 64，摘录即全文无省略号
  expect(
    screen.getByText('永夜的海上城市，雾从海面漫上甲板。灯船按七曜轮值巡线，灯光的明灭节奏是水手间通行的暗语。'),
  ).toBeTruthy();
  // 更新日期（updatedAt=100 → 1970-01-01，本地时区）
  expect(screen.getByText(new Date(100).toLocaleDateString())).toBeTruthy();
});

it('空 worldbook 渲染「还没有世界观」占位；null 历法徽章显「默认数字历」', () => {
  renderCard(BLANK);
  expect(screen.getByText('空白舞台')).toBeTruthy();
  expect(screen.getByText('还没有世界观')).toBeTruthy();
  expect(screen.getByText('默认数字历')).toBeTruthy();
});

it('点击进编辑（回调收 world）；FLIP 锚点与入场接线挂卡', () => {
  const onOpen = vi.fn();
  renderCard(MIST, onOpen);
  const card = screen.getByRole('button', { name: '雾灯航线' });
  expect(card.getAttribute('data-editor-trigger')).toBe('2');
  fireEvent.click(card);
  expect(onOpen).toHaveBeenCalledWith(MIST);
  expect(register).toHaveBeenCalledWith(0);
});
