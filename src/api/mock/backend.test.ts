/**
 * mock 后端契约对齐测试（ADR-010 双模式）：以冻结契约（多角色第 1 步，Rust 侧
 * Task-30 落地）与 src-tauri/src/interfaces/ipc.rs 既有语义为参照，逐命令断言
 * 纯浏览器 mock（src/api/mock/backend.ts）行为同契约：
 * - 会话：阵容制建会话（非空 + is_user 恰好一 + 逐成员卡在世 → 逐卡实例化快照，
 *   D1/D2）、快照与卡隔离（改卡不影响已建会话读数）、软删后不再出现、重复删除
 *   NotFound、列表 updated_at DESC + id DESC（infra/storage/sessions.rs 排序）；
 * - 消息：先取会话（不存在 / 已删 → NotFound）、characterId wire 定案（assistant 条 =
 *   说话实例真值，user 条恒 null）；
 * - 场景 / 人物状态列表（FR-011 / FR-012）：mock 无存储诚实返回空数组、
 *   会话不存在 / 已软删 → NotFound；
 * - 发送：检查顺序（先会话后内容）、只回执用户条 + mock 占位回复、FR-007 标题
 *   缺省取首条用户消息截断（generation::default_title：20 字 + 省略号）；
 * - 重新生成：返回被替换的旧条（ipc.rs regenerate_last_impl 契约，前端据以移除）；
 * - 取消：无活跃生成恒 false（幂等 no-op）；mock 无事件流（subscribeStream no-op）；
 * - 角色 CRUD（sessionCount 统计读 is_user）/ config 往返与 10–160 值域校验
 *   （FR-006 / FR-009）；
 * - AI 起草历法（FR-014 二期）：确定性白蜡历样例、空白 / 超长描述错误语义
 *   与 services/calendar_draft 同构；
 * - 错误形态：统一 ApiError，payload.kind 判别值与 Rust IpcError wire 形态一致。
 *
 * mock 模块持有内存态（data.ts 种子 + 游标），每个用例经 vi.resetModules 重新载入，
 * 互不污染；时间经 fake timers 冻结，使 createdAt / updatedAt 断言确定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CalendarConfigDto,
  ConfigDto,
  SessionOpeningInput,
  SessionRosterMember,
  UpdateCharacterInput,
} from '../types';

const BASE = new Date('2026-01-01T12:00:00Z').getTime();

type Backend = typeof import('./backend');
type Data = typeof import('./data');

/** 重新载入 mock 模块（种子 + 内存态 + id 游标全部还原）。 */
async function loadMock(): Promise<{ backend: Backend; data: Data }> {
  vi.resetModules();
  const backend = await import('./backend');
  const data = await import('./data');
  return { backend, data };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE); // data.ts 以 Date.now() 派生种子时间，先冻结再载入
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

/** 断言命令以 ApiError 失败并返回 IpcError payload（kind 可判别）。 */
async function apiErrorOf(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('ApiError');
    return (err as { payload: Record<string, unknown> }).payload;
  }
  throw new Error('预期 mock 命令抛 ApiError，但成功返回');
}

/**
 * 角色卡入参样例（updateCharacter 负载形态 UpdateCharacterInput，含历法槽位；
 * 结构兼容 createCharacter 的 CharacterInput——多出的 calendarConfig 由 create 忽略）。
 */
function characterInput(
  overrides: Partial<UpdateCharacterInput> = {},
): UpdateCharacterInput {
  return {
    name: '测试角色',
    avatar: 'data:image/png;base64,AAA',
    persona: '雨夜电话亭的守夜人',
    gender: '女',
    age: '24',
    renderStyle: 'typewriter',
    modelConfig: '{"providerId":"p1","model":"m1"}',
    accentColor: '#5e2347',
    voiceConfig: null, // CON-003 TTS 预留缝，前端恒传 null
    calendarConfig: null, // FR-013 历法槽位；null = 无历法（整卡覆盖 = 清除）
    ...overrides,
  };
}

function configWith(overrides: Partial<ConfigDto> = {}): ConfigDto {
  return {
    providers: [],
    activeProviderId: null,
    activeModel: null,
    rhythmMsPerChar: 45,
    punctPauseEnabled: true,
    animDurationBase: 450,
    uiLanguage: 'zh',
    uiTheme: 'system',
    directorModel: null,
    nearScenes: 2,
    ...overrides,
  };
}

/** 最小双位阵容（D2 自演自）：同卡 1 用户位 + 1 LLM 位。 */
function duo(characterId: number): SessionRosterMember[] {
  return [
    { characterId, isUser: true },
    { characterId, isUser: false },
  ];
}

