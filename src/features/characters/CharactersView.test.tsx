// CharactersView 交互测试（TASK-008 / UC-004 / FR-006）。
// 纯浏览器环境下 api 层走 mock 后端（src/api/mock），其模块级种子数据在
// 本文件内跨用例共享——用例按「只读 → 新建 → 编辑/预览 → 软删」顺序排列，
// 破坏性操作放最后（ADR-010 双模式允许 UI 层直接对 mock 断言）。
// 角色列表异步加载：交互前一律先 findByText 等卡片上屏。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { sessions } from '../../api/mock/data';
import '../../i18n';
import { CharactersView } from './CharactersView';

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

it('新建：name 必填（空则禁用保存），保存后新卡入列（验收 2）', async () => {
  renderView();
  await screen.findByText('苏鸢');

  fireEvent.click(screen.getByRole('button', { name: '新建角色' }));
  expect(screen.getByRole('heading', { name: '新建角色' })).toBeTruthy();

  const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);

  fireEvent.change(inputOf('名称'), { target: { value: '乌鸦' } });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);

  // 退场动画契约：保存后对话框播放 210ms 退场才卸载（editorOpen 两段式
  // 关闭），并发全量跑时定时器可能被拖过默认 1s，放宽等待
  await waitFor(
    () => {
      expect(screen.queryByRole('heading', { name: '新建角色' })).toBeNull();
    },
    { timeout: 3000 },
  );
  expect(screen.getByText('乌鸦')).toBeTruthy();
});

it('编辑：点卡片载入全量字段（persona 预填依赖扩字段），render_style 下拉 18 项，「预览演出」经引擎播放所选风格（验收 2/3/4）', async () => {
  renderView();
  fireEvent.click(await screen.findByText('林深'));

  // persona 默认渲染展示：预览容器由引擎直插 DOM（markdown 静态渲染）
  const personaPreview = document.querySelector('[data-persona-preview]');
  expect(personaPreview?.textContent).toContain('旧书店老板');

  // 「编辑人设」切到纯文本输入态：textarea 预填原文（CharacterSummary 扩字段
  // 随列表返回，TASK-008 Rust 侧）；编辑态不渲染不着色，渲染只在展示态发生
  fireEvent.click(screen.getByRole('button', { name: '编辑人设' }));
  expect(textareaOf('人设（系统提示词）').value).toContain('旧书店老板');
  expect(document.querySelector('[data-persona-syntax]')).toBeNull();

  // render_style 下拉消费 engine 的 ANIM_STYLES（18 选 1）
  fireEvent.click(screen.getByRole('combobox', { name: '出场动画' }));
  expect(screen.getAllByRole('option')).toHaveLength(18);

  // 「预览演出」：预览容器的 data-anim 切到该角色的风格（引擎公开 API）
  fireEvent.click(screen.getByRole('button', { name: '预览演出' }));
  const preview = document.querySelector('[data-anim]');
  expect(preview?.getAttribute('data-anim')).toBe('ink');
});

it('未保存切换选中项提示丢弃确认：放弃后换载目标角色（验收 3）', async () => {
  renderView();
  fireEvent.click(await screen.findByText('林深'));
  // 名称默认展示态：点铅笔（重命名）进入行内输入态后再改值
  fireEvent.click(screen.getByRole('button', { name: '重命名' }));
  fireEvent.change(inputOf('名称'), { target: { value: '林深（改）' } });

  fireEvent.click(screen.getByText('苏鸢'));
  expect(screen.getByText('放弃未保存的修改？')).toBeTruthy();

  // 继续编辑：仍处输入态，行内输入保留未提交值
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  expect(inputOf('名称').value).toBe('林深（改）');

  // 放弃修改：切换到苏鸢（key 重挂、表单换绑初值，回到展示态）
  fireEvent.click(screen.getByText('苏鸢'));
  fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
  fireEvent.click(screen.getByRole('button', { name: '重命名' }));
  expect(inputOf('名称').value).toBe('苏鸢');
});

it('丢弃确认打开时按 Esc 取消：不执行切换，编辑器与未提交值保留（C1 收编修复）', async () => {
  renderView();
  fireEvent.click(await screen.findByText('林深'));
  fireEvent.click(screen.getByRole('button', { name: '重命名' }));
  fireEvent.change(inputOf('名称'), { target: { value: '林深（改）' } });

  fireEvent.click(screen.getByText('苏鸢'));
  expect(screen.getByText('放弃未保存的修改？')).toBeTruthy();

  // 收编前该对话框无 onOpenChange，Esc 无法取消；收编后 Esc = 取消（不授权
  // 切换）。Esc 派发到对话框正文节点，冒泡至 DialogSurface 的 keydown 处理。
  fireEvent.keyDown(screen.getByText('当前修改尚未保存，切换后将丢失。'), {
    key: 'Escape',
  });
  await waitFor(() => expect(screen.queryByText('放弃未保存的修改？')).toBeNull());
  // 取消语义：编辑器留在原角色，行内输入的未提交值原样保留
  expect(inputOf('名称').value).toBe('林深（改）');
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
