// 会话清单分叉标识测试（时间线分叉，Task-44）：清单项 meta 行为分叉会话出
// 「⑂ 源会话名」前缀（源经清单解析显示名）；源不在清单（软删 / 缺席）回退
// 「⑂ 源会话 #id」；非分叉会话不出标识。清单唯一数据源在 ui store（TASK-007），
// 挂载重拉与选中路径照常（本文件只断言标识渲染）。
// 另含 C3 删除钮 Tooltip 迁移断言（用本文件的现有清单数据：aria-label 带
// 会话名，tooltip 用 description 关系不覆盖可访问名）。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../../api/types';
import '../../i18n';
import { useUiStore } from '../../stores/ui';
import { Sidebar } from './Sidebar';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  listCharacters: vi.fn(),
  listSessions: vi.fn(),
}));

// Sidebar 消费的 api 面只有三个函数；forkSession 等由调用方（ledgerPanel）负责
vi.mock('../../api/commands', () => ({
  createSession: mocks.createSession,
  deleteSession: mocks.deleteSession,
  listCharacters: mocks.listCharacters,
  listSessions: mocks.listSessions,
}));

vi.mock('../../api/events', () => ({
  subscribeStream: vi.fn(() => () => {}),
  subscribeTraces: vi.fn(() => () => {}),
}));

const PLAIN: SessionSummary = {
  id: 1,
  title: '雨夜来电',
  updatedAt: Date.now(),
  instances: [
    { id: 1, name: '旅人', isUser: true, characterId: 1, renderStyle: 'type' },
  ],
  forkedFromSessionId: null,
  forkAnchorSceneIdx: null,
};

const FORKED: SessionSummary = {
  id: 2,
  title: '雨夜来电（分叉）',
  updatedAt: Date.now(),
  instances: PLAIN.instances,
  forkedFromSessionId: 1,
  forkAnchorSceneIdx: 2,
};

const FORKED_FROM_MISSING: SessionSummary = {
  id: 3,
  title: '断了源的分叉',
  updatedAt: Date.now(),
  instances: PLAIN.instances,
  forkedFromSessionId: 99,
  forkAnchorSceneIdx: 0,
};

function renderSidebar() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <Sidebar />
    </FluentProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listCharacters.mockResolvedValue([]);
  mocks.listSessions.mockResolvedValue([PLAIN, FORKED, FORKED_FROM_MISSING]);
  useUiStore.setState({
    activeSessionId: 1,
    sessions: [PLAIN, FORKED, FORKED_FROM_MISSING],
    sessionsLoaded: true,
  });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ activeSessionId: null, sessions: [], sessionsLoaded: false });
});

it('分叉会话出「⑂ 源会话名」标识（源在清单时显示源标题）；非分叉会话无标识', () => {
  const { container } = renderSidebar();
  // 源（id 1）在清单 → 标识显示源标题；恰一处（源条目本身与非分叉判定都不带 ⑂）
  expect(screen.getAllByText(/⑂ 雨夜来电/)).toHaveLength(1);
  expect(container.textContent ?? '').toContain('雨夜来电（分叉）');
});

it('源会话不在清单（软删 / 缺席）→ 回退「⑂ 源会话 #id」；标识只出现在分叉条目的 meta 行', () => {
  const { container } = renderSidebar();
  expect(screen.getByText(/⑂ 源会话 #99/)).toBeTruthy();
  // 全清单恰好两处分叉标识（分叉条目 2 + 断源条目 3），源条目（id 1）不带
  expect((container.textContent ?? '').match(/⑂/g)).toHaveLength(2);
});

it('C3：删除钮提示迁移 Fluent Tooltip——description 关系接线，可访问名仍带会话名', () => {
  renderSidebar();
  const deleteBtn = screen.getByRole('button', { name: '删除会话：雨夜来电' });
  expect(deleteBtn.getAttribute('title')).toBeNull();
  // 替代验证说明：v9 Tooltip 的 content 在 jsdom 中常驻 DOM，显示/隐藏由真实
  // 浏览器承担；此处断言接线与语义——description 关系（aria-describedby）不
  // 覆盖可访问名，tooltip 只承载原 title 的短文案；键盘 focus 出提示的行为
  // 由 Fluent Tooltip 保证
  const describedBy = deleteBtn.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  const tip = document.getElementById(describedBy ?? '');
  expect(tip?.getAttribute('role')).toBe('tooltip');
  expect(tip?.textContent).toBe('删除会话');
  expect(screen.getByRole('button', { name: '删除会话：雨夜来电' })).toBeTruthy();
});