describe('listSessions（FR-007 排序 / 软删过滤）', () => {
  it('按 updatedAt 倒序；同刻并列按 id 倒序（sessions.rs ORDER BY updated_at DESC, id DESC）', async () => {
    const { backend } = await loadMock();
    expect((await backend.listSessions()).map((s) => s.id)).toEqual([1, 2, 3]);
    // 冻结时钟下新建的两条 updatedAt 相同 → id 大者在前
    await backend.createSession(duo(1), null, null);
    await backend.createSession(duo(1), null, null);
    expect((await backend.listSessions()).map((s) => s.id)).toEqual([5, 4, 1, 2, 3]);
  });

  it('软删后不再出现；重复删除报 NotFound（已软删等价不可见，ADR-009）', async () => {
    const { backend } = await loadMock();
    await backend.deleteSession(1);
    expect((await backend.listSessions()).map((s) => s.id)).toEqual([2, 3]);
    expect(await apiErrorOf(backend.deleteSession(1))).toEqual({
      kind: 'notFound',
      entity: 'session',
      id: 1,
    });
  });
});

describe('createSession（多角色第 1 步：阵容制 / D1 实例化 / D2 扮演位）', () => {
  it('阵容建会话（1 用户位 + 2 LLM 位 → 3 实例）：is_user 恰好一、实例 id 全局自增、快照名拷贝、模板溯源', async () => {
    const { backend } = await loadMock();
    const created = await backend.createSession(
      [
        { characterId: 1, isUser: false },
        { characterId: 2, isUser: true },
        { characterId: 1, isUser: false },
      ],
      null,
      null,
    );
    // 1+2 → 3 实例；种子实例 id 最大 6，游标 7 起全局自增（不与会话 1–3 冲突）
    expect(created.instances).toHaveLength(3);
    expect(created.instances?.map((i) => i.id)).toEqual([7, 8, 9]);
    expect(created.instances?.filter((i) => i.isUser)).toHaveLength(1);
    expect(created.instances?.[1]).toEqual({
      id: 8,
      name: '林深', // 快照名值拷贝（D1）
      isUser: true,
      characterId: 2, // 模板溯源
      renderStyle: 'ink', // 出场风格快照值拷贝（D1）
    });
    // 同卡可重复入选（D2 自己跟自己对话）：1 号卡两实例同形异 id
    expect(created.instances?.[0]?.name).toBe('苏鸢');
    expect(created.instances?.[2]?.name).toBe('苏鸢');
    expect(created.instances?.[0]?.id).not.toBe(created.instances?.[2]?.id);
    // 标题缺省空串（FR-007：首条用户消息后回填）
    expect(created.title).toBe('');
    // 回显进入列表读数
    expect((await backend.listSessions()).find((s) => s.id === created.id)?.instances).toHaveLength(3);
  });

  it('阵容为空 / is_user 数量不为 1 报 conflict（D2 恰好一的不变量在 wire 入口把关）', async () => {
    const { backend } = await loadMock();
    expect(await apiErrorOf(backend.createSession([], null, null))).toEqual({
      kind: 'conflict',
      message: '会话阵容不能为空',
    });
    expect(
      (await apiErrorOf(backend.createSession([{ characterId: 1, isUser: false }], null, null))).kind,
    ).toBe('conflict');
    expect(
      (
        await apiErrorOf(
          backend.createSession(
            [
              { characterId: 1, isUser: true },
              { characterId: 2, isUser: true },
            ],
            null,
            null,
          ),
        )
      ).kind,
    ).toBe('conflict');
  });

  it('成员卡不存在报 NotFound（而非裸外键冲突，ipc.rs create_session_impl）；被拒请求不建会话', async () => {
    const { backend } = await loadMock();
    const payload = await apiErrorOf(
      backend.createSession(
        [
          { characterId: 1, isUser: true },
          { characterId: 999, isUser: false },
        ],
        null,
        null,
      ),
    );
    expect(payload).toEqual({ kind: 'notFound', entity: 'character', id: 999 });
    // 错误文案与 Rust IpcError::NotFound 的 Display 一致（ApiError.describe）
    await expect(
      backend.createSession([{ characterId: 999, isUser: true }], null, null),
    ).rejects.toMatchObject({
      message: 'character #999 不存在（或已软删除）',
    });
    expect((await backend.listSessions()).map((s) => s.id)).toEqual([1, 2, 3]);
  });

  it('快照与卡隔离（D1）：建会后改卡，已建会话的实例读数不变', async () => {
    const { backend } = await loadMock();
    const created = await backend.createSession(duo(2), null, null);
    await backend.updateCharacter(
      2,
      characterInput({ name: '林深（改）', renderStyle: 'typewriter' }),
    );
    const after = (await backend.listSessions()).find((s) => s.id === created.id);
    // 改卡不回写实例：名字仍是建会话时的快照
    expect(after?.instances?.map((i) => i.name)).toEqual(['林深', '林深']);
    // 模板溯源不受改名影响
    expect(after?.instances?.every((i) => i.characterId === 2)).toBe(true);
  });
});

