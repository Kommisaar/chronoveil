// 叙事账本面板测试（FR-012）：入口开关、两段渲染（状态分组 / 场景倒序与
// 时间标签取值链）、recap 折叠、空态、终态与换会话重拉、错误重试，以及场景行
// 加分项（timeNote 优先 / 回落两态；present 在场角色名映射与未知 id 回退）。
// 第三段「调用轨迹」：汇总条数学（ok 合计 / 失败计数）、倒序、kind 徽标映射、
// null token 显「—」、失败红标；展开详情（role 分色 / 坏 JSON 降级 / 工具调用）；
// onTrace 头部插入与幂等原位更新；会话切换重拉与面板级错误重试。
// api 层整体 vi.mock（同 ChatView.history.test.tsx 的 Harness）；i18n 固定中文，
// 断言用 zh 文案。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StreamEventHandler } from '../../api/events';
import type { CharacterStateDto, CharacterSummary, SceneDto, SessionSummary } from '../../api/types';
import '../../i18n';
import { useUiStore } from '../../stores/ui';
import { ChatView } from './ChatView';
import { streamHub, type LlmCall } from './streamHub';

const mocks = vi.hoisted(() => {
  /** trace 桥接捕获：streamHub 模块初始化经 subscribeTraces 登记 ingestTrace */
  const traceBridge: { push: ((call: LlmCall) => void) | null } = { push: null };
  return {
    listSessions: vi.fn(),
    listMessages: vi.fn(),
    listCharacters: vi.fn(),
    getConfig: vi.fn(),
    sendMessage: vi.fn(),
    regenerateLast: vi.fn(),
    cancelGeneration: vi.fn(),
    listScenes: vi.fn(),
    listCharacterStates: vi.fn(),
    listLlmCalls: vi.fn(),
    subscribeStream: vi.fn(),
    subscribeTraces: vi.fn((ingest: (call: LlmCall) => void) => {
      traceBridge.push = ingest;
      return () => {};
    }),
    traceBridge,
  };
});

vi.mock('../../api/commands', () => ({
  listSessions: mocks.listSessions,
  listMessages: mocks.listMessages,
  listCharacters: mocks.listCharacters,
  getConfig: mocks.getConfig,
  sendMessage: mocks.sendMessage,
  regenerateLast: mocks.regenerateLast,
  cancelGeneration: mocks.cancelGeneration,
  listScenes: mocks.listScenes,
  listCharacterStates: mocks.listCharacterStates,
  listLlmCalls: mocks.listLlmCalls,
}));

vi.mock('../../api/events', () => ({
  subscribeStream: mocks.subscribeStream,
  subscribeTraces: mocks.subscribeTraces,
}));

/** subscribeStream mock 捕获的每会话事件处理器（终态刷新用例投递 done 事件） */
const handlers = new Map<number, StreamEventHandler>();

const CHARACTER: CharacterSummary = {
  id: 1,
  name: '织星者',
  avatar: null,
  persona: '',
  gender: null,
  age: null,
  renderStyle: 'fade',
  modelConfig: null,
  accentColor: null,
  calendarConfig: null,
  updatedAt: 0,
  sessionCount: 1,
};

// 会话 3 的 roster 回显（多角色第 1 步）：在场行的实例名映射来自这里——
// 实例 1 = 用户位「织星者」、实例 2 = LLM 位「守塔人」；实例快照名与模板卡名同形
const SESSION: SessionSummary = {
  id: 3,
  title: '',
  updatedAt: 0,
  instances: [
    { id: 1, name: '织星者', isUser: true, characterId: 1 },
    { id: 2, name: '守塔人', isUser: false, characterId: 2 },
  ],
};

