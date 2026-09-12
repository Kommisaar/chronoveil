/**
 * 纯浏览器 mock 后端（ADR-010）：与 Rust 命令面（ipc-command-whitelist）一一对应的
 * 内存实现，仅服务 `pnpm run dev`（无 Rust 工具链的界面开发）。数据种子见 `./data`。
 *
 * 语义对齐 Rust 侧：软删 = 从列表移除（mock 无墓碑）；sendMessage 只回执用户条并
 * 追加一条占位回复（真实生成闭环由 TASK-006 接线，mock 仅保界面演示完整）。
 * 错误形态对齐 wire 契约：统一抛 [`ApiError`]（payload 为 Rust IpcError 的可判别结构）。
 */

import type {
  CalendarConfigDto,
  CharacterInput,
  CharacterStateDto,
  CharacterSummary,
  ChatMessage,
  ConfigDto,
  MessageRole,
  SceneDto,
  SessionOpeningInput,
  SessionSummary,
  UpdateCharacterInput,
} from '../types';
import { ApiError } from '../errors';
import { characters, messagesBySession, sessions } from './data';

/** 与 Rust `Config::new_with_defaults`（FR-009；双层级 provider→models）一致的默认配置。 */
export const DEFAULT_CONFIG: ConfigDto = {
  providers: [],
  activeProviderId: null,
  activeModel: null,
  rhythmMsPerChar: 45,
  punctPauseEnabled: true,
  animDurationBase: 450,
  uiLanguage: 'zh',
  uiTheme: 'system',
  directorModel: null,
  nearScenes: 2, // ADR-004 默认近景窗口（config.near_scenes 缺键回落值）
};

let config: ConfigDto = { ...DEFAULT_CONFIG };

let nextSessionId = Math.max(...sessions.map((s) => s.id)) + 1;
let nextCharacterId = Math.max(...characters.map((c) => c.id)) + 1;
let nextMessageId =
  Math.max(...Object.values(messagesBySession).flat().map((m) => m.id)) + 1;

/** 与 Rust NotFound 等价（ADR-009：不存在 / 已软删对调用方等价）；entity 取 storage 层常量。 */
function notFound(entity: 'session' | 'character', id: number): ApiError {
  return new ApiError({ kind: 'notFound', entity, id });
}

function sessionOf(sessionId: number): SessionSummary {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) throw notFound('session', sessionId);
  return session;
}

function makeMessage(
  sessionId: number,
  characterId: number | null,
  role: MessageRole,
  content: string,
  reasoning: string | null = null,
  thinkMs: number | null = null,
  interrupted = false,
): ChatMessage {
  return {
    id: nextMessageId++,
    sessionId,
    characterId,
    role,
    content,
    reasoning,
    thinkMs,
    createdAt: Date.now(),
    interrupted,
  };
}

// ---- 会话（FR-007）----

export async function listSessions(): Promise<SessionSummary[]> {
  // 排序对齐 infra/storage/sessions.rs：ORDER BY updated_at DESC, id DESC。
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
}

/** 与 Rust `fiction_time::PARTS`（BR-003）一致的时段六值（FR-014 入参校验基准）。 */
const FIC_PARTS: readonly string[] = ['清晨', '上午', '午后', '黄昏', '夜', '深夜'];

export async function createSession(
  characterId: number,
  title?: string | null,
  opening?: SessionOpeningInput | null,
): Promise<SessionSummary> {
  if (!characters.some((c) => c.id === characterId)) {
    throw notFound('character', characterId);
  }
  // 开局入参校验对齐 Rust create_session_impl（FR-014）：时段六值、起始日 ≥ 1、
  // 显式日历需满足命名皮肤可用性（对齐 fiction_time::validate）。
  if (opening) {
    if (opening.ficPart !== null && !FIC_PARTS.includes(opening.ficPart)) {
      throw new ApiError({
        kind: 'conflict',
        message: `开局时段「${opening.ficPart}」不在六值内（${FIC_PARTS.join('/')}）`,
      });
    }
    if (opening.ficDay !== null && opening.ficDay < 1) {
      throw new ApiError({ kind: 'conflict', message: `开局「第 ${opening.ficDay} 天」需 ≥ 1` });
    }
    const calendar = opening.calendar;
    if (
      calendar !== null &&
      !(calendar.daysPerMonth > 0 && (calendar.months.length > 0 || calendar.dayNames.length > 0))
    ) {
      throw new ApiError({
        kind: 'conflict',
        message: '开局日历需每月天数 > 0 且月名 / 日名至少其一非空',
      });
    }
  }
  // opening 本身不入存储（mock 无 scenes 表），校验通过即视为建会话成功，保演示不破。
  const session: SessionSummary = {
    id: nextSessionId++,
    characterId,
    title: title ?? '',
    updatedAt: Date.now(),
  };
  sessions.push(session);
  return session;
}