describe('createSession 开局包（FR-014 入参校验对齐 Rust create_session_impl）', () => {
  /** 合法开局包底版（wire 形态：五字段齐全，可空项传 null）。 */
  function opening(overrides: Partial<SessionOpeningInput> = {}) {
    return {
      calendar: null,
      ficDay: 3,
      ficPart: '黄昏',
      location: '旧都 · 灯市',
      timeNote: null,
      ...overrides,
    };
  }

  it('带合法开局包照常建会话（mock 不入存储），opening = null（直接开始）等价降级', async () => {
    const { backend } = await loadMock();
    const withOpening = await backend.createSession(duo(1), null, opening());
    expect(withOpening.id).toBe(4);
    const degraded = await backend.createSession(duo(1), null, null);
    expect(degraded.id).toBe(5);
  });

  it('时段不在六值内报 conflict（fiction_time::PARTS 六值为校验基准）', async () => {
    const { backend } = await loadMock();
    const payload = await apiErrorOf(
      backend.createSession(duo(1), null, opening({ ficPart: '半夜三更' })),
    );
    expect(payload.kind).toBe('conflict');
    // 六值边界逐一放行
    for (const part of ['清晨', '上午', '午后', '黄昏', '夜', '深夜']) {
      await backend.createSession(duo(1), null, opening({ ficPart: part }));
    }
  });

  it('起始日 < 1 报 conflict；显式日历缺月长基准 / 月日名全空报 conflict，合法日历放行', async () => {
    const { backend } = await loadMock();
    expect(
      (await apiErrorOf(backend.createSession(duo(1), null, opening({ ficDay: 0 })))).kind,
    ).toBe('conflict');

    const badCalendar = {
      name: '坏历',
      months: ['霜月'],
      daysPerMonth: 0,
      dayNames: [],
      festivals: null,
    };
    expect(
      (
        await apiErrorOf(
          backend.createSession(duo(1), null, opening({ calendar: badCalendar, ficDay: null })),
        )
      ).kind,
    ).toBe('conflict');

    await backend.createSession(duo(1), null, opening({ ficDay: 45, ficPart: '夜', calendar: {
      name: '旧都历',
      months: ['霜月', '白蜡月'],
      daysPerMonth: 30,
      dayNames: ['晨露日', '萤火日'],
      festivals: { 45: '灯节' },
    } }));
  });
});

describe('draftCalendar（FR-014 二期 AI 起草历法，语义对齐 services/calendar_draft）', () => {
  it('返回确定性白蜡历样例：schema 五字段齐全、festivals 数字字符串键、满足命名皮肤可用性', async () => {
    const { backend } = await loadMock();
    const draft = await backend.draftCalendar('修仙世界，一年十二个月每月三十天，有春节中秋');
    expect(draft.name).toBe('白蜡历');
    expect(draft.months).toHaveLength(12);
    expect(draft.daysPerMonth).toBeGreaterThan(0);
    expect(draft.dayNames.length).toBeGreaterThan(0);
    // festivals wire 形态：键 = 年内第几天的数字字符串（与 Rust BTreeMap<i64,String> JSON 同形）。
    expect(Object.keys(draft.festivals ?? {})).toEqual(['45', '360']);
    expect(draft.festivals?.[45]).toBe('灯节');
    // 保存侧可用性判定（fiction_time::validate 同构）：daysPerMonth > 0 且月/日名至少其一非空。
    expect(draft.daysPerMonth > 0 && (draft.months.length > 0 || draft.dayNames.length > 0)).toBe(
      true,
    );
    // 确定性：同输入两次起草结果一致。
    expect(await backend.draftCalendar('再起草一次')).toEqual(
      await backend.draftCalendar('再起草一次'),
    );
  });

  it('空白描述报 conflict，文案与 Rust InvalidDescription 一致', async () => {
    const { backend } = await loadMock();
    for (const blank of ['', '   ', '\n\t ']) {
      expect(await apiErrorOf(backend.draftCalendar(blank))).toEqual({
        kind: 'conflict',
        message: '描述内容为空：请先填写世界观描述',
      });
    }
  });

  it('超长描述（> 4000 字符，按码点计）报 conflict；4000 恰好放行', async () => {
    const { backend } = await loadMock();
    expect(await apiErrorOf(backend.draftCalendar('甲'.repeat(4001)))).toEqual({
      kind: 'conflict',
      message: '描述过长：4001 字符，上限 4000，请精简后重试',
    });
    expect((await backend.draftCalendar('甲'.repeat(4000))).name).toBe('白蜡历');
  });

  it('返回深拷贝：改动起草结果不污染后续起草', async () => {
    const { backend } = await loadMock();
    const first = await backend.draftCalendar('旧都世界观');
    first.months.push('多余月');
    if (!first.festivals) throw new Error('起草结果应含节日表');
    first.festivals[45] = '被改掉的节日';
    const second = await backend.draftCalendar('旧都世界观');
    expect(second.months).toHaveLength(12);
    expect(second.festivals?.[45]).toBe('灯节');
  });
});

