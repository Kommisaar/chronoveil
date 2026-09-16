// WorldsView 交互测试（0017 世界卡特性）。
// 纯浏览器环境下 api 层走 mock 后端（src/api/mock），其模块级种子数据在
// 本文件内跨用例共享——用例按「只读 → 新建 → 编辑 → 软删」顺序排列，破坏性
// 操作放最后（ADR-010 双模式允许 UI 层直接对 mock 断言）。
// 世界列表异步加载：交互前一律先 findByText 等卡片上屏。
// 卡面 2026-09-16 定稿典藏形卡单一形态（对比期三档与切换器已裁撤，
// cardDirection 出 store），本文件只剩 gallery 档用例。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import '../../i18n';
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

it('渲染现有世界典藏形卡网格：名称 + 历法徽章 + 世界观摘录/空态占位', async () => {
  renderView();
  expect(await screen.findByText('空白舞台')).toBeTruthy();
  // null 历法卡的徽章显示「默认数字历」
  expect(screen.getAllByText('默认数字历').length).toBeGreaterThanOrEqual(1);
  // 带历法卡显示历法名（七曜和历，种子与 calendarPresets seven 预设一致）
  expect(await screen.findByText('七曜和历')).toBeTruthy();
  // 典藏形卡世界观摘录（gallery 档身份主角，excerptOf 64 字档）：雾灯航线
  // 种子 worldbook 44 字 ≤ 64，摘录即全文无省略号
  expect(
    screen.getByText('永夜的海上城市，雾从海面漫上甲板。灯船按七曜轮值巡线，灯光的明灭节奏是水手间通行的暗语。'),
  ).toBeTruthy();
  // 空 worldbook 卡（空白舞台）显示空态占位：卡面有正文区，占位是行动
  // 邀请（与角色卡「空则不渲染」的拍板差异，见 WorldGalleryCard 文件头）
  expect(screen.getByText('还没有世界观')).toBeTruthy();
});

// 创建流程「先编辑后落库」（2026-09-16 用户拍板，与角色页同构）：新建直接
// 开在空草稿上，保存前不落库不入列；放弃/关闭即弃稿；保存才创建进列表
//（回声荒原卡供后续「删除」用例作素材）。
it('新建 = 先编辑后落库：保存前不入列，放弃不出卡，保存进列表', async () => {
  renderView();
  await screen.findByText('空白舞台');
  // 「保存前不入列」判据基线：网格卡都挂 data-editor-trigger（对话框没有），
  // 开草稿前后计数不变 = 无卡落库（旧「先落库」流程会多出一张默认名卡）
  const triggersBefore = document.querySelectorAll('[data-editor-trigger]').length;

  fireEvent.click(screen.getByRole('button', { name: '新建世界' }));
  // 编辑器直接开在草稿上：标题「新建世界」，名称空（必填门槛生效）
  expect(
    await screen.findByRole('heading', { name: '新建世界' }, { timeout: 3000 }),
  ).toBeTruthy();
  expect(document.querySelectorAll('[data-editor-trigger]').length).toBe(triggersBefore);
  expect(inputOf('名称').value).toBe('');
  // 名称必填：空名时保存禁用
  expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);

  // 放弃：草稿丢弃不落库（无卡出现），编辑器关闭
  fireEvent.change(inputOf('名称'), { target: { value: '放弃世界' } });
  fireEvent.click(screen.getByRole('button', { name: '放弃' }));
  await waitFor(
    () => {
      expect(screen.queryByRole('heading', { name: '新建世界' })).toBeNull();
    },
    { timeout: 3000 },
  );
  expect(screen.queryByText('放弃世界')).toBeNull();

  // 再开草稿、填名保存：创建落库进列表（编辑器关闭）
  fireEvent.click(screen.getByRole('button', { name: '新建世界' }));
  expect(
    await screen.findByRole('heading', { name: '新建世界' }, { timeout: 3000 }),
  ).toBeTruthy();
  fireEvent.change(inputOf('名称'), { target: { value: '回声荒原' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByText('回声荒原', undefined, { timeout: 3000 })).toBeTruthy();
  await waitFor(
    () => {
      expect(screen.queryByRole('heading', { name: '新建世界' })).toBeNull();
    },
    { timeout: 3000 },
  );
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
