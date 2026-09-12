/**
 * 命令封装（ADR-010：invoke 唯一入口在 src/api/）。
 *
 * 双模式（验收 3）：
 * - Tauri 壳内（`isTauri`）→ tauri-specta 生成的 `commands.*`（类型同源，来自
 *   `./generated/bindings.ts`，命令名登记于 config/ipc-command-whitelist.json）；
 * - 纯浏览器（`pnpm run dev`）→ `./mock/backend` 内存实现。
 *
 * 约定：签名保持稳定，切换实现时调用方不动。命令错误统一解包为 [`ApiError`]
 * （定义于 `./errors`，携带可判别的 `payload: IpcError`），调用方 `catch` 后读
 * `payload.kind` 分型。
 */

import { commands, type IpcError, type Result } from './generated/bindings';
import { isTauri } from './client';
import { ApiError } from './errors';
import * as mock from './mock/backend';
import type {
  CalendarConfigDto,
  CharacterInput,
  CharacterStateDto,
  CharacterSummary,
  ChatMessage,
  ConfigDto,
  LlmCallDto,
  SceneDto,
  SessionOpeningInput,
  SessionSummary,
  UpdateCharacterInput,
} from './types';

async function unwrap<T>(promise: Promise<Result<T, IpcError>>): Promise<T> {
  const outcome = await promise;
  if (outcome.status === 'error') throw new ApiError(outcome.error);
  return outcome.data;
}

// ---- 会话（FR-007）----

export async function listSessions(): Promise<SessionSummary[]> {
  return isTauri ? unwrap(commands.listSessions()) : mock.listSessions();
}

/**
 * 新建会话（FR-007 / FR-014 开局包）：`opening` 缺省或 null = 降级路径——
 * 后端同样无条件 seed 默认锚开场行（day=1 / part=夜 / 日历走角色卡快照）。
 */
export async function createSession(
  characterId: number,
  title?: string | null,
  opening?: SessionOpeningInput | null,
): Promise<SessionSummary> {
  return isTauri
    ? unwrap(commands.createSession(characterId, title ?? null, opening ?? null))
    : mock.createSession(characterId, title, opening);
}

export async function deleteSession(sessionId: number): Promise<void> {
  if (isTauri) {
    await unwrap(commands.deleteSession(sessionId));
    return;
  }
  return mock.deleteSession(sessionId);
}

/**
 * AI 起草历法（FR-014 二期）：按世界观描述起草自定义历法，返回给调用方审阅后
 * 由用户走既有保存路径——本命令不做持久化、不自动应用。空白 / 超长（> 4000 字符）
 * 描述报 conflict；provider 未配置报 config；LLM 调用失败报 unavailable。
 */
export async function draftCalendar(description: string): Promise<CalendarConfigDto> {
  return isTauri ? unwrap(commands.draftCalendar(description)) : mock.draftCalendar(description);
}

// ---- 消息（ADR-001）----

export async function listMessages(sessionId: number): Promise<ChatMessage[]> {
  return isTauri ? unwrap(commands.listMessages(sessionId)) : mock.listMessages(sessionId);
}

// ---- 场景与人物状态（FR-011 / FR-012 读路径：叙事账本面板数据地基）----

/** 会话内场景（FR-011）：按 idx 升序（叙事顺序）的在世行；会话不存在 / 已软删报 NotFound。 */
export async function listScenes(sessionId: number): Promise<SceneDto[]> {
  return isTauri ? unwrap(commands.listScenes(sessionId)) : mock.listScenes(sessionId);
}

/** 会话内人物状态（FR-012）：按 id 升序的在世行；会话不存在 / 已软删报 NotFound。 */
export async function listCharacterStates(sessionId: number): Promise<CharacterStateDto[]> {
  return isTauri
    ? unwrap(commands.listCharacterStates(sessionId))
    : mock.listCharacterStates(sessionId);
}

// ---- LLM 调用轨迹（透明化功能）----