export async function deleteSession(sessionId: number): Promise<void> {
  const index = sessions.findIndex((s) => s.id === sessionId);
  if (index < 0) throw notFound('session', sessionId);
  sessions.splice(index, 1);
  delete messagesBySession[sessionId];
}

// ---- AI 起草历法（FR-014 二期）----

/** mock 无真实 LLM：起草返回确定性的「白蜡历」样例（12 月 × 30 日 + 节日），供审阅流程演示。 */
function sampleDraftCalendar(): CalendarConfigDto {
  return {
    name: '白蜡历',
    months: [
      '白蜡月', '融雪月', '雨月', '长夏月', '蝉鸣月', '风起月',
      '收获月', '雾月', '炉火月', '冻雨月', '岁末月', '烬月',
    ],
    daysPerMonth: 30,
    dayNames: ['晨露日', '萤火日', '潮汐日', '风息日', '炉边日', '集日', '安息日'],
    festivals: { 45: '灯节', 360: '守夜' },
  };
}

/** 与 Rust `calendar_draft::MAX_DESCRIPTION_CHARS` 一致：按码点计的描述长度上限。 */
const DRAFT_MAX_CHARS = 4000;

export async function draftCalendar(description: string): Promise<CalendarConfigDto> {
  // 参数校验语义与文案对齐 services/calendar_draft（空白 / 超长拒绝，不发起调用）。
  const trimmed = description.trim();
  if (!trimmed) {
    throw new ApiError({ kind: 'conflict', message: '描述内容为空：请先填写世界观描述' });
  }
  const chars = Array.from(trimmed).length;
  if (chars > DRAFT_MAX_CHARS) {
    throw new ApiError({
      kind: 'conflict',
      message: `描述过长：${chars} 字符，上限 ${DRAFT_MAX_CHARS}，请精简后重试`,
    });
  }
  return sampleDraftCalendar();
}

// ---- 消息（ADR-001 读路径）----

export async function listMessages(sessionId: number): Promise<ChatMessage[]> {
  // 对齐 ipc.rs list_messages_impl：先取会话，不存在 / 已软删报 NotFound（而非空列表）。
  sessionOf(sessionId);
  return (messagesBySession[sessionId] ?? []).slice();
}

// ---- 场景与人物状态（FR-011 / FR-012 读路径）----

export async function listScenes(sessionId: number): Promise<SceneDto[]> {
  // 对齐 ipc.rs list_scenes_impl：先取会话，不存在 / 已软删报 NotFound（而非空列表）。
  sessionOf(sessionId);
  // mock 无 scenes 存储：诚实返回空数组，不伪造场景数据（面板演示数据由 UI 侧自行处理）。
  return [];
}

export async function listCharacterStates(sessionId: number): Promise<CharacterStateDto[]> {
  // 对齐 ipc.rs list_character_states_impl：同上，先会话在世校验。
  sessionOf(sessionId);
  // mock 无 character_state 存储：诚实返回空数组。
  return [];
}

/** 会话标题缺省值（FR-007）：与 Rust `generation::default_title` 一致——
 *  首条用户消息按码点截断到 20 字，截断时补省略号。 */
const TITLE_MAX_CHARS = 20;

function defaultTitle(content: string): string {
  const trimmed = content.trim();
  const chars = Array.from(trimmed);
  const truncated = chars.slice(0, TITLE_MAX_CHARS).join('');
  return chars.length > TITLE_MAX_CHARS ? `${truncated}…` : truncated;
}

