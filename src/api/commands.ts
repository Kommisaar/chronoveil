import type { CharacterSummary, ChatMessage, SessionSummary } from './types';
import { characters, messagesBySession, sessions } from './mock/data';

/**
 * 命令封装（当前全部走 mock；阶段 3 起改为 invoke + ipc-command-whitelist 登记）。
 * 约定：签名保持稳定，切换实现时调用方不动。
 */

export async function listSessions(): Promise<SessionSummary[]> {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listMessages(sessionId: number): Promise<ChatMessage[]> {
  return (messagesBySession[sessionId] ?? []).slice();
}

export async function listCharacters(): Promise<CharacterSummary[]> {
  return characters.slice();
}
