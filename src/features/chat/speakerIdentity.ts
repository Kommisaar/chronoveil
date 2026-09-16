/**
 * 说话人身份解析（2026-09-16 消息卡「顶签卡」定稿的配套逻辑）：消息卡顶缘
 * 3px 色签的颜色即说话人身份——角色条取其模板卡强调色（accentColorOf：显式
 * accentColor 优先，缺省落海报渐变亮端，与海报/典藏卡同源单一事实源）；用户条
 * 与身份缺失条取中性灰（诚实缺省，同未知说话人显示 '—' 的语义）。
 */
import { tokens } from '@fluentui/react-components';
import type { ChatMessage, CharacterSummary, SessionInstanceDto } from '../../api/types';
import { accentColorOf } from '../../components/posterGradient';

/** 用户条顶签：中性灰（非角色即无角色色）。 */
export const USER_SPEAKER_NEUTRAL = tokens.colorNeutralForeground3;

/** 角色条顶签：模板卡强调色派生；动态造人（无模板卡，D6）按实例溯源 id 走
 *  调色板回退，同人不同处配色漂移不可接受（posterGradient 取模纪律）。 */
export function instanceSpeakerColor(
  instance: SessionInstanceDto,
  cards: readonly CharacterSummary[],
): string {
  const card =
    instance.characterId !== null
      ? cards.find((c) => c.id === instance.characterId)
      : undefined;
  return accentColorOf(card ?? { id: instance.characterId ?? instance.id, accentColor: null });
}

/** 消息条目顶签：user 恒中性灰；assistant 按说话人实例（characterId = 实例
 *  id 真值）解析；实例查不到（会话阵容回显缺失）诚实落中性灰，不伪装角色色。 */
export function messageSpeakerColor(
  message: ChatMessage,
  roster: readonly SessionInstanceDto[],
  cards: readonly CharacterSummary[],
): string {
  if (message.role === 'user' || message.characterId === null) return USER_SPEAKER_NEUTRAL;
  const instance = roster.find((i) => i.id === message.characterId);
  return instance !== undefined ? instanceSpeakerColor(instance, cards) : USER_SPEAKER_NEUTRAL;
}

/** 消息题头说话人名：user 显示「你」，assistant 按实例名回显（阵容快照为
 *  权威来源），缺实例显示 '—'。 */
export function speakerLabelOf(
  message: ChatMessage,
  names: ReadonlyMap<number, string>,
  youLabel: string,
): string {
  if (message.role === 'user') return youLabel;
  return message.characterId === null ? '—' : (names.get(message.characterId) ?? '—');
}
