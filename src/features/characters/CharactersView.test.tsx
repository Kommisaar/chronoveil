// CharactersView 交互测试（TASK-008 / UC-004 / FR-006）。
// 纯浏览器环境下 api 层走 mock 后端（src/api/mock），其模块级种子数据在
// 本文件内跨用例共享——用例按「只读 → 新建 → 编辑/预览 → 软删」顺序排列，
// 破坏性操作放最后（ADR-010 双模式允许 UI 层直接对 mock 断言）。
// 角色列表异步加载：交互前一律先 findByText 等卡片上屏。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { sessions } from '../../api/mock/data';
import '../../i18n';
import { CharactersView } from './CharactersView';

// 本文件渲染重（卡片网格 + 18 项下拉全量渲染），全量并行负载下 jsdom 单用例
// 常超 vitest 默认 5s——隔离跑稳定全绿，超时点都在渲染等待而非断言。
// 文件级放宽时间预算（20s），断言逻辑不变；根修（渲染分片/环境复用）留待
// 测试基建任务，移除条件：该任务落地后本配置可删。
vi.setConfig({ testTimeout: 20_000 });

function renderView() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <CharactersView />
    </FluentProvider>,
  );
}

function inputOf(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function textareaOf(label: string): HTMLTextAreaElement {
  return screen.getByLabelText(label) as HTMLTextAreaElement;
}

afterEach(cleanup);

it('渲染现有卡片网格，按 updated_at 倒序（UI-002）', async () => {
  renderView();
  const suy = await screen.findByText('苏鸢');
  const lin = await screen.findByText('林深');
  expect(
    suy.compareDocumentPosition(lin) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it('新建 = 先建卡再进编辑器：默认名卡立即入列，改名经自动保存落到该卡', async () => {
  renderView();
  await screen.findByText('苏鸢');

  fireEvent.click(screen.getByRole('button', { name: '新建角色' }));
  // 先建卡（异步）再进编辑器：编辑既有卡形态，标题「编辑角色」
  expect(
    await screen.findByRole('heading', { name: '编辑角色' }, { timeout: 3000 }),
  ).toBeTruthy();
  // 新卡已落库入列（网格卡 + 编辑器展示 ≥2 处同名）
  const newCard = await screen.findAllByText('新建角色', undefined, { timeout: 3000 });
  expect(newCard.length).toBeGreaterThanOrEqual(2);

  // 名称行展示态起步：进一次输入态（输入框预填默认名），改名 → 防抖后自动保存
  fireEvent.click(screen.getByRole('button', { name: '重命名' }));
  expect(inputOf('名称').value).toBe('新建角色');
  fireEvent.change(inputOf('名称'), { target: { value: '乌鸦' } });
  await waitFor(
    () => {
      expect(screen.getAllByText('乌鸦').length).toBeGreaterThanOrEqual(2);
    },
    { timeout: 3000 },
  );
});

it('编辑：点卡片载入全量字段（persona 预填依赖扩字段），render_style 下拉 18 项，「预览动画」经引擎播放所选风格（验收 2/3/4）', async () => {
  renderView();
  fireEvent.click(await screen.findByText('林深'));

  // persona 默认渲染展示：预览容器由引擎直插 DOM（markdown 静态渲染）
  const personaPreview = document.querySelector('[data-persona-preview]');
  expect(personaPreview?.textContent).toContain('旧书店老板');

  // 点铅笔进统一编辑会话，人设切纯文本输入态：textarea 预填原文
  // （CharacterSummary 扩字段随列表返回，TASK-008 Rust 侧）；编辑态不渲染
  // 不着色，渲染只在展示态发生
  fireEvent.click(screen.getByRole('button', { name: '重命名' }));
  expect(textareaOf('人设').value).toContain('旧书店老板');
  expect(document.querySelector('[data-persona-syntax]')).toBeNull();

  // render_style 下拉消费 engine 的 ANIM_STYLES（18 选 1）——会话仍开着，
  // 不影响其他区块的交互
  fireEvent.click(screen.getByRole('combobox', { name: '动画样式' }));
  expect(screen.getAllByRole('option')).toHaveLength(18);

  // 「预览动画」：预览容器的 data-anim 切到该角色的风格（引擎公开 API）
  fireEvent.click(screen.getByRole('button', { name: '预览动画' }));
  const preview = document.querySelector('[data-anim]');
  expect(preview?.getAttribute('data-anim')).toBe('ink');
});

it('修改即保存：编辑中切换目标卡无丢弃确认，最后一拍经卸载补存落到原卡', async () => {
  renderView();
  fireEvent.click(await screen.findByText('林深'));
  // 名称默认展示态：点铅笔（重命名）进入行内输入态后再改值（防抖窗口内切换）
  fireEvent.click(screen.getByRole('button', { name: '重命名' }));
  fireEvent.change(inputOf('名称'), { target: { value: '林深（改）' } });

  // 直接切换到苏鸢：不再弹「放弃未保存的修改？」，切换放行
  fireEvent.click(screen.getByText('苏鸢'));
  expect(screen.queryByText('放弃未保存的修改？')).toBeNull();

  // 卸载补存：林深的最后一拍已落库（refresh 后网格出改名卡）
  expect(await screen.findByText('林深（改）', undefined, { timeout: 3000 })).toBeTruthy();

  // 复原（本文件 mock 种子跨用例共享，破坏性改动需还原供后续用例）
  fireEvent.click(screen.getByText('林深（改）'));
  fireEvent.click(screen.getByRole('button', { name: '重命名' }));
  fireEvent.change(inputOf('名称'), { target: { value: '林深' } });
  await waitFor(
    () => {
      expect(screen.getAllByText('林深').length).toBeGreaterThanOrEqual(2);
    },
    { timeout: 3000 },
  );
});

it('删除：软删 + 确认对话框（文案明示历史保留），卡片消失且历史会话保留（验收 5）', async () => {
  renderView();
  await screen.findByText('林深');
  const sessionsBefore = sessions.filter((s) => (s.instances ?? []).some((i) => i.characterId === 2)).length;
  expect(sessionsBefore).toBeGreaterThan(0);

  fireEvent.click(screen.getByText('林深'));
  fireEvent.click(screen.getByRole('button', { name: '删除角色' }));

  // 确认文案必须明示「历史会话与消息保留，角色从列表隐藏」
  expect(screen.getByText(/历史会话与消息保留，角色从列表隐藏/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '删除' }));

  await waitFor(() => {
    expect(screen.queryByText('林深')).toBeNull();
  });
  // 软删不级联（ADR-009 / OQ-002）：会话仍在，聊天侧仍可查看
  expect(sessions.filter((s) => (s.instances ?? []).some((i) => i.characterId === 2)).length).toBe(sessionsBefore);
});

// ---- 角色卡导入/导出（Task-04；浏览器 dev 走 mock：导出回路径串、导入建样例卡）----
// 用例放文件末尾：导入会向模块级 mock 种子追加新卡，影响后续断言。

it('导出：卡片菜单「导出角色卡」可触发，静默成功不弹错误（None 取消同静默）', async () => {
  renderView();
  await screen.findByText('苏鸢');

  const trigger = screen.getAllByRole('button', { name: '卡片菜单' })[0];
  expect(trigger).toBeTruthy();
  fireEvent.click(trigger!);
  fireEvent.click(await screen.findByRole('menuitem', { name: '导出角色卡' }));

  await waitFor(() => {
    expect(screen.queryByRole('menuitem', { name: '导出角色卡' })).toBeNull();
  });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('导入：工具栏「导入角色卡」经内置样例建新卡并刷新清单', async () => {
  renderView();
  await screen.findByText('苏鸢');

  fireEvent.click(screen.getByRole('button', { name: '导入角色卡' }));
  expect(await screen.findByText('织灯人·茉')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});