const SCENES: SceneDto[] = [
  // 第 1 场：dateLabel 在场 → 优先于 ficDay/ficPart 拼接
  {
    id: 31,
    idx: 1,
    location: '旅店大堂',
    timeNote: null,
    ficDay: 1,
    ficPart: '夜',
    dateLabel: '白蜡月·晨露日·夜',
    summary: '初到旧都',
    recap: null,
    present: [1],
  },
  // 第 2 场：元数据全空 → 行保留，仅场号可辨
  {
    id: 32,
    idx: 2,
    location: null,
    timeNote: null,
    ficDay: null,
    ficPart: null,
    dateLabel: null,
    summary: null,
    recap: null,
    present: [],
  },
  // 第 3 场：dateLabel 缺失 → 拼 ficDay/ficPart；recap 非空 → 出折叠块
  {
    id: 33,
    idx: 3,
    location: '灯塔',
    timeNote: null,
    ficDay: 3,
    ficPart: '夜',
    dateLabel: null,
    summary: '对峙',
    recap: '前情：旅店夜话，守塔人的警告犹在耳边。',
    present: [1, 2],
  },
  // 第 4 场：timeNote 在场 → 时间标签优先叙事原文（压过 dateLabel 与 ficDay/ficPart）；
  // present 含未知 id 99 → 回退「角色#99」
  {
    id: 34,
    idx: 4,
    location: '钟楼',
    timeNote: '第三日黄昏，雨',
    ficDay: 4,
    ficPart: '黄昏',
    dateLabel: '白蜡月·收获日·黄昏',
    summary: '雨中告白',
    recap: null,
    present: [1, 99],
  },
];

const STATES: CharacterStateDto[] = [
  {
    id: 41,
    characterId: 1,
    scope: 'state',
    key: '伤势',
    value: '左臂脱臼',
    expiry: 'scene_end', // 结算清算线索：面板不展示，测试断言不出现在 DOM
    sourceScene: 31,
    updatedAt: 1,
  },
  {
    id: 42,
    characterId: 1,
    scope: 'relation',
    key: '对守塔人',
    value: '戒备',
    expiry: null,
    sourceScene: 31,
    updatedAt: 2,
  },
];

/** 本地时区构造当日时刻（epoch ms）：钟面时间断言不受 CI 时区影响 */
const localTime = (h: number, m: number, s: number): number =>
  new Date(2026, 8, 11, h, m, s).getTime();

// 调用轨迹 fixture（会话 3）：覆盖四种 kind、一条 error、一条带工具调用、
// token null 两态。列表按会话查询（后端 scope），不混入他山行；他山轨迹仅
// 走 onTrace 忽略断言（FOREIGN_CALL）。汇总数学：N=4（含 1 失败）；ok 三条
// → IN 120+90=210，OUT 45+0+0=45。
const CALLS: LlmCall[] = [
  {
    id: 101,
    sessionId: 3,
    kind: 'dialogue',
    model: 'glm-4-flash',
    startedAt: localTime(14, 23, 5),
    durationMs: 2400,
    promptJson: JSON.stringify([
      { role: 'system', content: '你是叙事主持人。' },
      { role: 'user', content: '我推开门。' },
    ]),
    responseText: '门后是长廊。',
    reasoningText: '用户在探索入口。',
    toolCallsJson: null,
    promptTokens: 120,
    completionTokens: 45,
    status: 'ok',
    errorText: null,
  },
  {
    id: 102,
    sessionId: 3,
    kind: 'explorer',
    model: 'glm-4-flash',
    startedAt: localTime(14, 23, 6),
    durationMs: 800,
    promptJson: '[]',
    responseText: null,
    reasoningText: null,
    toolCallsJson: JSON.stringify([{ name: 'search_memory', arguments: '{"query":"雨夜"}' }]),
    promptTokens: 90,
    completionTokens: null,
    status: 'ok',
    errorText: null,
  },
  {
    id: 103,
    sessionId: 3,
    kind: 'director',
    model: 'glm-4-air',
    startedAt: localTime(14, 23, 7),
    durationMs: 1500,
    // 截断的坏 JSON：详情降级显示原文，不炸
    promptJson: '[{"role":"tool","content":"bad"}',
    responseText: null,
    reasoningText: null,
    toolCallsJson: null,
    promptTokens: null,
    completionTokens: null,
    status: 'error',
    errorText: 'provider 超时',
  },
  {
    id: 104,
    sessionId: 3,
    kind: 'draft',
    model: 'glm-4-air',
    startedAt: localTime(14, 23, 8),
    durationMs: 300,
    promptJson: '[]',
    responseText: '历法草案已生成。',
    reasoningText: null,
    toolCallsJson: null,
    promptTokens: null,
    completionTokens: null,
    status: 'ok',
    errorText: null,
  },
];