describe('deleteSession', () => {
  it('删除后会话不可再读（listMessages → NotFound）；删除不存在的会话报 NotFound', async () => {
    const { backend } = await loadMock();
    await backend.deleteSession(2);
    expect(await apiErrorOf(backend.listMessages(2))).toEqual({
      kind: 'notFound',
      entity: 'session',
      id: 2,
    });
    expect(await apiErrorOf(backend.deleteSession(999))).toEqual({
      kind: 'notFound',
      entity: 'session',
      id: 999,
    });
  });
});

describe('listMessages（ADR-001 读路径）', () => {
  it('返回种子消息（id 升序）；characterId 定案：assistant 条为说话实例真值，user 条恒 null', async () => {
    const { backend } = await loadMock();
    const messages = await backend.listMessages(1);
    expect(messages.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(messages.map((m) => m.role)).toEqual([
      'assistant',
      'user',
      'assistant',
      'assistant',
    ]);
    // 种子会话 1 阵容：实例 1 = 用户位（苏鸢）、实例 2 = LLM 位（苏鸢，自演自 D2）
    expect(messages[1]?.characterId).toBeNull(); // user 条不携带实例 id（wire 定案）
    expect(messages[0]?.characterId).toBe(2);
    expect(messages[3]?.interrupted).toBe(true);
  });

  it('不存在的会话报 NotFound（对齐 ipc.rs：先 get_session，而非返回空列表）', async () => {
    const { backend } = await loadMock();
    expect(await apiErrorOf(backend.listMessages(12345))).toEqual({
      kind: 'notFound',
      entity: 'session',
      id: 12345,
    });
  });
});

describe('listScenes / listCharacterStates（FR-011 / FR-012 读路径）', () => {
  it('mock 无场景 / 状态存储：在世会话诚实返回空数组（不伪造演示数据）', async () => {
    const { backend } = await loadMock();
    expect(await backend.listScenes(1)).toEqual([]);
    expect(await backend.listCharacterStates(1)).toEqual([]);
    // 新建会话同样为空（Rust 侧有开场锚行，mock 无 scenes 表——差异仅此一处，语义不破）。
    const fresh = await backend.createSession(duo(1), null, null);
    expect(await backend.listScenes(fresh.id)).toEqual([]);
    expect(await backend.listCharacterStates(fresh.id)).toEqual([]);
  });

  it('不存在的会话报 NotFound（对齐 ipc.rs list_scenes_impl / list_character_states_impl）', async () => {
    const { backend } = await loadMock();
    expect(await apiErrorOf(backend.listScenes(999))).toEqual({
      kind: 'notFound',
      entity: 'session',
      id: 999,
    });
    expect(await apiErrorOf(backend.listCharacterStates(999))).toEqual({
      kind: 'notFound',
      entity: 'session',
      id: 999,
    });
  });

  it('已软删会话等价不可见（ADR-009）：读场景 / 状态同样报 NotFound', async () => {
    const { backend } = await loadMock();
    await backend.deleteSession(3);
    expect(await apiErrorOf(backend.listScenes(3))).toEqual({
      kind: 'notFound',
      entity: 'session',
      id: 3,
    });
    expect(await apiErrorOf(backend.listCharacterStates(3))).toEqual({
      kind: 'notFound',
      entity: 'session',
      id: 3,
    });
  });
});

describe('listLlmCalls（透明化功能：LLM 调用轨迹读路径，语义对齐 ipc.rs list_llm_calls_impl）', () => {
  it('初始无轨迹：在世会话返回空数组（mock 只在 sendMessage 时合成演示条目）', async () => {
    const { backend } = await loadMock();
    expect(await backend.listLlmCalls(1)).toEqual([]);
  });

  it('sendMessage 合成一条 dialogue 轨迹：字段齐全、promptJson 可 parse、内容标注 mock', async () => {
    const { backend } = await loadMock();
    const session = await backend.createSession(duo(1), null, null);
    await backend.sendMessage(session.id, '你好，雨夜');
    const calls = await backend.listLlmCalls(session.id);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.sessionId).toBe(session.id);
    expect(call.kind).toBe('dialogue');
    expect(call.status).toBe('ok');
    expect(call.errorText).toBeNull();
    expect(call.model).toContain('mock');
    expect(call.responseText).toContain('mock');
    expect(typeof call.promptJson).toBe('string');
    expect(JSON.parse(call.promptJson)).toEqual([{ role: 'user', content: '你好，雨夜' }]);
    expect(call.durationMs).toBeGreaterThan(0);
    expect(call.promptTokens).toBeGreaterThan(0);
    expect(call.completionTokens).toBeGreaterThan(0);
  });

  it('按 id 倒序（最新在前）；limit 截断取最新；跨会话隔离', async () => {
    const { backend } = await loadMock();
    const sessionA = await backend.createSession(duo(1), null, null);
    const sessionB = await backend.createSession(duo(2), null, null);
    await backend.sendMessage(sessionA.id, '第一条');
    await backend.sendMessage(sessionA.id, '第二条');
    await backend.sendMessage(sessionB.id, '别会话');

    const callsA = await backend.listLlmCalls(sessionA.id);
    expect(callsA).toHaveLength(2);
    expect(callsA[0]!.id).toBeGreaterThan(callsA[1]!.id);
    // 倒序：最新在前。
    expect(JSON.parse(callsA[0]!.promptJson)[0].content).toBe('第二条');
    expect(await backend.listLlmCalls(sessionB.id)).toHaveLength(1);
    // limit 生效：截取最新 1 条。
    const capped = await backend.listLlmCalls(sessionA.id, 1);
    expect(capped.map((c) => c.id)).toEqual([callsA[0]!.id]);
  });

  it('不存在的会话报 NotFound；已软删会话等价不可见（对齐 ipc.rs NotFound 同构）', async () => {
    const { backend } = await loadMock();
    expect(await apiErrorOf(backend.listLlmCalls(999))).toEqual({
      kind: 'notFound',
      entity: 'session',
      id: 999,
    });
    const session = await backend.createSession(duo(1), null, null);
    await backend.sendMessage(session.id, '轨迹一条');
    await backend.deleteSession(session.id);
    expect(await apiErrorOf(backend.listLlmCalls(session.id))).toEqual({
      kind: 'notFound',
      entity: 'session',
      id: session.id,
    });
  });
});