/**
 * 会话内 LLM 调用轨迹（透明化功能）：按 id 倒序（最新在前）；会话不存在 / 已软删
 * 报 NotFound。`limit` 缺省 = 后端默认截断（最新 200 条）。`promptJson` /
 * `toolCallsJson` 为 string 透传，消费方自行 `JSON.parse`。
 */
export async function listLlmCalls(sessionId: number, limit?: number): Promise<LlmCallDto[]> {
  return isTauri
    ? unwrap(commands.listLlmCalls(sessionId, limit ?? null))
    : mock.listLlmCalls(sessionId, limit);
}

// ---- 生成（TASK-006 已接线：send / regenerate 走真实生成闭环，进度经事件流推送；
//      无活跃生成时 cancel 为幂等 no-op）----

export async function sendMessage(
  sessionId: number,
  content: string,
): Promise<ChatMessage> {
  return isTauri
    ? unwrap(commands.sendMessage(sessionId, content))
    : mock.sendMessage(sessionId, content);
}

/** 取消当前会话的进行中生成；无进行中生成时为幂等 no-op（返回 false）。 */
export async function cancelGeneration(sessionId: number): Promise<boolean> {
  return isTauri
    ? unwrap(commands.cancelGeneration(sessionId))
    : mock.cancelGeneration(sessionId);
}

export async function regenerateLast(sessionId: number): Promise<ChatMessage> {
  return isTauri
    ? unwrap(commands.regenerateLast(sessionId))
    : mock.regenerateLast(sessionId);
}

// ---- 角色 CRUD（FR-006，含 avatar）----

export async function listCharacters(): Promise<CharacterSummary[]> {
  return isTauri ? unwrap(commands.listCharacters()) : mock.listCharacters();
}

export async function createCharacter(
  input: CharacterInput,
): Promise<CharacterSummary> {
  return isTauri ? unwrap(commands.createCharacter(input)) : mock.createCharacter(input);
}

/**
 * 更新角色卡（FR-006 / FR-013 整卡覆盖）。入参在 CharacterInput 基础上接受可选
 * `calendarConfig`（历法编辑，Task-17 buildInput 契约）；此处把缺键归一为 null
 * （= 清除历法，与 Rust 侧 serde Option 缺省同语义），兼容尚未携带该键的调用方。
 */
export async function updateCharacter(
  id: number,
  input: CharacterInput & { calendarConfig?: UpdateCharacterInput['calendarConfig'] },
): Promise<void> {
  const payload: UpdateCharacterInput = {
    ...input,
    calendarConfig: input.calendarConfig ?? null,
  };
  if (isTauri) {
    await unwrap(commands.updateCharacter(id, payload));
    return;
  }
  return mock.updateCharacter(id, payload);
}

export async function deleteCharacter(id: number): Promise<void> {
  if (isTauri) {
    await unwrap(commands.deleteCharacter(id));
    return;
  }
  return mock.deleteCharacter(id);
}

// ---- 角色卡导入/导出（Task-04；对话框由 Rust 侧原生弹出）----

/**
 * 导出角色卡：Rust 侧弹「保存文件」对话框（默认文件名 `<角色名>.json`）并写出
 * 卡 JSON。用户取消返回 null；成功返回写出的文件路径。
 */
export async function exportCharacter(id: number): Promise<string | null> {
  return isTauri ? unwrap(commands.exportCharacter(id)) : mock.exportCharacter(id);
}

/**
 * 导入角色卡：Rust 侧弹「打开文件」对话框，解析校验后经 create_character
 * 既有路径建新卡（新 id、允许重名）。用户取消返回 null；成功返回新卡摘要。
 */
export async function importCharacter(): Promise<CharacterSummary | null> {
  return isTauri ? unwrap(commands.importCharacter()) : mock.importCharacter();
}

// ---- 配置（FR-009 / ADR-012）----

export async function getConfig(): Promise<ConfigDto> {
  return isTauri ? unwrap(commands.getConfig()) : mock.getConfig();
}

export async function saveConfig(config: ConfigDto): Promise<void> {
  if (isTauri) {
    await unwrap(commands.saveConfig(config));
    return;
  }
  return mock.saveConfig(config);
}