/** 他山会话的轨迹（仅 onTrace 实时流用）：面板必须忽略，不入列表 */
const FOREIGN_CALL: LlmCall = {
  id: 201,
  sessionId: 99,
  kind: 'explorer',
  model: 'ghost-model',
  startedAt: localTime(20, 0, 1),
  durationMs: 10,
  promptJson: '[]',
  responseText: null,
  reasoningText: null,
  toolCallsJson: null,
  promptTokens: 1,
  completionTokens: 1,
  status: 'ok',
  errorText: null,
};

function renderView() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <ChatView />
    </FluentProvider>,
  );
}

/** 打开叙事账本面板（点聊天列右上角浮动钮）。 */
function openLedger(): void {
  fireEvent.click(screen.getByRole('button', { name: '叙事账本' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSessions.mockResolvedValue([]);
  mocks.listMessages.mockResolvedValue([]);
  mocks.listCharacters.mockResolvedValue([CHARACTER]);
  mocks.getConfig.mockRejectedValue(new Error('配置缺席走引擎默认'));
  mocks.listScenes.mockResolvedValue(SCENES);
  mocks.listCharacterStates.mockResolvedValue(STATES);
  mocks.listLlmCalls.mockResolvedValue(CALLS);
  mocks.subscribeStream.mockImplementation((sessionId: number, handler: StreamEventHandler) => {
    handlers.set(sessionId, handler);
    return () => {
      handlers.delete(sessionId);
    };
  });
  // 会话清单单一数据源（TASK-007）：面板的在场实例名映射从 store 的 roster 回显取
  useUiStore.setState({ activeSessionId: 3, sessions: [SESSION], sessionsLoaded: true });
});

afterEach(() => {
  cleanup();
  // hub 是模块级单例：摘掉本文件登记的路由订阅与流状态，避免跨用例泄漏
  for (const sessionId of [...handlers.keys()]) streamHub.end(sessionId);
  handlers.clear();
  useUiStore.setState({ activeSessionId: null, sessions: [], sessionsLoaded: false });
});

it('面板打开即拉取场景 / 状态（调用轨迹见第三段），场景状态按当前会话查询；拉取中先见加载态', async () => {
  renderView();
  openLedger();
  // 加载态同步可见（promise 未 resolve 前渲染 spinner + 文案）
  expect(screen.getByText('加载中…')).toBeTruthy();
  expect(mocks.listScenes).toHaveBeenCalledWith(3);
  expect(mocks.listCharacterStates).toHaveBeenCalledWith(3);
  await screen.findByText('第3场');
});

it('两段渲染：状态按 scope 分组、expiry 不展示；场景倒序、时间标签按 dateLabel → ficDay/ficPart 取值链', async () => {
  const { container } = renderView();
  openLedger();
  await screen.findByText('第3场');

  // 人物状态：两组各自带标题；`key：value` 行；expiry（scene_end）不出现
  expect(screen.getByText('人物状态')).toBeTruthy();
  expect(screen.getByText('当前状态')).toBeTruthy();
  expect(screen.getByText('伤势：左臂脱臼')).toBeTruthy();
  expect(screen.getByText('关系')).toBeTruthy();
  expect(screen.getByText('对守塔人：戒备')).toBeTruthy();
  expect(container.textContent).not.toContain('scene_end');

  // 场景史：倒序（最新在上）
  const text = container.textContent ?? '';
  expect(text.indexOf('第3场')).toBeLessThan(text.indexOf('第2场'));
  expect(text.indexOf('第2场')).toBeLessThan(text.indexOf('第1场'));

  // 第 3 场：dateLabel 缺失 → 拼 ficDay/ficPart；地点与 summary 各就位
  expect(screen.getByText('第3日·夜')).toBeTruthy();
  expect(screen.getByText('灯塔')).toBeTruthy();
  expect(screen.getByText('对峙')).toBeTruthy();

  // 第 1 场：dateLabel 优先，不走 ficDay/ficPart 拼接
  expect(screen.getByText('白蜡月·晨露日·夜')).toBeTruthy();
  expect(screen.queryByText('第1日·夜')).toBeNull();

  // 第 2 场：元数据全空 → 行保留（场号可辨），无时间标签/地点/摘要
  expect(screen.getByText('第2场')).toBeTruthy();
});

it('recap 折叠：默认收起，点「展开回顾」后内容可见', async () => {
  renderView();
  openLedger();
  await screen.findByText('第3场');
  expect(screen.queryByText('前情：旅店夜话，守塔人的警告犹在耳边。')).toBeNull();
  fireEvent.click(screen.getByText('展开回顾'));
  await screen.findByText('前情：旅店夜话，守塔人的警告犹在耳边。');
});

it('空态：无状态显示「暂无状态记录」（组标题省略），无场景显示「本会话还没有场景记录」', async () => {
  mocks.listScenes.mockResolvedValue([]);
  mocks.listCharacterStates.mockResolvedValue([]);
  renderView();
  openLedger();
  expect(await screen.findByText('暂无状态记录')).toBeTruthy();
  expect(screen.getByText('本会话还没有场景记录')).toBeTruthy();
  expect(screen.queryByText('当前状态')).toBeNull();
  expect(screen.queryByText('关系')).toBeNull();
  expect(screen.queryByText(/第\d+场/)).toBeNull();
});

it('会话切换重拉：面板开着换 activeSessionId，按新会话重新查询', async () => {
  renderView();
  openLedger();
  await screen.findByText('第3场');
  expect(mocks.listScenes).toHaveBeenCalledTimes(1);
  act(() => {
    useUiStore.setState({ activeSessionId: 5 });
  });
  await waitFor(() => expect(mocks.listScenes).toHaveBeenCalledWith(5));
  await waitFor(() => expect(mocks.listCharacterStates).toHaveBeenCalledWith(5));
});

it('终态刷新：本会话 done 事件（已落库，ADR-005 done 放行前结算在库）触发静默重拉', async () => {
  renderView();
  openLedger();
  await screen.findByText('第3场');
  expect(mocks.listScenes).toHaveBeenCalledTimes(1);
  streamHub.begin(3);
  handlers.get(3)?.({ type: 'done', sessionId: 3, messageId: -1, thinkMs: 12 });
  await waitFor(() => expect(mocks.listScenes).toHaveBeenCalledTimes(2));
  expect(mocks.listScenes).toHaveBeenLastCalledWith(3);
});

it('错误重试：拉取失败显示错误与重试入口，重试成功恢复渲染', async () => {
  mocks.listScenes.mockRejectedValueOnce(new Error('db down'));
  renderView();
  openLedger();
  expect(await screen.findByText('叙事账本加载失败')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await screen.findByText('第3场');
  expect(mocks.listScenes).toHaveBeenCalledTimes(2);
});

it('timeNote 两态：叙事时间原文在场时优先成标签（压过 dateLabel 与 ficDay 拼链），缺失回落既有链', async () => {
  renderView();
  openLedger();
  await screen.findByText('第4场');

  // 第 4 场：timeNote 优先 —— dateLabel 与 ficDay/ficPart 拼接都不出（一枚标签不堆叠）
  expect(screen.getByText('第三日黄昏，雨')).toBeTruthy();
  expect(screen.queryByText('白蜡月·收获日·黄昏')).toBeNull();
  expect(screen.queryByText('第4日·黄昏')).toBeNull();

  // 回落态：第 1 场 timeNote 缺失 → dateLabel；第 3 场再缺 → ficDay/ficPart 拼接
  expect(screen.getByText('白蜡月·晨露日·夜')).toBeTruthy();
  expect(screen.getByText('第3日·夜')).toBeTruthy();
});

it('在场角色：present 实例 id 按 roster 回显映射实例名，未知 id 回退「角色#id」，空 present 不出行', async () => {
  const { container } = renderView();
  openLedger();
  await screen.findByText('第4场');

  // 第 1 场 present [1] → 织星者；第 3 场 [1, 2] → 双实例名映射；第 4 场 [1, 99] → 未知 id 回退
  expect(screen.getByText('在场：织星者')).toBeTruthy();
  expect(screen.getByText('在场：织星者、守塔人')).toBeTruthy();
  expect(screen.getByText('在场：织星者、角色#99')).toBeTruthy();

  // 第 2 场 present [] → 不出「在场」行：全篇共 3 行
  expect(screen.getAllByText(/^在场：/)).toHaveLength(3);
  expect(container.textContent).not.toContain('角色#1');
});

// —— 第三段：调用轨迹 ——

it('调用轨迹段渲染：面板打开即拉取、汇总条数学（N 含失败、token 合计仅 ok）、倒序、kind 徽标、null token 显「—」、失败红标', async () => {
  const { container } = renderView();
  openLedger();
  expect(mocks.listLlmCalls).toHaveBeenCalledWith(3);
  await screen.findByText('调用轨迹');

  // 汇总条：4 次调用（N 含 error）且 1 失败 → 附失败计数；token 合计仅统计 ok
  // 三条（120+90 IN，45 OUT；null 记 0）。「N 次调用」与「（M 失败）」是相邻
  // 文本节点，从容器全文断言
  expect(container.textContent).toContain('4 次调用（1 失败）');
  expect(container.textContent).toContain('↑ 210 tok');
  expect(container.textContent).toContain('↓ 45 tok');

  // 倒序：最新在上（startedAt 降序 → #4 在最前，#1 在最后）。探针用
  // 「序号+徽标」复合串：单查 '#N' 会撞上「角色#id」回退文案（第 3 场 present
  // 含未配置进清单的 id 2）
  const text = container.textContent ?? '';
  expect(text.indexOf('#4起草')).toBeLessThan(text.indexOf('#3结算'));
  expect(text.indexOf('#3结算')).toBeLessThan(text.indexOf('#2探索'));
  expect(text.indexOf('#2探索')).toBeLessThan(text.indexOf('#1对话'));

  // kind 徽标中文映射（四种齐备）；秒级钟面时间（HH:mm:ss）
  expect(screen.getByText('对话')).toBeTruthy();
  expect(screen.getByText('探索')).toBeTruthy();
  expect(screen.getByText('结算')).toBeTruthy();
  expect(screen.getByText('起草')).toBeTruthy();
  expect(screen.getByText(/14:23:05/)).toBeTruthy();

  // token null → 「—」（错误记录与起草记录两条均为 null）；有值 → 数字
  expect(screen.getAllByText(/↑ — · ↓ —/)).toHaveLength(2);
  expect(screen.getByText(/↑ 90 · ↓ —/)).toBeTruthy();

  // error 记录：红色标记（「失败」徽标）；仅 4 条 → 无 #5 序号
  expect(screen.getByText('失败')).toBeTruthy();
  expect(screen.queryByText('#5')).toBeNull();
});

it('展开详情：请求消息按 role 分色渲染（role 标签 + 内容）、回复与思考有则显示；同时只开一行，再点收起', async () => {
  renderView();
  openLedger();
  await screen.findByText('#1');

  // 默认全收起：详情标题不可见
  expect(screen.queryByText('请求消息')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /对话/ }));
  await screen.findByText('请求消息');
  // 请求消息：每条带 role 标签 + 内容（system / user 各一条）
  expect(screen.getByText('system')).toBeTruthy();
  expect(screen.getByText('你是叙事主持人。')).toBeTruthy();
  expect(screen.getByText('user')).toBeTruthy();
  expect(screen.getByText('我推开门。')).toBeTruthy();
  // 回复正文 / 思考过程：有则显示
  expect(screen.getByText('回复正文')).toBeTruthy();
  expect(screen.getByText('门后是长廊。')).toBeTruthy();
  expect(screen.getByText('思考过程')).toBeTruthy();
  expect(screen.getByText('用户在探索入口。')).toBeTruthy();

  // 同时只开一行：点开探索行 → 对话行详情收起，工具调用列表可见
  fireEvent.click(screen.getByRole('button', { name: /探索/ }));
  await screen.findByText('工具调用');
  expect(screen.queryByText('请求消息')).toBeNull();
  expect(screen.getByText('search_memory')).toBeTruthy();
  expect(screen.getByText('{"query":"雨夜"}')).toBeTruthy();

  // 再点已开行：收起
  fireEvent.click(screen.getByRole('button', { name: /探索/ }));
  expect(screen.queryByText('工具调用')).toBeNull();
});

it('坏数据降级与错误记录：promptJson 解析失败显示原文不炸；error 记录展开显示错误信息', async () => {
  renderView();
  openLedger();
  await screen.findByText('#3');

  fireEvent.click(screen.getByRole('button', { name: /结算/ }));
  await screen.findByText('错误信息');
  // 坏 JSON：降级原文（未解析成 role 列表）
  expect(screen.getByText('[{"role":"tool","content":"bad"}')).toBeTruthy();
  expect(screen.queryByText('tool')).toBeNull();
  // 错误信息原文
  expect(screen.getByText('provider 超时')).toBeTruthy();
});

it('onTrace 实时流：本会话新轨迹头部插入（不重拉全量）；同 id 更新原位（幂等）；他山会话忽略', async () => {
  const { container } = renderView();
  openLedger();
  await screen.findByText('#4');
  expect(mocks.listLlmCalls).toHaveBeenCalledTimes(1); // 初始拉取一次

  // 新 dialogue 轨迹到达 → 头部插入为 #5，列表不重拉
  act(() => {
    mocks.traceBridge.push?.({
      id: 200,
      sessionId: 3,
      kind: 'dialogue',
      model: 'live-model',
      startedAt: localTime(20, 0, 0),
      durationMs: 900,
      promptJson: '[]',
      responseText: '直播回复。',
      reasoningText: null,
      toolCallsJson: null,
      promptTokens: 5,
      completionTokens: 6,
      status: 'ok',
      errorText: null,
    });
  });
  await screen.findByText('#5');
  expect(mocks.listLlmCalls).toHaveBeenCalledTimes(1); // 未重拉全量
  const text = container.textContent ?? '';
  expect(text.indexOf('#5对话')).toBeLessThan(text.indexOf('#4起草'));
  expect(screen.getByText('live-model')).toBeTruthy();

  // 同 id 补发 → 原位更新（仍是 #5），内容替换，不新增行
  act(() => {
    mocks.traceBridge.push?.({
      id: 200,
      sessionId: 3,
      kind: 'dialogue',
      model: 'patched-model',
      startedAt: localTime(20, 0, 0),
      durationMs: 950,
      promptJson: '[]',
      responseText: '直播回复。',
      reasoningText: null,
      toolCallsJson: null,
      promptTokens: 5,
      completionTokens: 6,
      status: 'ok',
      errorText: null,
    });
  });
  await screen.findByText('patched-model');
  expect(screen.queryByText('live-model')).toBeNull();
  expect(screen.getByText('#5')).toBeTruthy();
  expect(screen.queryByText('#6')).toBeNull();

  // 其他会话的轨迹：忽略（不插入、不改序号）
  act(() => {
    mocks.traceBridge.push?.(FOREIGN_CALL);
  });
  expect(screen.queryByText('#6')).toBeNull();
  expect(screen.queryByText('ghost-model')).toBeNull();
});

it('会话切换重拉：面板开着换 activeSessionId，调用轨迹按新会话重新查询', async () => {
  renderView();
  openLedger();
  await screen.findByText('#4');
  act(() => {
    useUiStore.setState({ activeSessionId: 5 });
  });
  await waitFor(() => expect(mocks.listLlmCalls).toHaveBeenCalledWith(5));
  await waitFor(() => expect(mocks.listLlmCalls).toHaveBeenCalledTimes(2));
});

it('错误重试：轨迹拉取失败与其他段一并走面板级错误态，重试成功恢复渲染', async () => {
  mocks.listLlmCalls.mockRejectedValueOnce(new Error('db down'));
  renderView();
  openLedger();
  expect(await screen.findByText('叙事账本加载失败')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await screen.findByText('#4');
  expect(mocks.listLlmCalls).toHaveBeenCalledTimes(2);
});