describe('sendMessage（SEQ-001 回执 / FR-007 标题回填）', () => {
  it('回执用户条（trim、characterId 恒 null、正数 id）并追加 mock 占位回复（LLM 位实例发声）', async () => {
    const { backend } = await loadMock();
    const session = await backend.createSession(duo(1), null, null);
    // 本会话阵容：实例 7 = 用户位、实例 8 = LLM 位（种子实例 1–6 后全局自增）
    const userInstance = session.instances.find((i) => i.isUser);
    const llmInstance = session.instances.find((i) => !i.isUser);
    expect(userInstance?.id).toBe(7);
    expect(llmInstance?.id).toBe(8);
    const user = await backend.sendMessage(session.id, '  你好，雨夜  ');
    expect(user).toEqual({
      id: 7, // 种子消息 id 最大 6，游标不冲突
      sessionId: session.id,
      characterId: null, // wire 定案：user 条恒 null（实例 id 只在存储层盖章，不出 wire）
      role: 'user',
      content: '你好，雨夜',
      reasoning: null,
      thinkMs: null,
      createdAt: BASE,
      interrupted: false,
    });
    const listed = await backend.listMessages(session.id);
    expect(listed).toHaveLength(2);
    const placeholder = listed[1];
    expect(placeholder?.role).toBe('assistant');
    expect(placeholder?.characterId).toBe(llmInstance?.id); // 占位回复由 LLM 位实例发声
    expect(placeholder?.content).toContain('mock');
    expect(placeholder?.reasoning).toBeTruthy();
    expect(placeholder?.thinkMs).toBe(800);
  });

  it('会话 updatedAt 刷新为用户条 createdAt', async () => {
    const { backend } = await loadMock();
    await backend.sendMessage(2, '推进剧情');
    const listed = await backend.listSessions();
    expect(listed[0]?.id).toBe(2); // 刷新后跃居列表首位
    expect(listed[0]?.updatedAt).toBe(BASE);
  });

  it('标题缺省回填：首条用户消息截断（≤20 字原样，>20 字补省略号）；已有标题不覆盖', async () => {
    const { backend } = await loadMock();
    const short = await backend.createSession(duo(1), null, null);
    await backend.sendMessage(short.id, '  你好，雨夜  ');
    expect((await backend.listSessions()).find((s) => s.id === short.id)?.title).toBe(
      '你好，雨夜',
    );

    const long = await backend.createSession(duo(1), null, null);
    await backend.sendMessage(long.id, '甲'.repeat(25));
    const longTitle = (await backend.listSessions()).find((s) => s.id === long.id)?.title;
    expect(longTitle).toBe(`${'甲'.repeat(20)}…`);

    await backend.sendMessage(1, '雨夜会话已有标题');
    expect((await backend.listSessions()).find((s) => s.id === 1)?.title).toBe('雨夜来电');
  });

  it('空白内容报 conflict「消息内容为空」（与 ipc.rs 文案一致）', async () => {
    const { backend } = await loadMock();
    expect(await apiErrorOf(backend.sendMessage(1, '   '))).toEqual({
      kind: 'conflict',
      message: '消息内容为空',
    });
  });

  it('会话不存在报 NotFound，且先于空内容校验（对齐 ipc.rs 检查顺序）', async () => {
    const { backend } = await loadMock();
    expect(await apiErrorOf(backend.sendMessage(999, ''))).toEqual({
      kind: 'notFound',
      entity: 'session',
      id: 999,
    });
  });
});

