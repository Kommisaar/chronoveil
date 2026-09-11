/**
 * mock 后端契约对齐测试（ADR-010 双模式）：以 src-tauri/src/interfaces/ipc.rs 的
 * Rust 命令语义为参照，逐命令断言纯浏览器 mock（src/api/mock/backend.ts）行为同契约：
 * - 会话：软删后不再出现、重复删除 NotFound、列表 updated_at DESC + id DESC
 *   （infra/storage/sessions.rs 的 ORDER BY）；
 * - 消息：先取会话（不存在 / 已删 → NotFound）、user 条 speaker 为 null、
 *   assistant 条派生为会话角色；
 * - 场景 / 人物状态列表（FR-011 / FR-012）：mock 无存储诚实返回空数组、
 *   会话不存在 / 已软删 → NotFound；
 * - 发送：检查顺序（先会话后内容）、只回执用户条 + mock 占位回复、FR-007 标题
 *   缺省取首条用户消息截断（generation::default_title：20 字 + 省略号）；
 * - 重新生成：返回被替换的旧条（ipc.rs regenerate_last_impl 契约，前端据以移除）；
 * - 取消：无活跃生成恒 false（幂等 no-op）；mock 无事件流（subscribeStream no-op）；
 * - 角色 CRUD / config 往返与 10–160 值域校验（FR-006 / FR-009）；
 * - 错误形态：统一 ApiError，payload.kind 判别值与 Rust IpcError wire 形态一致。
 *
 * mock 模块持有内存态（data.ts 种子 + 游标），每个用例经 vi.resetModules 重新载入，
 * 互不污染；时间经 fake timers 冻结，使 createdAt / updatedAt 断言确定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterInput, ConfigDto, SessionOpeningInput } from '../types';

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

function characterInput(overrides: Partial<CharacterInput> = {}): CharacterInput {
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
    ...overrides,
  };
}

describe('listSessions（FR-007 排序 / 软删过滤）', () => {
  it('按 updatedAt 倒序；同刻并列按 id 倒序（sessions.rs ORDER BY updated_at DESC, id DESC）', async () => {
    const { backend } = await loadMock();
    expect((await backend.listSessions()).map((s) => s.id)).toEqual([1, 2, 3]);
    // 冻结时钟下新建的两条 updatedAt 相同 → id 大者在前
    await backend.createSession(1, '甲');
    await backend.createSession(1, '乙');
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

describe('createSession（FR-007）', () => {
  it('缺省标题为空串、显式标题原样保留、id 自增不与种子冲突', async () => {
    const { backend } = await loadMock();
    const untitled = await backend.createSession(1, null);
    expect(untitled).toEqual({ id: 4, characterId: 1, title: '', updatedAt: BASE });
    const titled = await backend.createSession(2, '自定义标题');
    expect(titled.id).toBe(5);
    expect(titled.title).toBe('自定义标题');
  });

  it('角色不存在报 NotFound（而非裸外键冲突，ipc.rs create_session_impl）', async () => {
    const { backend } = await loadMock();
    const payload = await apiErrorOf(backend.createSession(999, null));
    expect(payload).toEqual({ kind: 'notFound', entity: 'character', id: 999 });
    // 错误文案与 Rust IpcError::NotFound 的 Display 一致（ApiError.describe）
    await expect(backend.createSession(999, null)).rejects.toMatchObject({
      message: 'character #999 不存在（或已软删除）',
    });
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

  it('三参化：带合法开局包照常建会话（mock 不入存储），opening = null（直接开始）等价降级', async () => {
    const { backend } = await loadMock();
    const withOpening = await backend.createSession(1, null, opening());
    expect(withOpening.id).toBe(4);
    const degraded = await backend.createSession(1, null, null);
    expect(degraded.id).toBe(5);
  });

  it('时段不在六值内报 conflict（fiction_time::PARTS 六值为校验基准）', async () => {
    const { backend } = await loadMock();
    const payload = await apiErrorOf(
      backend.createSession(1, null, opening({ ficPart: '半夜三更' })),
    );
    expect(payload.kind).toBe('conflict');
    // 六值边界逐一放行
    for (const part of ['清晨', '上午', '午后', '黄昏', '夜', '深夜']) {
      await backend.createSession(1, null, opening({ ficPart: part }));
    }
  });

  it('起始日 < 1 报 conflict；显式日历缺月长基准 / 月日名全空报 conflict，合法日历放行', async () => {
    const { backend } = await loadMock();
    expect(
      (await apiErrorOf(backend.createSession(1, null, opening({ ficDay: 0 })))).kind,
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
          backend.createSession(1, null, opening({ calendar: badCalendar, ficDay: null })),
        )
      ).kind,
    ).toBe('conflict');

    await backend.createSession(1, null, opening({ ficDay: 45, ficPart: '夜', calendar: {
      name: '旧都历',
      months: ['霜月', '白蜡月'],
      daysPerMonth: 30,
      dayNames: ['晨露日', '萤火日'],
      festivals: { 45: '灯节' },
    } }));
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
  it('返回种子消息（id 升序）；user 条 characterId 为 null，assistant 条派生为会话角色', async () => {
    const { backend } = await loadMock();
    const messages = await backend.listMessages(1);
    expect(messages.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(messages.map((m) => m.role)).toEqual([
      'assistant',
      'user',
      'assistant',
      'assistant',
    ]);
    expect(messages[1]?.characterId).toBeNull();
    expect(messages[0]?.characterId).toBe(1);
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
    const fresh = await backend.createSession(1, null);
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

describe('sendMessage（SEQ-001 回执 / FR-007 标题回填）', () => {
  it('回执用户条（trim、speaker null、正数 id）并追加 mock 占位回复（演示闭环）', async () => {
    const { backend } = await loadMock();
    const session = await backend.createSession(1, null);
    const user = await backend.sendMessage(session.id, '  你好，雨夜  ');
    expect(user).toEqual({
      id: 7, // 种子消息 id 最大 6，游标不冲突
      sessionId: session.id,
      characterId: null,
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
    expect(placeholder?.characterId).toBe(1); // 占位回复派生为会话角色
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
    const short = await backend.createSession(1, null);
    await backend.sendMessage(short.id, '  你好，雨夜  ');
    expect((await backend.listSessions()).find((s) => s.id === short.id)?.title).toBe(
      '你好，雨夜',
    );

    const long = await backend.createSession(1, null);
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
    expect(replaced?.characterId).toBe(1);

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
    const fresh = await backend.createSession(1, null);
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

  it('listCharacters 按 id 升序；sessionCount 按在世会话重新汇总（种子装饰值不生效）', async () => {
    const { backend } = await loadMock();
    const listed = await backend.listCharacters();
    expect(listed.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const byId = new Map(listed.map((c) => [c.id, c.sessionCount]));
    expect(byId.get(1)).toBe(2); // 会话 1、2
    expect(byId.get(2)).toBe(1); // 会话 3
    expect(byId.get(9)).toBe(0); // 种子字段写 12，但按关系汇总应为 0
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
});

describe('mock/data.ts 种子（结构完整性）', () => {
  it('引用完整：会话指向在世角色、消息归属会话、interrupted 只出现在 assistant 条', async () => {
    const { data } = await loadMock();
    const characterIds = new Set(data.characters.map((c) => c.id));
    const sessionIds = new Set(data.sessions.map((s) => s.id));
    expect(data.sessions.length).toBeGreaterThan(0);
    for (const session of data.sessions) {
      expect(characterIds.has(session.characterId), `会话 ${session.id} 的角色应存在`).toBe(
        true,
      );
    }
    for (const [key, messages] of Object.entries(data.messagesBySession)) {
      expect(sessionIds.has(Number(key)), `消息桶 ${key} 应指向在世会话`).toBe(true);
      for (const message of messages) {
        expect(message.sessionId).toBe(Number(key));
        if (message.interrupted) expect(message.role).toBe('assistant');
      }
    }
  });
});
