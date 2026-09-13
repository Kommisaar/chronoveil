// @vitest-environment node —— 纯逻辑测试无 DOM 依赖，跳过 jsdom 环境创建（测试提速）
// ui store 单测（Task-11）：refreshSessions 的错误态落值契约——失败落
// sessionsLoadError、进入重拉即清值、成功清值并落清单；rejection 契约不变
// （调用方仍须收敛）；静默路径失败落值但不向调用方冒泡（TASK-010 验收 4）。
// 并发竞态归属（Task-11 后半）：重拉按发起序号收敛，仅最新请求的响应可落
// store——陈旧成功不写清单、陈旧失败不落错误态（rejection 仍上抛）。
import { beforeEach, expect, it, vi } from 'vitest';
import { useUiStore } from './ui';

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
}));

vi.mock('../api/commands', () => ({
  listSessions: mocks.listSessions,
}));

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({
    sessions: [],
    sessionsLoaded: false,
    sessionsLoadError: null,
  });
});

it('Task-11：重拉失败落 sessionsLoadError（原始详情），sessionsLoaded 保持 false，rejection 契约不变', async () => {
  mocks.listSessions.mockRejectedValueOnce(new Error('db down'));
  // rejection 仍向调用方传播（ledgerPanel 删除/分叉失败的 catch 流程依赖它）
  await expect(useUiStore.getState().refreshSessions()).rejects.toThrow('db down');
  expect(useUiStore.getState().sessionsLoadError).toBe('db down');
  expect(useUiStore.getState().sessionsLoaded).toBe(false);
  expect(useUiStore.getState().sessions).toEqual([]);
});

it('Task-11：非 Error 的 rejection 以 String 收敛落值（describeError 同款）', async () => {
  mocks.listSessions.mockRejectedValueOnce('plain string failure');
  await expect(useUiStore.getState().refreshSessions()).rejects.toBe('plain string failure');
  expect(useUiStore.getState().sessionsLoadError).toBe('plain string failure');
});

it('Task-11：进入重拉即清错误（重试语义 = 错误态回加载态）', () => {
  useUiStore.setState({ sessionsLoadError: 'stale failure', sessionsLoaded: false });
  // 挂起中的重拉：deferred promise 固定「重拉中」时点（断言后才放行成功路径）
  let resolve!: (sessions: unknown[]) => void;
  mocks.listSessions.mockImplementation(() => new Promise((res) => (resolve = res)));
  const pending = useUiStore.getState().refreshSessions();
  expect(useUiStore.getState().sessionsLoadError).toBeNull();
  resolve([]);
  return pending;
});

it('Task-11：重拉成功清错误、落清单并标记已加载（自上次失败中恢复）', async () => {
  useUiStore.setState({ sessionsLoadError: 'stale failure', sessionsLoaded: false });
  mocks.listSessions.mockResolvedValue([
    { id: 2, updatedAt: 20 },
    { id: 1, updatedAt: 10 },
  ]);
  await useUiStore.getState().refreshSessions();
  expect(useUiStore.getState().sessionsLoadError).toBeNull();
  expect(useUiStore.getState().sessionsLoaded).toBe(true);
  expect(useUiStore.getState().sessions.map((s) => s.id)).toEqual([2, 1]);
});

it('Task-11：静默路径（refreshSessionsQuietly）失败落值但不冒泡给调用方', async () => {
  mocks.listSessions.mockRejectedValueOnce(new Error('db down'));
  // 返回 void 无 rejection 可接——「不冒泡」由无 unhandled rejection 落地
  // （vitest 将未处理 rejection 判为失败）；失败详情落值此处断言
  useUiStore.getState().refreshSessionsQuietly();
  await vi.waitFor(() => expect(useUiStore.getState().sessionsLoadError).toBe('db down'));
});

it('Task-11：并发重拉先发后至——陈旧成功响应不落 store（陈旧清单不得覆盖最新清单）', async () => {
  let resolveA!: (sessions: unknown[]) => void;
  let resolveB!: (sessions: unknown[]) => void;
  mocks.listSessions
    .mockImplementationOnce(() => new Promise((res) => (resolveA = res)))
    .mockImplementationOnce(() => new Promise((res) => (resolveB = res)));
  const stale = useUiStore.getState().refreshSessions();
  const fresh = useUiStore.getState().refreshSessions();
  // 后发请求先完成（模拟删除后的重拉已返回新清单），先发请求后至（模拟
  // 更早发起的在途响应才回来，含已删会话 id:1——修复前会被写回清单）
  resolveB([{ id: 3, updatedAt: 30 }]);
  await fresh;
  resolveA([{ id: 1, updatedAt: 10 }, { id: 2, updatedAt: 20 }]);
  await stale;
  expect(useUiStore.getState().sessions.map((s) => s.id)).toEqual([3]);
});

it('Task-11：陈旧失败不落错误态——旧失败不覆盖新成功，但 rejection 契约不变', async () => {
  let rejectA!: (e: unknown) => void;
  let resolveB!: (sessions: unknown[]) => void;
  mocks.listSessions
    .mockImplementationOnce(() => new Promise((_res, rej) => (rejectA = rej)))
    .mockImplementationOnce(() => new Promise((res) => (resolveB = res)));
  // rejection 契约断言用二值收敛：不吞（吞了断言会拿到 'resolved'）
  const staleOutcome = useUiStore
    .getState()
    .refreshSessions()
    .then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    );
  const fresh = useUiStore.getState().refreshSessions();
  resolveB([]);
  await fresh;
  expect(useUiStore.getState().sessionsLoaded).toBe(true);
  rejectA(new Error('stale failure'));
  expect(await staleOutcome).toBe('rejected'); // 仍上抛给调用方收敛
  expect(useUiStore.getState().sessionsLoadError).toBeNull(); // 但不落错误态
  expect(useUiStore.getState().sessions).toEqual([]); // 新成功的清单保持
});

it('Task-11：静默路径与显式重拉共用序号源——静默陈旧响应同样不落 store', async () => {
  let resolveQuiet!: (sessions: unknown[]) => void;
  let resolveFresh!: (sessions: unknown[]) => void;
  mocks.listSessions
    .mockImplementationOnce(() => new Promise((res) => (resolveQuiet = res)))
    .mockImplementationOnce(() => new Promise((res) => (resolveFresh = res)));
  // 动机场景还原：流终态静默刷新先发起，删除后的显式重拉后发起
  useUiStore.getState().refreshSessionsQuietly();
  const fresh = useUiStore.getState().refreshSessions();
  resolveFresh([{ id: 3, updatedAt: 30 }]);
  await fresh;
  resolveQuiet([{ id: 1, updatedAt: 10 }]); // 静默请求的陈旧响应后至
  // 静默路径内部 promise 无句柄，等微任务队列排空后断言（陈旧响应已丢弃）
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(useUiStore.getState().sessions.map((s) => s.id)).toEqual([3]);
  expect(useUiStore.getState().sessionsLoadError).toBeNull();
});