describe('流式事件通道（INT-001，mock 环境）', () => {
  it('纯浏览器 mock 无生成流：subscribeStream 返回 no-op 退订且不产生事件', async () => {
    await loadMock(); // 与后端同批重置，保证 jsdom 无 __TAURI_INTERNALS__
    const { subscribeStream } = await import('../events');
    const handler = vi.fn();
    const off = subscribeStream(1, handler);
    expect(typeof off).toBe('function');
    off();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('cancelGeneration（无活跃生成 = 幂等 no-op）', () => {
  it('mock 无异步生成闭环，恒返回 false（含不存在会话，对齐注册表语义）', async () => {
    const { backend } = await loadMock();
    expect(await backend.cancelGeneration(1)).toBe(false);
    expect(await backend.cancelGeneration(999)).toBe(false);
    expect(await backend.cancelGeneration(1)).toBe(false); // 幂等
  });
});

describe('regenerateLast（FR-008：软删旧条 + 新条从零演出）', () => {
  it('替换最后一条 assistant：新 id/内容/createdAt 原位落位，其余消息与会话 updated_at 同步', async () => {
    const { backend } = await loadMock();
    const before = await backend.listMessages(1); // 末条 assistant 为 id 4（interrupted）
    const old = await backend.regenerateLast(1);
    expect(old).toEqual(before[3]); // 返回被替换的旧条（见下一用例）

    const after = await backend.listMessages(1);
    expect(after).toHaveLength(4);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
    expect(after[2]).toEqual(before[2]);
    const replaced = after[3];
    expect(replaced?.id).toBe(7); // 新条拿新 id（旧条 4 退役）
    expect(replaced?.content).toContain('重新生成');
    expect(replaced?.reasoning).toBeTruthy();
    expect(replaced?.thinkMs).toBe(800);
    expect(replaced?.createdAt).toBe(BASE);
    expect(replaced?.interrupted).toBe(false);
    // 替换条继承原条的发声实例（会话 1 的 LLM 位实例 2）
    expect(replaced?.characterId).toBe(2);

    const session = (await backend.listSessions()).find((s) => s.id === 1);
    expect(session?.updatedAt).toBe(BASE); // 替换落库刷新 updated_at（ADR-001 单事务）
  });

  it('返回被替换的旧条（ipc.rs 契约：前端据以从界面移除）', async () => {
    const { backend } = await loadMock();
    const old = await backend.regenerateLast(1);
    expect(old.id).toBe(4);
    expect(old.content).toBe('其实我今晚本来想……');
    expect(old.interrupted).toBe(true);
  });

  it('无 assistant 条报 conflict；会话不存在报 NotFound', async () => {
    const { backend } = await loadMock();
    const fresh = await backend.createSession(duo(1), null, null);
    expect(await apiErrorOf(backend.regenerateLast(fresh.id))).toEqual({
      kind: 'conflict',
      message: '会话没有可重新生成的回复',
    });
    expect(await apiErrorOf(backend.regenerateLast(999))).toEqual({
      kind: 'notFound',
      entity: 'session',
      id: 999,
    });
  });
});

describe('角色 CRUD（FR-006，含 avatar / 元数据）', () => {
  it('createCharacter 回执全量字段、sessionCount 起始 0、id 不与种子冲突', async () => {
    const { backend } = await loadMock();
    const created = await backend.createCharacter(characterInput());
    expect(created.id).toBe(11); // 种子角色 id 最大 10
    expect(created.sessionCount).toBe(0);
    expect(created).toMatchObject({
      name: '测试角色',
      avatar: 'data:image/png;base64,AAA',
      persona: '雨夜电话亭的守夜人',
      gender: '女',
      age: '24',
      renderStyle: 'typewriter',
      modelConfig: '{"providerId":"p1","model":"m1"}',
      accentColor: '#5e2347',
      updatedAt: BASE,
    });
  });

  it('listCharacters 按 id 升序；sessionCount 统计读 is_user（按用户扮演位成员关系汇总，方案 §2.1）', async () => {
    const { backend } = await loadMock();
    const listed = await backend.listCharacters();
    expect(listed.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const byId = new Map(listed.map((c) => [c.id, c.sessionCount]));
    // 种子阵容：会话 1/2 用户位苏鸢（自演自）、会话 3 用户位苏鸢 → 苏鸢 3；
    // 林深只作为 LLM 位出现在会话 3 → 不计入（统计只读 is_user）。
    expect(byId.get(1)).toBe(3);
    expect(byId.get(2)).toBe(0);
    expect(byId.get(9)).toBe(0); // 种子字段写 12，但按用户位关系汇总应为 0
    // 新会话以卡 2 为用户位 → 林深计数 +1（LLM 位入选不涨）
    await backend.createSession(
      [
        { characterId: 2, isUser: true },
        { characterId: 1, isUser: false },
      ],
      null,
      null,
    );
    const refreshed = await backend.listCharacters();
    expect(refreshed.find((c) => c.id === 2)?.sessionCount).toBe(1);
    expect(refreshed.find((c) => c.id === 1)?.sessionCount).toBe(3);
  });

  it('updateCharacter 整卡覆盖：avatar / modelConfig 传 null 即清除；不存在报 NotFound', async () => {
    const { backend } = await loadMock();
    await backend.updateCharacter(
      2,
      characterInput({
        name: '林深（改）',
        avatar: null,
        modelConfig: null,
        renderStyle: 'ink',
      }),
    );
    const updated = (await backend.listCharacters()).find((c) => c.id === 2);
    expect(updated?.name).toBe('林深（改）');
    expect(updated?.avatar).toBeNull();
    expect(updated?.modelConfig).toBeNull();
    expect(updated?.accentColor).toBe('#5e2347');
    expect(updated?.updatedAt).toBe(BASE);

    expect(await apiErrorOf(backend.updateCharacter(999, characterInput()))).toEqual({
      kind: 'notFound',
      entity: 'character',
      id: 999,
    });
  });

  it('updateCharacter 携带历法整卡覆盖（FR-013）：落内存态折叠 snake_case 存储键；null = 清除', async () => {
    const { backend } = await loadMock();
    const calendar: CalendarConfigDto = {
      name: '星槎历',
      months: ['潮生月', '风信月'],
      daysPerMonth: 12,
      dayNames: ['潮日', '汐日', '星日'],
      festivals: { 2: '归潮祭' },
    };
    await backend.updateCharacter(2, characterInput({ calendarConfig: calendar }));
    const updated = (await backend.listCharacters()).find((c) => c.id === 2);
    // 与 Rust CharacterSummary wire 契约同构：calendarConfig 为存储 JSON 字符串透传；
    // 键形为 domain snake_case（ipc.rs update_character_impl 序列化 CalendarConfig 的
    // 形态；parseCalendarJson 等消费方按 days_per_month / day_names 读）。
    expect(typeof updated?.calendarConfig).toBe('string');
    const stored = JSON.parse(updated?.calendarConfig ?? '') as Record<string, unknown>;
    expect(stored).not.toHaveProperty('daysPerMonth');
    expect(stored).not.toHaveProperty('dayNames');
    expect(stored).toEqual({
      name: '星槎历',
      months: ['潮生月', '风信月'],
      days_per_month: 12,
      day_names: ['潮日', '汐日', '星日'],
      festivals: { 2: '归潮祭' },
    });

    // calendarConfig 传 null / 缺键 → 清除（整卡覆盖语义，对齐 Rust update_character_impl）。
    await backend.updateCharacter(2, characterInput({ name: '林深（再改）' }));
    const cleared = (await backend.listCharacters()).find((c) => c.id === 2);
    expect(cleared?.name).toBe('林深（再改）');
    expect(cleared?.calendarConfig).toBeNull();
  });

  it('deleteCharacter 从列表移除且不级联会话（OQ-002）；重复删除报 NotFound', async () => {
    const { backend } = await loadMock();
    await backend.deleteCharacter(1);
    expect((await backend.listCharacters()).map((c) => c.id)).not.toContain(1);
    // 不级联：角色 1 的在世会话保留（软删墓碑之下，ADR-009）
    expect((await backend.listSessions()).map((s) => s.id)).toEqual([1, 2, 3]);
    expect(await apiErrorOf(backend.deleteCharacter(1))).toEqual({
      kind: 'notFound',
      entity: 'character',
      id: 1,
    });
  });
});

describe('calendarConfigToStorageJson（wire DTO → 存储 JSON 键形折叠）', () => {
  it('逐键折叠为 domain snake_case 形态，与 ipc.rs update_character_impl 的 serde 序列化字节同构', async () => {
    const { backend } = await loadMock();
    expect(
      backend.calendarConfigToStorageJson({
        name: '星槎历',
        months: ['潮生月', '风信月'],
        daysPerMonth: 12,
        dayNames: ['潮日', '汐日', '星日'],
        festivals: { 2: '归潮祭' },
      }),
    ).toBe(
      '{"name":"星槎历","months":["潮生月","风信月"],"days_per_month":12,'
        + '"day_names":["潮日","汐日","星日"],"festivals":{"2":"归潮祭"}}',
    );
  });

  it('空缺位折叠：name null → null；festivals null → `{}`（unwrap_or_default 后 BTreeMap 恒序列化为对象）', async () => {
    const { backend } = await loadMock();
    expect(
      backend.calendarConfigToStorageJson({
        name: null,
        months: [],
        daysPerMonth: 30,
        dayNames: [],
        festivals: null,
      }),
    ).toBe('{"name":null,"months":[],"days_per_month":30,"day_names":[],"festivals":{}}');
  });
});

describe('config（FR-009 / ADR-012：往返 + 值域校验 + 防污染）', () => {
  it('默认配置与 Rust Config::new_with_defaults 一致（无文件 → 全默认）', async () => {
    const { backend } = await loadMock();
    expect(await backend.getConfig()).toEqual(configWith());
  });

  it('save → get 往返一致；读 / 写均深拷贝，改动返回值不污染内存基线', async () => {
    const { backend } = await loadMock();
    const next = configWith({
      providers: [
        {
          id: 'p1',
          name: '本地中转',
          baseUrl: 'https://example.invalid/v1',
          apiKey: 'sk-test',
          models: ['m1', 'm2'],
        },
      ],
      activeProviderId: 'p1',
      activeModel: 'm2',
      rhythmMsPerChar: 120,
      punctPauseEnabled: false,
      animDurationBase: 300,
      uiLanguage: 'en',
      uiTheme: 'dark',
      directorModel: 'm1',
      nearScenes: 3,
    });
    await backend.saveConfig(next);
    expect(await backend.getConfig()).toEqual(next);

    // 调用方改草稿 / 返回值不污染基线（cloneProviders 语义）
    next.providers[0]?.models.push('m3');
    next.rhythmMsPerChar = 10;
    const fresh = await backend.getConfig();
    expect(fresh.providers[0]?.models).toEqual(['m1', 'm2']);
    expect(fresh.rhythmMsPerChar).toBe(120);
    fresh.providers[0]?.models.push('m4');
    expect((await backend.getConfig()).providers[0]?.models).toEqual(['m1', 'm2']);
  });

  it('rhythm 越界报 config 错误（FR-009：10–160，边界值放行）', async () => {
    const { backend } = await loadMock();
    await backend.saveConfig(configWith({ rhythmMsPerChar: 10 }));
    await backend.saveConfig(configWith({ rhythmMsPerChar: 160 }));
    expect((await backend.getConfig()).rhythmMsPerChar).toBe(160);

    const payload = await apiErrorOf(backend.saveConfig(configWith({ rhythmMsPerChar: 999 })));
    expect(payload).toEqual({
      kind: 'config',
      message: 'rhythm_ms_per_char = 999 越界（允许 10–160）',
    });
    await expect(backend.saveConfig(configWith({ rhythmMsPerChar: 9 }))).rejects.toMatchObject({
      name: 'ApiError',
    });
    // 被拒的保存不落盘
    expect((await backend.getConfig()).rhythmMsPerChar).toBe(160);
  });

  it('nearScenes 越界报 config 错误（近景窗口可选化：1–6，边界值放行）', async () => {
    const { backend } = await loadMock();
    await backend.saveConfig(configWith({ nearScenes: 1 }));
    await backend.saveConfig(configWith({ nearScenes: 6 }));
    expect((await backend.getConfig()).nearScenes).toBe(6);

    // 错误文案与 Rust validate 同形（snake_case 键 + 允许区间）。
    const payload = await apiErrorOf(backend.saveConfig(configWith({ nearScenes: 7 })));
    expect(payload).toEqual({
      kind: 'config',
      message: 'near_scenes = 7 越界（允许 1–6）',
    });
    await expect(backend.saveConfig(configWith({ nearScenes: 0 }))).rejects.toMatchObject({
      name: 'ApiError',
    });
    // 被拒的保存不落盘
    expect((await backend.getConfig()).nearScenes).toBe(6);
  });
});

describe('mock/data.ts 种子（结构完整性）', () => {
  it('引用完整：阵容 is_user 恰好一、实例溯源在世角色、消息 characterId 属本会话阵容（user 条恒 null）、interrupted 只在 assistant 条', async () => {
    const { data } = await loadMock();
    const characterIds = new Set(data.characters.map((c) => c.id));
    const sessionIds = new Set(data.sessions.map((s) => s.id));
    expect(data.sessions.length).toBeGreaterThan(0);
    const instanceIdsBySession = new Map<number, Set<number>>();
    const allInstanceIds: number[] = [];
    for (const session of data.sessions) {
      // 阵容非空且 is_user 恰好一处 true（D2）；实例模板溯源指向在世卡（本切片无动态人物）
      const instances = session.instances;
      expect(instances.length).toBeGreaterThan(0);
      expect(instances.filter((i) => i.isUser)).toHaveLength(1);
      for (const instance of instances) {
        expect(
          instance.characterId !== null && characterIds.has(instance.characterId),
          `会话 ${session.id} 实例 ${instance.id} 的模板卡应在世`,
        ).toBe(true);
        allInstanceIds.push(instance.id);
      }
      instanceIdsBySession.set(session.id, new Set(instances.map((i) => i.id)));
    }
    // 实例 id 全局唯一（character_instances.id 为全局 PK）
    expect(new Set(allInstanceIds).size).toBe(allInstanceIds.length);
    for (const [key, messages] of Object.entries(data.messagesBySession)) {
      expect(sessionIds.has(Number(key)), `消息桶 ${key} 应指向在世会话`).toBe(true);
      const instanceIds = instanceIdsBySession.get(Number(key));
      for (const message of messages) {
        expect(message.sessionId).toBe(Number(key));
        if (message.role === 'user') {
          // wire 定案（ipc.rs to_chat_message）：user 条恒 null，不带实例 id
          expect(message.characterId, `用户条 ${message.id} 的 characterId 应为 null`).toBeNull();
        } else {
          expect(
            message.characterId !== null && instanceIds?.has(message.characterId),
            `消息 ${message.id} 的说话实例应属本会话阵容`,
          ).toBe(true);
        }
        if (message.interrupted) expect(message.role).toBe('assistant');
      }
    }
  });
});
