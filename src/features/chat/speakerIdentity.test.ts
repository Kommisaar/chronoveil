// @vitest-environment node —— 纯逻辑测试无 DOM 依赖，跳过 jsdom 环境创建（测试提速）
// 说话人色轨解析单测：角色条强调色优先、无模板卡按溯源 id 走调色板、用户条与
// 身份缺失条诚实中性灰。纯函数，不涉及 DOM。
import { describe, expect, it } from 'vitest';
import type { ChatMessage, CharacterSummary, SessionInstanceDto } from '../../api/types';
import { gradientPairOf } from '../../components/posterGradient';
import { USER_SPEAKER_NEUTRAL, instanceSpeakerColor, messageSpeakerColor } from './speakerIdentity';

const CARD: CharacterSummary = {
  id: 7,
  name: '苏鸢',
  avatar: null,
  persona: '雨夜电话亭的守夜人',
  gender: null,
  age: null,
  titles: [],
  renderStyle: null,
  modelProviderId: null,
  modelName: null,
  modelTemperature: null,
  accentColor: '#ff00aa',
  animDurationMs: null,
  animRhythmMs: null,
  animPunctPause: null,
  updatedAt: 0,
  sessionCount: 0,
};

function instance(partial: Partial<SessionInstanceDto> & { id: number }): SessionInstanceDto {
  // renderStyle 是必需 string（D1 建会话快照），色轨解析不消费，给任意合法风格 id
  return { name: '苏鸢', isUser: false, characterId: 7, renderStyle: 'fade', ...partial };
}

function message(partial: Partial<ChatMessage> & { id: number; role: ChatMessage['role'] }): ChatMessage {
  return {
    sessionId: 1,
    characterId: null,
    content: '',
    reasoning: null,
    thinkMs: null,
    interrupted: false,
    createdAt: 0,
    ...partial,
  };
}

describe('instanceSpeakerColor（角色条：强调色同源派生）', () => {
  it('模板卡显式 accentColor 原色直出', () => {
    expect(instanceSpeakerColor(instance({ id: 1, characterId: 7 }), [CARD])).toBe('#ff00aa');
  });

  it('卡未设 accentColor → 海报渐变亮端回退（与海报同源）', () => {
    const bare: CharacterSummary = { ...CARD, accentColor: null };
    expect(instanceSpeakerColor(instance({ id: 1, characterId: 7 }), [bare])).toBe(
      gradientPairOf(7)[1],
    );
  });

  it('动态造人（characterId None）按实例自身 id 走调色板，不撞色不漂移', () => {
    expect(instanceSpeakerColor(instance({ id: 5, characterId: null }), [])).toBe(
      gradientPairOf(5)[1],
    );
  });
});

describe('messageSpeakerColor（消息条目：身份诚实缺省）', () => {
  it('user 条恒中性灰（带阵容也灰）', () => {
    expect(messageSpeakerColor(message({ id: 2, role: 'user' }), [instance({ id: 1 })], [CARD])).toBe(
      USER_SPEAKER_NEUTRAL,
    );
  });

  it('assistant 条按说话人实例取角色色', () => {
    expect(
      messageSpeakerColor(message({ id: 3, role: 'assistant', characterId: 1 }), [
        instance({ id: 1, characterId: 7 }),
      ], [CARD]),
    ).toBe('#ff00aa');
  });

  it('assistant 条实例查不到（阵容回显缺失）→ 中性灰，不伪装角色色', () => {
    expect(
      messageSpeakerColor(message({ id: 4, role: 'assistant', characterId: 99 }), [], [CARD]),
    ).toBe(USER_SPEAKER_NEUTRAL);
  });
});
