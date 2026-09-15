// WorldsView 交互测试（0017 世界卡特性）。
// 纯浏览器环境下 api 层走 mock 后端（src/api/mock），其模块级种子数据在
// 本文件内跨用例共享——用例按「只读 → 新建 → 编辑 → 软删」顺序排列，破坏性
// 操作放最后（ADR-010 双模式允许 UI 层直接对 mock 断言）。
// 世界列表异步加载：交互前一律先 findByText 等卡片上屏。
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

it('渲染现有世界卡网格：卡面出名称 + 历法摘要（null 卡显示「默认数字历」）', async () => {
  renderView();
  expect(await screen.findByText('空白舞台')).toBeTruthy();
  // null 历法卡的摘要行显示「默认数字历」
  expect(screen.getAllByText('默认数字历').length).toBeGreaterThanOrEqual(1);
  // 带历法卡显示历法名（七曜和历，种子与 calendarPresets seven 预设一致）
  expect(await screen.findByText('七曜和历')).toBeTruthy();
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
