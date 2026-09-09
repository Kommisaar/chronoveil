/**
 * 纯浏览器 mock 后端（ADR-010）：与 Rust 命令面（ipc-command-whitelist）一一对应的
 * 内存实现，仅服务 `pnpm run dev`（无 Rust 工具链的界面开发）。数据种子见 `./data`。
 *
 * 语义对齐 Rust 侧：软删 = 从列表移除（mock 无墓碑）；sendMessage 只回执用户条并
 * 追加一条占位回复（真实生成闭环由 TASK-006 接线，mock 仅保界面演示完整）。
 */

import type {
  CharacterInput,
  CharacterSummary,
  ChatMessage,
  ConfigDto,
  MessageRole,
  SessionSummary,
} from '../types';
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
};

let config: ConfigDto = { ...DEFAULT_CONFIG };

let nextSessionId = Math.max(...sessions.map((s) => s.id)) + 1;
let nextCharacterId = Math.max(...characters.map((c) => c.id)) + 1;
let nextMessageId =
  Math.max(...Object.values(messagesBySession).flat().map((m) => m.id)) + 1;

class MockError extends Error {}

function sessionOf(sessionId: number): SessionSummary {
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) throw new MockError(`会话 #${sessionId} 不存在`);
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
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createSession(
  characterId: number,
  title?: string | null,
): Promise<SessionSummary> {
  if (!characters.some((c) => c.id === characterId)) {
    throw new MockError(`角色 #${characterId} 不存在`);
  }
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
  if (index < 0) throw new MockError(`会话 #${sessionId} 不存在`);
  sessions.splice(index, 1);
  delete messagesBySession[sessionId];
}

// ---- 消息（ADR-001 读路径）----

export async function listMessages(sessionId: number): Promise<ChatMessage[]> {
  return (messagesBySession[sessionId] ?? []).slice();
}

export async function sendMessage(
  sessionId: number,
  content: string,
): Promise<ChatMessage> {
  const trimmed = content.trim();
  if (!trimmed) throw new MockError('消息内容为空');
  const session = sessionOf(sessionId);
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
  session.updatedAt = userMessage.createdAt;
  return userMessage;
}

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
  if (!target) throw new MockError(`会话 #${sessionId} 没有可重新生成的回复`);
  const replaced: ChatMessage = {
    ...target,
    id: nextMessageId++,
    content: '（mock）重新生成的回复，替换了最后一条 assistant 消息。',
    reasoning: 'mock 思考：FR-008 重新生成 = 软删旧条 + 插入新条。',
    interrupted: false,
  };
  messages[messages.indexOf(target)] = replaced;
  session.updatedAt = replaced.createdAt;
  return replaced;
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
    renderStyle: input.renderStyle,
    greeting: input.greeting,
    modelConfig: input.modelConfig,
    accentColor: input.accentColor,
    updatedAt: Date.now(),
    sessionCount: 0,
  };
  characters.push(character);
  return character;
}

export async function updateCharacter(
  id: number,
  input: CharacterInput,
): Promise<void> {
  const character = characters.find((c) => c.id === id);
  if (!character) throw new MockError(`角色 #${id} 不存在`);
  character.name = input.name;
  character.avatar = input.avatar;
  character.persona = input.persona;
  character.renderStyle = input.renderStyle;
  character.greeting = input.greeting;
  character.modelConfig = input.modelConfig;
  character.accentColor = input.accentColor;
  character.updatedAt = Date.now();
}

// 软删对齐 Rust / ADR-009：仅从列表移除（mock 无墓碑），不级联——
// 历史会话与消息保留，聊天侧仍可查看（OQ-002 已消解，不做级联删除）。
export async function deleteCharacter(id: number): Promise<void> {
  const index = characters.findIndex((c) => c.id === id);
  if (index < 0) throw new MockError(`角色 #${id} 不存在`);
  characters.splice(index, 1);
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
  if (next.rhythmMsPerChar < 10 || next.rhythmMsPerChar > 160) {
    throw new MockError('rhythmMsPerChar 越界（允许 10–160）');
  }
  config = { ...next, providers: cloneProviders(next.providers) };
}
