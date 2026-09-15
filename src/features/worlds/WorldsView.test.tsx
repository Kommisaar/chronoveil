// WorldsView 交互测试（0017 世界卡特性）。
// 纯浏览器环境下 api 层走 mock 后端（src/api/mock），其模块级种子数据在
// 本文件内跨用例共享——用例按「只读 → 新建 → 编辑 → 软删」顺序排列，破坏性
// 操作放最后（ADR-010 双模式允许 UI 层直接对 mock 断言）。
// 世界列表异步加载：交互前一律先 findByText 等卡片上屏。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import '../../i18n';
import { useUiStore } from '../../stores/ui';
import { WorldsView } from './WorldsView';

function renderView() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <WorldsView />
    </FluentProvider>,
  );
}

function inputOf(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

afterEach(cleanup);

it('渲染现有世界图版卡网格：名称 + 历法徽章 + 世界观摘录/空态占位', async () => {
  renderView();
  expect(await screen.findByText('空白舞台')).toBeTruthy();
  // null 历法卡的徽章显示「默认数字历」
  expect(screen.getAllByText('默认数字历').length).toBeGreaterThanOrEqual(1);
  // 带历法卡显示历法名（七曜和历，种子与 calendarPresets seven 预设一致）
  expect(await screen.findByText('七曜和历')).toBeTruthy();
  // 图版卡世界观摘录（gallery 档身份主角，excerptOf 64 字档）：雾灯航线
  // 种子 worldbook 44 字 ≤ 64，摘录即全文无省略号
  expect(
    screen.getByText('永夜的海上城市，雾从海面漫上甲板。灯船按七曜轮值巡线，灯光的明灭节奏是水手间通行的暗语。'),
  ).toBeTruthy();
  // 空 worldbook 卡（空白舞台）显示空态占位：图版卡有正文区，占位是行动
  // 邀请（与海报卡「空则不渲染」的拍板差异，见 WorldPlateCard 文件头）
  expect(screen.getByText('还没有世界观')).toBeTruthy();
});

// 卡面风格切换器（三方向对比期基建）：radiogroup 语义（SegmentedControl 段为
// 原生 button，天然可键盘操作），点「名册」落全局档位（与角色页共用同一 store）。
it('工具栏卡面风格切换器：radiogroup 三选项，点「名册」落 useUiStore.cardDirection', async () => {
  renderView();
  await screen.findByText('空白舞台');

  const group = screen.getByRole('radiogroup', { name: '卡面风格' });
  const segments = [...group.querySelectorAll('[role="radio"]')];
  expect(segments).toHaveLength(3);

  try {
    fireEvent.click(segments.find((r) => r.textContent === '名册')!);
    expect(useUiStore.getState().cardDirection).toBe('ledger');
  } finally {
    // 还原共享 store 必须在 finally（Task-01 reviewer 转入）：shared 组
    // isolate:false，模块级 store 跨用例/跨文件驻留——断言失败时 'ledger'
    // 也会被复位，不泄漏进本文件后续用例与同 worker 的后续文件
    useUiStore.setState({ cardDirection: 'gallery' });
  }
});

// 名册档（Task-04）：切 ledger 后单列名册行上屏——世界名/历法徽章/世界观
// 摘录同行承载，点行进编辑；gallery 档由本文件其余用例默认覆盖（store 初值
// gallery，不受本用例影响——还原在 finally）。本用例只读（不改种子），排在
// 「编辑」用例改历法之前。
it('名册档：单列名册行承载世界名/历法徽章/世界观摘录，点行进编辑', async () => {
  useUiStore.setState({ cardDirection: 'ledger' });
  try {
    renderView();
    expect(await screen.findByText('雾灯航线')).toBeTruthy();
    // 历法徽章：带历法卡显历法名；null 历法卡显「默认数字历」
    expect(screen.getByText('七曜和历')).toBeTruthy();
    expect(screen.getByText('默认数字历')).toBeTruthy();
    // 世界观摘录（excerptOf 64 字档，种子 44 字全文无省略号）；空 worldbook
    // 卡（空白舞台）渲染空态占位（同图版卡拍板）
    expect(
      screen.getByText('永夜的海上城市，雾从海面漫上甲板。灯船按七曜轮值巡线，灯光的明灭节奏是水手间通行的暗语。'),
    ).toBeTruthy();
    expect(screen.getByText('还没有世界观')).toBeTruthy();
    // 点行（名字在行 button 内，点击冒泡）进编辑
    fireEvent.click(screen.getByText('雾灯航线'));
    expect(
      await screen.findByRole('heading', { name: '编辑世界' }, { timeout: 3000 }),
    ).toBeTruthy();
  } finally {
    // 还原共享 store 必须在 finally（口径同上一用例）：断言失败时 'ledger'
    // 也会被复位，不泄漏进本文件后续用例与同 worker 的后续文件
    useUiStore.setState({ cardDirection: 'gallery' });
  }
});

it('新建 = 先落库再进编辑器：默认名卡立即入列，改名经自动保存落到该卡', async () => {
  renderView();
  await screen.findByText('空白舞台');

  fireEvent.click(screen.getByRole('button', { name: '新建世界' }));
  expect(
    await screen.findByRole('heading', { name: '编辑世界' }, { timeout: 3000 }),
  ).toBeTruthy();
  // 新卡已落库入列（网格卡 + 编辑器 ≥2 处同名）
  const newCard = await screen.findAllByText('新建世界', undefined, { timeout: 3000 });
  expect(newCard.length).toBeGreaterThanOrEqual(2);

  // 名称输入预填默认名；改名 → 防抖后自动保存（编辑器无海报列，回声荒原
  // 上屏一处即网格卡文本）
  expect(inputOf('名称').value).toBe('新建世界');
  fireEvent.change(inputOf('名称'), { target: { value: '回声荒原' } });
  expect(await screen.findByText('回声荒原', undefined, { timeout: 3000 })).toBeTruthy();
});

it('编辑：点卡片载入全量字段——世界观预览渲染 + 历法五选回显卡值；改选历法落整份预设', async () => {
  renderView();
  fireEvent.click(await screen.findByText('雾灯航线'));

  // 世界观默认预览态渲染 markdown-lite（MarkdownPreviewBox 容器）
  const preview = document.querySelector('[data-markdown-preview]');
  expect(preview?.textContent).toContain('永夜的海上城市');

  // 历法回显卡值：种子雾灯航线 = 七曜和历预设
  const sevenRadio = screen.getByRole('radio', { name: '七曜和历' }) as HTMLInputElement;
  expect(sevenRadio.checked).toBe(true);
  expect(screen.getByText(/睦月·月曜日/)).toBeTruthy();

  // 切「默认数字历」→ 防抖自动保存 → 卡面摘要换「默认数字历」
  fireEvent.click(screen.getByRole('radio', { name: '默认数字历' }));
  await waitFor(
    () => {
      expect(screen.getAllByText('默认数字历').length).toBeGreaterThanOrEqual(2);
    },
    { timeout: 3000 },
  );
});

it('删除：软删 + 确认对话框（文案明示会话内快照不受影响），卡片从列表消失', async () => {
  renderView();
  await screen.findByText('回声荒原');

  fireEvent.click(screen.getByText('回声荒原'));
  fireEvent.click(screen.getByRole('button', { name: '删除世界' }));

  expect(screen.getByText(/已建会话内的世界快照不受影响/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '删除' }));

  await waitFor(() => {
    expect(screen.queryByText('回声荒原')).toBeNull();
  });
  // 其余种子卡不受累
  expect(await screen.findByText('雾灯航线')).toBeTruthy();
});
