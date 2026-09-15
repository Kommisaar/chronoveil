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
  CharacterInput,
  CharacterStateDto,
  CharacterSummary,
  ChatMessage,
  ConfigDto,
  LlmCallDto,
  SceneDto,
  SessionOpeningInput,
  SessionRosterMember,
  SessionSummary,
  WorldInput,
  WorldSummary,
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
 * 新建会话（FR-007 / FR-014 开局向导，多角色阵容制）：`worldId` = 必选世界卡
 * （0017 起会话必有世界，后端事务内实例化为恰一世界实例，历法 / 世界观随会话
 * 冻结）；`members` = 会话阵容（恰好一个用户扮演位，D2），后端逐卡实例化快照
 * （D1）并经返回值 / 列表回显 instances；`title` 缺省（null）由后端取首条用户
 * 消息截断回填（FR-007），向导本切片不收集标题恒传 null；`opening` 缺省或
 * null = 降级路径——后端同样无条件 seed 默认锚开场行（day=1 / part=夜 / 日历走
 * 世界实例快照，§7-6）。
 */
export async function createSession(
  worldId: number,
  members: SessionRosterMember[],
  title: string | null,
  opening?: SessionOpeningInput | null,
): Promise<SessionSummary> {
  return isTauri
    ? unwrap(commands.createSession(worldId, members, title, opening ?? null))
    : mock.createSession(worldId, members, title, opening);
}

export async function deleteSession(sessionId: number): Promise<void> {
  if (isTauri) {
    await unwrap(commands.deleteSession(sessionId));
    return;
  }
  return mock.deleteSession(sessionId);
}

/**
 * 分叉会话（时间线分叉，Task-44 冻结契约）：从源会话 `anchorSceneIdx` 场分叉新
 * 会话（含锚点场及其之前的消息 / 状态），返回新会话摘要（含分叉溯源回显字段）。
 * 调用方成功后走 `refreshSessions` 单点重拉并选中新会话（会话清单纪律）。
 * 锚点场号不存在 → NotFound(scene)；源会话不存在 / 已删 → NotFound(session)。
 * 桌面壳为真实分叉（Task-45 接线，按锚点裁剪消息 / 状态）；纯浏览器 mock 无场景
 * 时间线，拷贝全量消息历史（行为差异属 mock 诚实缺省）。
 */
export async function forkSession(
  sessionId: number,
  anchorSceneIdx: number,
  title: string,
): Promise<SessionSummary> {
  return isTauri
    ? unwrap(commands.forkSession(sessionId, anchorSceneIdx, title))
    : mock.forkSession(sessionId, anchorSceneIdx, title);
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

/**
 * 手动清除人物状态（FR-012，Task-09）：软删该状态行（ADR-009 墓碑），行立即从
 * 账本消失；清除过的键不进后续结算 prompt 的【当前状态集】，结算清算对其幂等
 * 跳过（不复活）。行不存在 / 已清除报 NotFound（重复点击对调用方等价）。
 */
export async function clearCharacterState(stateId: number): Promise<void> {
  if (isTauri) {
    await unwrap(commands.clearCharacterState(stateId));
    return;
  }
  return mock.clearCharacterState(stateId);
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
 * 更新角色卡（FR-006 整卡覆盖）：入参与新建共用 CharacterInput 负载形态。
 */
export async function updateCharacter(id: number, input: CharacterInput): Promise<void> {
  if (isTauri) {
    await unwrap(commands.updateCharacter(id, input));
    return;
  }
  return mock.updateCharacter(id, input);
}

export async function deleteCharacter(id: number): Promise<void> {
  if (isTauri) {
    await unwrap(commands.deleteCharacter(id));
    return;
  }
  return mock.deleteCharacter(id);
}

// ---- 世界卡（2026-09-15 世界卡定稿：世界观资产 CRUD）----

export async function listWorlds(): Promise<WorldSummary[]> {
  return isTauri ? unwrap(commands.listWorlds()) : mock.listWorlds();
}

export async function createWorld(input: WorldInput): Promise<WorldSummary> {
  return isTauri ? unwrap(commands.createWorld(input)) : mock.createWorld(input);
}

export async function updateWorld(id: number, input: WorldInput): Promise<void> {
  if (isTauri) {
    await unwrap(commands.updateWorld(id, input));
    return;
  }
  return mock.updateWorld(id, input);
}

export async function deleteWorld(id: number): Promise<void> {
  if (isTauri) {
    await unwrap(commands.deleteWorld(id));
    return;
  }
  return mock.deleteWorld(id);
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
