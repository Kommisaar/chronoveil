import type { CharacterSummary, ChatMessage } from '../types';

/** mock 数据：纯浏览器开发用（ADR-010）；结构与 SQLite 三表对应（data_model）。 */

const now = Date.now();
const min = 60_000;

export const characters: CharacterSummary[] = [
  {
    id: 1,
    name: '苏鸢',
    avatar: null,
    renderStyle: 'typewriter',
    greeting: '雨点敲着窗棂，我数到第七声的时候，电话响了。',
    updatedAt: now - 3 * min,
    sessionCount: 2,
  },
  {
    id: 2,
    name: '林深',
    avatar: null,
    renderStyle: 'ink-bloom',
    greeting: '店里的旧钟停在四点二十，你来的时候，灰尘刚好落定。',
    updatedAt: now - 2 * 24 * 60 * min,
    sessionCount: 1,
  },
];

export const sessions = [
  { id: 1, characterId: 1, title: '雨夜来电', updatedAt: now - 3 * min },
  { id: 2, characterId: 1, title: '旧书店的约定', updatedAt: now - 26 * min },
  { id: 3, characterId: 2, title: '深巷追凶', updatedAt: now - 2 * 24 * 60 * min },
];

export const messagesBySession: Record<number, ChatMessage[]> = {
  1: [
    {
      id: 1,
      sessionId: 1,
      characterId: 1,
      role: 'assistant',
      content: '**雨点敲着窗棂**，我数到第七声的时候，电话响了。\n\n是你吗？这个时间打来的人，不多。',
      reasoning: '开场白：营造雨夜氛围，留下悬念钩子，等待用户回应以确定故事走向。',
      thinkMs: 2400,
      createdAt: now - 10 * min,
      interrupted: false,
    },
    {
      id: 2,
      sessionId: 1,
      characterId: null,
      role: 'user',
      content: '是我。你还留着这个号码，我有点意外。',
      reasoning: null,
      thinkMs: null,
      createdAt: now - 8 * min,
      interrupted: false,
    },
    {
      id: 3,
      sessionId: 1,
      characterId: 1,
      role: 'assistant',
      content: '有些东西我不丢，号码是其中之一。\n\n*指尖在桌沿轻轻敲了两下*——说吧，这次是什么事。',
      reasoning: '维持角色的克制与旧情愫的张力；不主动推进剧情，把话语权交回用户。',
      thinkMs: 1800,
      createdAt: now - 5 * min,
      interrupted: false,
    },
    {
      id: 4,
      sessionId: 1,
      characterId: 1,
      role: 'assistant',
      content: '其实我今晚本来想……',
      reasoning: null,
      thinkMs: null,
      createdAt: now - 3 * min,
      interrupted: true,
    },
  ],
  2: [
    {
      id: 5,
      sessionId: 2,
      characterId: 1,
      role: 'assistant',
      content: '店里的旧钟停在四点二十，你来的时候，灰尘刚好落定。',
      reasoning: null,
      thinkMs: null,
      createdAt: now - 30 * min,
      interrupted: false,
    },
  ],
  3: [
    {
      id: 6,
      sessionId: 3,
      characterId: 2,
      role: 'assistant',
      content: '巷子口的灯坏了三天，没人修。案卷上不会记这个，但死者会。',
      reasoning: '侦探角色的冷开场：用环境细节暗示案情，语气克制。',
      thinkMs: 3200,
      createdAt: now - 2 * 24 * 60 * min,
      interrupted: false,
    },
  ],
};
