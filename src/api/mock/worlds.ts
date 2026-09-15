/**
 * 世界域 mock（2026-09-15 世界卡定稿）：从 backend.ts 拆出的分域实现——照
 * config.ts 分域先例，经 backend.ts 原路径再导出，调用方（api/commands.ts 的
 * `mock.listWorlds` 等）与测试 import 均不变。种子见 ./data 的 SEED_WORLDS。
 *
 * 语义对齐 Rust interfaces/ipc/worlds.rs：名称非空白、显式历法需满足命名皮肤
 * 可用性（每月天数 > 0 且月名 / 日名至少其一非空），错误形态 Conflict。
 * 软删 = 从列表移除（mock 无墓碑，同 characters 口径）。
 *
 * 会话世界实例（world_instances 对应物）：mock 无生成 / 结算消费端，实例快照
 * 只服务 fork 继承与后续「会话设定」接线的正确性，纯 mock 内部结构不经 wire。
 */

import type { CalendarConfigDto, WorldInput, WorldSummary } from '../types';
import { ApiError } from '../errors';
import { SEED_WORLDS } from './data';

/** 世界卡内存态（种子浅拷隔离：改返回值不污染基线，历法对象深拷）。 */
let worlds: WorldSummary[] = SEED_WORLDS.map((w) => ({ ...w, calendar: cloneCalendar(w.calendar) }));

let nextWorldId = Math.max(...worlds.map((w) => w.id)) + 1;

/** 会话世界实例（mock 内部形态 = WorldSummary 的快照字段面 + 溯源）。 */
interface WorldInstance {
  worldId: number;
  name: string;
  worldbook: string;
  calendar: CalendarConfigDto | null;
}

const instancesBySession = new Map<number, WorldInstance>();

function cloneCalendar(calendar: CalendarConfigDto | null): CalendarConfigDto | null {
  return calendar === null
    ? null
    : {
        name: calendar.name,
        months: [...calendar.months],
        daysPerMonth: calendar.daysPerMonth,
        dayNames: [...calendar.dayNames],
        festivals: calendar.festivals === null ? null : { ...calendar.festivals },
      };
}

function conflict(message: string): ApiError {
  return new ApiError({ kind: 'conflict', message });
}

/** 入口校验 + 规范化，对齐 Rust WorldInput::validate / into_new_world。 */
function validated(input: WorldInput): WorldSummary {
  if (input.name.trim() === '') throw conflict('名称不能为空白');
  if (
    input.calendar !== null &&
    !(input.calendar.daysPerMonth > 0 && (input.calendar.months.length > 0 || input.calendar.dayNames.length > 0))
  ) {
    throw conflict('历法需每月天数 > 0 且月名 / 日名至少其一非空');
  }
  return {
    id: 0,
    name: input.name,
    worldbook: input.worldbook,
    calendar: cloneCalendar(input.calendar),
    updatedAt: 0,
  };
}

export async function listWorlds(): Promise<WorldSummary[]> {
  return worlds.map((w) => ({ ...w, calendar: cloneCalendar(w.calendar) }));
}

export async function createWorld(input: WorldInput): Promise<WorldSummary> {
  const world = { ...validated(input), id: nextWorldId++, updatedAt: Date.now() };
  worlds.push(world);
  return { ...world, calendar: cloneCalendar(world.calendar) };
}

export async function updateWorld(id: number, input: WorldInput): Promise<void> {
  const index = worlds.findIndex((w) => w.id === id);
  if (index < 0) {
    throw new ApiError({ kind: 'notFound', entity: 'world', id });
  }
  worlds[index] = { ...validated(input), id, updatedAt: Date.now() };
}

export async function deleteWorld(id: number): Promise<void> {
  const index = worlds.findIndex((w) => w.id === id);
  if (index < 0) {
    throw new ApiError({ kind: 'notFound', entity: 'world', id });
  }
  worlds.splice(index, 1);
}

// ---- 会话世界实例（backend.ts createSession / forkSession 消费）----

/** 取在世世界卡（建会话校验用）；不存在 / 已软删 = NotFound（ADR-009 语义）。 */
export function worldOf(worldId: number): WorldSummary {
  const world = worlds.find((w) => w.id === worldId);
  if (!world) throw new ApiError({ kind: 'notFound', entity: 'world', id: worldId });
  return world;
}

/** 建会话事务的世界实例化半（D1 快照：值拷贝，改卡不回写）。 */
export function attachSessionWorld(sessionId: number, worldId: number): void {
  const world = worldOf(worldId);
  instancesBySession.set(sessionId, {
    worldId: world.id,
    name: world.name,
    worldbook: world.worldbook,
    calendar: cloneCalendar(world.calendar),
  });
}

/** 分叉继承源线世界（值拷贝到新会话，对齐 session_fork 的 1b 步）。 */
export function copySessionWorld(fromSessionId: number, toSessionId: number): void {
  const source = instancesBySession.get(fromSessionId);
  if (!source) return;
  instancesBySession.set(toSessionId, {
    worldId: source.worldId,
    name: source.name,
    worldbook: source.worldbook,
    calendar: cloneCalendar(source.calendar),
  });
}