export async function sendMessage(
  sessionId: number,
  content: string,
): Promise<ChatMessage> {
  // 检查顺序对齐 ipc.rs send_message_impl：先取会话（NotFound），再校验内容（Conflict）。
  const session = sessionOf(sessionId);
  const trimmed = content.trim();
  if (!trimmed) throw new ApiError({ kind: 'conflict', message: '消息内容为空' });
  const userMessage = makeMessage(sessionId, null, 'user', trimmed);
  ;(messagesBySession[sessionId] ??= []).push(userMessage);
  // 占位回复：mock 无真实生成；characterId 派生规则与命令层一致（assistant → 会话角色）。
  ;(messagesBySession[sessionId] ??= []).push(
    makeMessage(
      sessionId,
      session.characterId,
      'assistant',
      '（mock）这是纯浏览器演示回复，桌面壳内将流式生成。',
      'mock 思考：等待 TASK-006 接入真实生成闭环。',
      800,
    ),
  );
  // FR-007：标题缺省取首条用户消息截断（ipc.rs send_message_impl / default_title）。
  if (session.title === '') session.title = defaultTitle(trimmed);
  session.updatedAt = userMessage.createdAt;
  return userMessage;
}

// mock 无异步生成闭环 → 永远无活跃生成；对齐 Rust 注册表「无活跃生成 = 幂等 no-op」。
export async function cancelGeneration(_sessionId: number): Promise<boolean> {
  return false;
}

export async function regenerateLast(sessionId: number): Promise<ChatMessage> {
  const session = sessionOf(sessionId);
  const messages = messagesBySession[sessionId] ?? [];
  let target: ChatMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate && candidate.role === 'assistant') {
      target = candidate;
      break;
    }
  }
  if (!target) {
    throw new ApiError({ kind: 'conflict', message: '会话没有可重新生成的回复' });
  }
  const oldMessage: ChatMessage = { ...target };
  // FR-008：重新生成 = 软删旧条 + 新条从零演出（mock 无生成流，同步落地替换）。
  const replaced: ChatMessage = {
    ...target,
    id: nextMessageId++,
    content: '（mock）重新生成的回复，替换了最后一条 assistant 消息。',
    reasoning: 'mock 思考：FR-008 重新生成 = 软删旧条 + 插入新条。',
    thinkMs: 800,
    createdAt: Date.now(),
    interrupted: false,
  };
  messages[messages.indexOf(target)] = replaced;
  session.updatedAt = replaced.createdAt;
  // 契约对齐 ipc.rs regenerate_last_impl：返回被替换的旧条（前端据以从界面移除）。
  return oldMessage;
}

// ---- 角色 CRUD（FR-006，含 avatar）----

export async function listCharacters(): Promise<CharacterSummary[]> {
  return characters
    .map((c) => ({
      ...c,
      sessionCount: sessions.filter((s) => s.characterId === c.id).length,
    }))
    .sort((a, b) => a.id - b.id);
}

export async function createCharacter(
  input: CharacterInput,
): Promise<CharacterSummary> {
  const character: CharacterSummary = {
    id: nextCharacterId++,
    name: input.name,
    avatar: input.avatar,
    persona: input.persona,
    gender: input.gender,
    age: input.age,
    renderStyle: input.renderStyle,
    modelConfig: input.modelConfig,
    accentColor: input.accentColor,
    // 建卡不带历法（对齐 Rust CharacterInput）：FR-014 向导显式历法经 createSession
    // 回写角色卡，历法编辑走 updateCharacter（FR-013）。新建恒无。
    calendarConfig: null,
    updatedAt: Date.now(),
    sessionCount: 0,
  };
  characters.push(character);
  return character;
}

/**
 * wire DTO（camelCase）→ 存储 JSON 字符串（domain `CalendarConfig` 的 snake_case
 * serde 形态）：逐键对齐 Rust update_character_impl 的
 * `serde_json::to_string(&CalendarConfig::from(dto))`——name null → `"name":null`、
 * festivals null → `"festivals":{}`（unwrap_or_default 后 BTreeMap 恒序列化为对象）。
 * 存储消费方（parseCalendarJson / 开局向导「跟随角色卡」）按 snake_case 键读，
 * camelCase 直落会在回读时降级（月天数 / 日名丢失）。
 */
export function calendarConfigToStorageJson(calendar: CalendarConfigDto): string {
  return JSON.stringify({
    name: calendar.name,
    months: calendar.months,
    days_per_month: calendar.daysPerMonth,
    day_names: calendar.dayNames,
    festivals: calendar.festivals ?? {},
  });
}

export async function updateCharacter(
  id: number,
  input: UpdateCharacterInput,
): Promise<void> {
  const character = characters.find((c) => c.id === id);
  if (!character) throw notFound('character', id);
  character.name = input.name;
  character.avatar = input.avatar;
  character.persona = input.persona;
  character.gender = input.gender;
  character.age = input.age;
  character.renderStyle = input.renderStyle;
  character.modelConfig = input.modelConfig;
  character.accentColor = input.accentColor;
  // 历法整卡覆盖（FR-013，对齐 Rust update_character_impl）：DTO 折叠为 domain
  // snake_case 存储形态（calendarConfigToStorageJson；mock 生态契约见 data.ts 种子
  // 注释），CharacterSummary.calendarConfig 的 wire 契约是字符串透传；
  // null / 缺键 = 清除历法（回退内置默认历）。
  const calendar = input.calendarConfig ?? null;
  character.calendarConfig = calendar === null ? null : calendarConfigToStorageJson(calendar);
  character.updatedAt = Date.now();
}

// 软删对齐 Rust / ADR-009：仅从列表移除（mock 无墓碑），不级联——
// 历史会话与消息保留，聊天侧仍可查看（OQ-002 已消解，不做级联删除）。
export async function deleteCharacter(id: number): Promise<void> {
  const index = characters.findIndex((c) => c.id === id);
  if (index < 0) throw notFound('character', id);
  characters.splice(index, 1);
}

// ---- 角色卡导入/导出（Task-04；浏览器 dev 无原生对话框，走内存演示）----

/** 导入样例卡：与 Rust 卡文件里 character 对象同形（CharacterInput 形状）。 */
const SAMPLE_IMPORT: CharacterInput = {
  name: '织灯人·茉',
  avatar: null,
  persona: '提灯走巷的织灯匠，替人修补熄灭的旧灯，也顺路收集灯下没人认领的故事。',
  gender: '女',
  age: '不详',
  renderStyle: 'rise',
  modelConfig: null,
  accentColor: null,
  voiceConfig: null,
};

/** 导出 mock：不弹对话框，返回模拟路径串供界面演示（数据不变）。 */
export async function exportCharacter(id: number): Promise<string | null> {
  const character = characters.find((c) => c.id === id);
  // 不存在报 NotFound：对齐 Rust export_character_data（storage.get_character 的错误路径）。
  if (!character) throw notFound('character', id);
  return `~/Downloads/${character.name}.json`;
}

/** 导入 mock：不弹对话框，从内置样例卡经 createCharacter 既有路径建新卡。 */
export async function importCharacter(): Promise<CharacterSummary | null> {
  return createCharacter({ ...SAMPLE_IMPORT });
}

// ---- 配置（FR-009 / ADR-012；双层级 provider→models）----

/** providers 逐项浅拷 + models 数组拷贝：调用方改返回值/草稿不污染内存基线。 */
function cloneProviders(providers: ConfigDto['providers']): ConfigDto['providers'] {
  return providers.map((p) => ({ ...p, models: [...p.models] }));
}

export async function getConfig(): Promise<ConfigDto> {
  return { ...config, providers: cloneProviders(config.providers) };
}

export async function saveConfig(next: ConfigDto): Promise<void> {
  // 值域对齐 infra/config.rs validate（FR-009：10–160），错误形态对齐 IpcError::Config。
  if (next.rhythmMsPerChar < 10 || next.rhythmMsPerChar > 160) {
    throw new ApiError({
      kind: 'config',
      message: `rhythm_ms_per_char = ${next.rhythmMsPerChar} 越界（允许 10–160）`,
    });
  }
  // 近景场景数（近景窗口可选化）：对齐 infra/config.rs validate（1–6，拒绝不钳边）。
  if (next.nearScenes < 1 || next.nearScenes > 6) {
    throw new ApiError({
      kind: 'config',
      message: `near_scenes = ${next.nearScenes} 越界（允许 1–6）`,
    });
  }
  config = { ...next, providers: cloneProviders(next.providers) };
}
