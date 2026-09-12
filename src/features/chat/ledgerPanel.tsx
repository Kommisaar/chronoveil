/**
 * 叙事账本面板（FR-012 状态面板 + 场景史 UI 的合并形态）。
 *
 * 形态：右侧内嵌面板（聊天列的 flex 兄弟，非模态 Dialog）——账本是「边聊边查」
 * 的参照物，模态会挡住聊天流；内嵌列不抢焦点、随外层开关即时开合（ADR：
 * ChatView 侧注释）。
 *
 * 内容三段，顺序固定：
 * - 人物状态：按 scope 分「当前状态」「关系」两组，`key：value` 行；组空省标题，
 *   全空显示空态文案。expiry 不展示（那是结算清算线索，非叙事信息）。
 * - 场景史：idx 倒序（最新在上）。每行 = 场号 + 时间标签 + 地点 + 一行 summary；
 *   时间标签只出一枚（后端编年史并列链 location·timeNote·dateLabel·summary，
 *   前端收成一段保持克制）：timeNote（叙事时间原文，如「第三日黄昏，雨」）最
 *   有味道，优先；缺失回落 dateLabel，再缺拼 ficDay/ficPart（与后端 date_label
 *   数字回退形态同构）。场号行下附「在场：…」次要小字行（present 角色名，已删
 *   角色回退「角色#id」）。元数据全空的场也保留行（场号可辨）。recap 非空的场
 *   （桥场）出「展开回顾」折叠块，默认收起。
 * - 调用轨迹：本会话的 LLM 调用记录。条目倒序（最新在上）；行 = 序号（时序位，
 *   最旧 1）+ kind 徽标（中文映射）+ 模型名 + 元信息行（IN/OUT tok · 耗时s ·
 *   HH:mm:ss），error 记录红色标记并附「失败」徽标。点击行展开详情（同时只开
 *   一行）：请求消息按 role 分色（system 灰斜体 / user 蓝 / assistant 正文色 /
 *   tool 黄）+ role 标签、回复正文 / 思考过程 / 错误信息（有则显示）、工具调用
 *   （name + arguments 等宽原文）。性能克制：promptJson 等大字段只在展开时
 *   parse（列表行不碰），JSON 解析失败降级显示原文，不炸。段头右侧出会话汇总：
 *   N 次调用（M 失败，M>0 时追加）· ↑IN 合计 · ↓OUT 合计（token 合计仅统计
 *   status=ok，null 记 0；N 含 error）。
 *
 * 数据策略：挂载（打开面板）与 sessionId 变化（会话切换）时重拉场景 / 状态 /
 * 调用轨迹三个会话级列表 + 角色清单（present id → 名字映射用，v1 单角色会话通常
 * 就一个）；生成终态（streamHub.onTerminal，ADR-005 保证 done 放行前 scenes /
 * character_state 已在库）且属于本会话时静默重拉，无需手动刷新按钮。调用轨迹另
 * 有实时流：streamHub.onTrace 到达即头部插入（不重拉全量，同 id 幂等更新原位），
 * 面板关闭随卸载摘订阅。轨迹走独立订阅通道、不经 StreamEvent 联合——架构决定
 * 见 streamHub 头注。
 */
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Button,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  listCharacterStates,
  listCharacters,
  listLlmCalls,
  listScenes,
} from '../../api/commands';
import type { CharacterStateDto, SceneDto } from '../../api/types';
import { streamHub, type LlmCall } from './streamHub';

const useStyles = makeStyles({
  panel: {
    width: '320px',
    flexShrink: 0,
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  header: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    flexShrink: 0,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  title: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
  },
  sectionTitle: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
  },
  // 状态分组小标（组空省略整组含标题）
  groupTitle: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  stateRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase300,
    lineHeight: '1.6',
    wordBreak: 'break-word',
  },
  stateMarker: {
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
  stateText: {
    minWidth: 0,
  },
  // 加载 / 错误态：纵向居中的一块
  stateBlock: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalM}`,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  // 场景行：头行（场号 + 元信息）+ 一行摘要 + 可选回顾折叠
  sceneRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  sceneHead: {
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
  },
  sceneNo: {
    flexShrink: 0,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground1,
  },
  sceneMeta: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  sceneSummary: {
    fontSize: tokens.fontSizeBase300,
    lineHeight: '1.6',
    wordBreak: 'break-word',
  },
  recap: {
    fontSize: tokens.fontSizeBase200,
  },
  recapBody: {
    fontSize: tokens.fontSizeBase200,
    lineHeight: '1.6',
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  // —— 调用轨迹段 ——
  // 段头：标题 + 右侧会话汇总（N 次调用（M 失败）· ↑IN 合计 · ↓OUT 合计）
  sectionHead: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  sectionMeta: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: 'tabular-nums',
  },
  // 调用行：可点头行（序号 + kind 徽标 + 模型 + 失败徽标 + 元信息行）+ 展开详情
  callRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  callHead: {
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: `${tokens.spacingHorizontalXXS} ${tokens.spacingHorizontalS}`,
    width: '100%',
    padding: '0px',
    // 按钮重置：border 走四向 longhand（griffel 禁 borderWidth 这类再缩写）
    borderTopWidth: '0px',
    borderRightWidth: '0px',
    borderBottomWidth: '0px',
    borderLeftWidth: '0px',
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
  },
  callNo: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: 'tabular-nums',
  },
  kindBadge: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    padding: '0px 6px',
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  badgeError: {
    backgroundColor: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
  },
  callModel: {
    minWidth: 0,
    fontSize: tokens.fontSizeBase300,
    wordBreak: 'break-all',
  },
  callFailed: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorPaletteRedForeground1,
  },
  callMeta: {
    width: '100%',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: 'tabular-nums',
  },
  callMetaError: {
    color: tokens.colorPaletteRedForeground1,
  },
  // 展开详情：请求消息（role 分色 + 标签）/ 回复 / 思考 / 错误 / 工具调用
  callDetail: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  detailBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  detailLabel: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
  },
  detailBody: {
    fontSize: tokens.fontSizeBase200,
    lineHeight: '1.6',
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  errorBody: {
    fontSize: tokens.fontSizeBase200,
    lineHeight: '1.6',
    color: tokens.colorPaletteRedForeground1,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  // 请求消息列表：长内容可滚动（max-height + overflow）
  promptScroll: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    maxHeight: '180px',
    overflowY: 'auto',
    padding: tokens.spacingVerticalXXS,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  promptItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  roleTag: {
    alignSelf: 'flex-start',
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    padding: '0px 6px',
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  // role 分色：system 灰斜体 / user 蓝 / assistant 正文色 / tool 黄
  roleSystem: {
    fontStyle: 'italic',
    color: tokens.colorNeutralForeground3,
  },
  roleUser: {
    color: tokens.colorBrandForeground1,
  },
  roleAssistant: {
    color: tokens.colorNeutralForeground1,
  },
  roleTool: {
    color: tokens.colorPaletteYellowForeground2,
  },
  promptBody: {
    fontSize: tokens.fontSizeBase200,
    lineHeight: '1.6',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  // 工具调用：name + arguments 原文（等宽），arguments 可滚动
  toolItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  toolName: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  toolArgs: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    lineHeight: '1.6',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    maxHeight: '120px',
    overflowY: 'auto',
    padding: tokens.spacingVerticalXXS,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground2,
  },
});

/** 时间标签（只出一枚，不堆叠）：timeNote（叙事时间原文）优先；缺失回落
 * dateLabel；再缺拼 ficDay/ficPart（后端 date_label 数字回退同构）；全缺省略。 */
function timeLabelOf(scene: SceneDto, t: TFunction): string | null {
  if (scene.timeNote !== null && scene.timeNote !== '') return scene.timeNote;
  if (scene.dateLabel !== null && scene.dateLabel !== '') return scene.dateLabel;
  const { ficDay: day, ficPart: part } = scene;
  if (day !== null && part !== null) return t('chat.ledger.dayPart', { day, part });
  if (day !== null) return t('chat.ledger.day', { day });
  return part;
}

/** 状态分组（组空由调用方省略整组含标题）：`key：value` 行，expiry 不展示。 */
function StateGroup({ title, rows }: { title: string; rows: CharacterStateDto[] }) {
  const styles = useStyles();
  const { t } = useTranslation();
  return (
    <div className={styles.group}>
      <Text className={styles.groupTitle}>{title}</Text>
      {rows.map((s) => (
        <div key={s.id} className={styles.stateRow}>
          <span className={styles.stateMarker} aria-hidden="true">
            ·
          </span>
          <span className={styles.stateText}>
            {t('chat.ledger.stateRow', { key: s.key, value: s.value })}
          </span>
        </div>
      ))}
    </div>
  );
}

// —— 调用轨迹段（第三段）：解析与格式化辅助 ——

/** kind 徽标 i18n key 映射（中文映射走 i18n；枚举添新值时此处编译期报缺键）。 */
const KIND_KEY: Record<LlmCall['kind'], string> = {
  dialogue: 'chat.ledger.kind.dialogue',
  explorer: 'chat.ledger.kind.explorer',
  director: 'chat.ledger.kind.director',
  draft: 'chat.ledger.kind.draft',
};

/** 请求消息（promptJson 条目形态）；role 是协议原文，渲染为分色标签。 */
interface PromptMessage {
  role: string;
  content: string;
}

/** 工具调用（toolCallsJson 条目形态）；arguments 保持原文（等宽展示）。 */
interface ToolCall {
  name: string;
  arguments: string;
}

/** 防御式 JSON 数组解析：语法错误 / 非数组一律 null（调用方降级显示原文）。 */
function parseJsonArray(raw: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** promptJson → 请求消息列表；整体或任一条目形状不符返回 null（降级原文）。 */
function parsePromptMessages(raw: string): PromptMessage[] | null {
  const parsed = parseJsonArray(raw);
  if (parsed === null) return null;
  const messages: PromptMessage[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.role !== 'string' || typeof record.content !== 'string') return null;
    messages.push({ role: record.role, content: record.content });
  }
  return messages;
}

/** toolCallsJson → 工具调用列表；字段缺席（null）视为无工具调用（undefined）。 */
function parseToolCalls(raw: string | null): ToolCall[] | null | undefined {
  if (raw === null) return undefined;
  const parsed = parseJsonArray(raw);
  if (parsed === null) return null;
  const calls: ToolCall[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.arguments !== 'string') return null;
    calls.push({ name: record.name, arguments: record.arguments });
  }
  return calls;
}

/** 钟面时间含秒（HH:mm:ss，语言从众 lib/relativeTime 的 formatClock）：轨迹粒度在秒级。 */
function formatClockSec(ts: number, language: string): string {
  return new Intl.DateTimeFormat(language, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(ts);
}

/** role 分色 class（system 灰斜体 / user 蓝 / assistant 正文色 / tool 黄）；未知 role 不着色。 */
function roleStyleClass(
  styles: ReturnType<typeof useStyles>,
  role: string,
): string | undefined {
  switch (role) {
    case 'system':
      return styles.roleSystem;
    case 'user':
      return styles.roleUser;
    case 'assistant':
      return styles.roleAssistant;
    case 'tool':
      return styles.roleTool;
    default:
      return undefined;
  }
}

/** 详情子块：小标题 + 正文（层级从众 recap 的小字标题 + 次色正文）。 */
function DetailBlock({ label, children }: { label: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <div className={styles.detailBlock}>
      <Text className={styles.detailLabel}>{label}</Text>
      {children}
    </div>
  );
}

/**
 * 调用详情（仅在行展开时渲染 → 大字段此刻才 parse，列表行不碰 promptJson）。
 * 请求消息按 role 分色渲染（每条带 role 标签，长内容滚动）；回复 / 思考 / 错误
 * 有则显示（思考从众 ChatView 思考折叠的次色正文视觉）；工具调用等宽原文；
 * JSON 解析失败一律降级显示原文，不炸。
 */
function CallDetail({ call }: { call: LlmCall }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const messages = parsePromptMessages(call.promptJson);
  const toolCalls = parseToolCalls(call.toolCallsJson);
  // 请求段可见性：解析成功且有条目 → 分色列表；解析失败且原文非空 → 降级原文；
  // 空请求（[] / 空串）→ 整段省略（空标签块是噪音）
  const showPromptList = messages !== null && messages.length > 0;
  const showPromptRaw = messages === null && call.promptJson !== '';
  return (
    <div className={styles.callDetail}>
      {(showPromptList || showPromptRaw) && (
        <DetailBlock label={t('chat.ledger.promptMessages')}>
          {showPromptRaw ? (
            // 降级：语法 / 形状不符直接原文
            <div className={styles.promptBody}>{call.promptJson}</div>
          ) : (
            <div className={styles.promptScroll}>
              {messages !== null &&
                messages.map((message, index) => (
                  <div key={index} className={styles.promptItem}>
                    <span
                      className={mergeClasses(styles.roleTag, roleStyleClass(styles, message.role))}
                    >
                      {message.role}
                    </span>
                    <div
                      className={mergeClasses(
                        styles.promptBody,
                        roleStyleClass(styles, message.role),
                      )}
                    >
                      {message.content}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </DetailBlock>
      )}
      {call.responseText !== null && call.responseText !== '' && (
        <DetailBlock label={t('chat.ledger.responseText')}>
          <div className={styles.detailBody}>{call.responseText}</div>
        </DetailBlock>
      )}
      {call.reasoningText !== null && call.reasoningText !== '' && (
        <DetailBlock label={t('chat.reasoning')}>
          <div className={styles.detailBody}>{call.reasoningText}</div>
        </DetailBlock>
      )}
      {call.errorText !== null && call.errorText !== '' && (
        <DetailBlock label={t('chat.ledger.errorText')}>
          <div className={styles.errorBody}>{call.errorText}</div>
        </DetailBlock>
      )}
      {toolCalls !== undefined && (
        <DetailBlock label={t('chat.ledger.toolCalls')}>
          {toolCalls === null ? (
            <div className={styles.toolArgs}>{call.toolCallsJson}</div>
          ) : (
            toolCalls.map((tool, index) => (
              <div key={index} className={styles.toolItem}>
                <span className={styles.toolName}>{tool.name}</span>
                <div className={styles.toolArgs}>{tool.arguments}</div>
              </div>
            ))
          )}
        </DetailBlock>
      )}
    </div>
  );
}

interface LedgerPanelProps {
  /** 当前会话（面板只展示现役会话；切换会话由父级换 prop 触发重拉）。 */
  sessionId: number;
}

export function LedgerPanel({ sessionId }: LedgerPanelProps) {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const [scenes, setScenes] = useState<SceneDto[] | null>(null);
  const [states, setStates] = useState<CharacterStateDto[] | null>(null);
  // present 角色名映射（id → 名字）：随角色清单一次拉全量，已删角色查不到走回退文案
  const [characterNames, setCharacterNames] = useState<Map<number, string>>(new Map());
  // 调用轨迹（会话级列表）：实时增量经 onTrace 头部插入 / 原位更新，见下
  const [calls, setCalls] = useState<LlmCall[] | null>(null);
  // 展开详情的行（同时只开一行，点击切换）；跨会话无意义，会话切换时重置
  const [openCallId, setOpenCallId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // 终态静默重拉 / 手动重试共用的时间点：bump 触发下方拉取 effect 重跑
  const [refreshTick, setRefreshTick] = useState(0);

  // 拉取：打开（挂载）、会话切换（sessionId 变化）、终态 / 重试（refreshTick）。
  // 场景 / 状态 / 调用轨迹按会话查询，角色清单全量（present 映射用，v1 单角色
  // 会话通常就一个）；四者同库同源，失败一并走错误态重试。
  // cancelled 标记防会话快切竞态：过期响应不落 state。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void Promise.all([
      listScenes(sessionId),
      listCharacterStates(sessionId),
      listCharacters(),
      listLlmCalls(sessionId),
    ])
      .then(([nextScenes, nextStates, nextCharacters, nextCalls]) => {
        if (cancelled) return;
        setScenes(nextScenes);
        setStates(nextStates);
        setCharacterNames(new Map(nextCharacters.map((c) => [c.id, c.name])));
        setCalls(nextCalls);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshTick]);

  // 新完成消息 → 静默重拉（FR-012）：终态事件（done / error 均已落库，ADR-001）
  // 在 done 放行前 scenes / character_state 已结算在库（ADR-005），直接重拉无竞态；
  // 只认本会话的终态（后台会话的账本不归本面板管）。面板关闭即随卸载摘订阅。
  useEffect(
    () =>
      streamHub.onTerminal((terminalSessionId) => {
        if (terminalSessionId === sessionId) setRefreshTick((tick) => tick + 1);
      }),
    [sessionId],
  );

  // 调用轨迹实时流（独立订阅通道，不经 StreamEvent——架构决定见 streamHub 头注）：
  // 本会话的调用记录到达即头部插入（不重拉全量）；同 id 已存在 → 更新原位（幂等，
  // 补发 / 重发安全）；其他会话的记录忽略。初始拉取未落定（calls 为 null）时丢弃：
  // 拉取结果必然已含该记录。面板关闭随卸载摘订阅。
  useEffect(
    () =>
      streamHub.onTrace((call) => {
        if (call.sessionId !== sessionId) return;
        setCalls((prev) => {
          if (prev === null) return prev;
          const index = prev.findIndex((existing) => existing.id === call.id);
          if (index < 0) return [call, ...prev];
          const next = [...prev];
          next[index] = call;
          return next;
        });
      }),
    [sessionId],
  );

  // 会话切换重置展开行：跨会话的 openCallId 无意义
  useEffect(() => {
    setOpenCallId(null);
  }, [sessionId]);

  const stateList = states ?? [];
  const relationRows = stateList.filter((s) => s.scope === 'relation');
  const stateRows = stateList.filter((s) => s.scope !== 'relation');
  // 倒序（最新在上）：idx 是同会话单调叙事顺序（domain Scene.idx 约定）
  const sceneRows = [...(scenes ?? [])].sort((a, b) => b.idx - a.idx);
  // 调用轨迹倒序（最新在上）：startedAt 降序，同刻按 id 降序（后落的行更晚入库）
  const callRows = [...(calls ?? [])].sort((a, b) => b.startedAt - a.startedAt || b.id - a.id);
  // 会话汇总：N 含 error；M = 失败数（M>0 才展示）；token 合计仅统计 status=ok，
  // null 记 0（某条没报 token 不拖累其余条的合计）
  const failedCount = callRows.filter((c) => c.status === 'error').length;
  const okCalls = callRows.filter((c) => c.status === 'ok');
  const tokIn = okCalls.reduce((sum, c) => sum + (c.promptTokens ?? 0), 0);
  const tokOut = okCalls.reduce((sum, c) => sum + (c.completionTokens ?? 0), 0);

  return (
    <aside id="ledger-panel" className={styles.panel} aria-label={t('chat.ledger.title')}>
      <div className={styles.header}>
        <Text className={styles.title}>{t('chat.ledger.title')}</Text>
      </div>
      {loading ? (
        <div className={styles.stateBlock}>
          <Spinner size="tiny" />
          <Text>{t('chat.ledger.loading')}</Text>
        </div>
      ) : failed ? (
        <div className={styles.stateBlock}>
          <Text>{t('chat.ledger.loadFailed')}</Text>
          <Button size="small" onClick={() => setRefreshTick((tick) => tick + 1)}>
            {t('chat.ledger.retry')}
          </Button>
        </div>
      ) : (
        <>
          <section className={styles.section} aria-label={t('chat.ledger.states')}>
            <Text className={styles.sectionTitle}>{t('chat.ledger.states')}</Text>
            {stateList.length === 0 ? (
              <Text className={styles.groupTitle}>{t('chat.ledger.statesEmpty')}</Text>
            ) : (
              <>
                {stateRows.length > 0 && (
                  <StateGroup title={t('chat.ledger.groupState')} rows={stateRows} />
                )}
                {relationRows.length > 0 && (
                  <StateGroup title={t('chat.ledger.groupRelation')} rows={relationRows} />
                )}
              </>
            )}
          </section>
          <section className={styles.section} aria-label={t('chat.ledger.scenes')}>
            <Text className={styles.sectionTitle}>{t('chat.ledger.scenes')}</Text>
            {sceneRows.length === 0 ? (
              <Text className={styles.groupTitle}>{t('chat.ledger.scenesEmpty')}</Text>
            ) : (
              sceneRows.map((scene) => {
                const timeLabel = timeLabelOf(scene, t);
                return (
                  <div key={scene.id} className={styles.sceneRow}>
                    <div className={styles.sceneHead}>
                      <Text className={styles.sceneNo}>
                        {t('chat.ledger.sceneNo', { index: scene.idx })}
                      </Text>
                      {timeLabel !== null && (
                        <span className={styles.sceneMeta}>{timeLabel}</span>
                      )}
                      {scene.location !== null && scene.location !== '' && (
                        <span className={styles.sceneMeta}>{scene.location}</span>
                      )}
                    </div>
                    {scene.present.length > 0 && (
                      // 在场角色：次要小字行（从众 sceneMeta 层级，不抢 summary）；
                      // 已删角色回退「角色#id」；名字拼接从众 CalendarSection 的「、」
                      <div className={styles.sceneMeta}>
                        {t('chat.ledger.present', {
                          names: scene.present
                            .map(
                              (id) =>
                                characterNames.get(id) ??
                                t('chat.ledger.unknownCharacter', { id }),
                            )
                            .join('、'),
                        })}
                      </div>
                    )}
                    {scene.summary !== null && scene.summary !== '' && (
                      <div className={styles.sceneSummary}>{scene.summary}</div>
                    )}
                    {scene.recap !== null && scene.recap !== '' && (
                      // 桥场加厚回顾（Task-03）：默认收起，随场行折叠
                      <Accordion className={styles.recap} collapsible>
                        <AccordionItem value="recap">
                          <AccordionHeader size="small">
                            {t('chat.ledger.expandRecap')}
                          </AccordionHeader>
                          <AccordionPanel>
                            <div className={styles.recapBody}>{scene.recap}</div>
                          </AccordionPanel>
                        </AccordionItem>
                      </Accordion>
                    )}
                  </div>
                );
              })
            )}
          </section>
          <section className={styles.section} aria-label={t('chat.ledger.traces')}>
            <div className={styles.sectionHead}>
              <Text className={styles.sectionTitle}>{t('chat.ledger.traces')}</Text>
              {calls !== null && calls.length > 0 && (
                <span className={styles.sectionMeta}>
                  {t('chat.ledger.callCount', { count: calls.length })}
                  {failedCount > 0 && t('chat.ledger.failedSuffix', { count: failedCount })}
                  {' · '}
                  {t('chat.ledger.tokIn', { count: tokIn })}
                  {' · '}
                  {t('chat.ledger.tokOut', { count: tokOut })}
                </span>
              )}
            </div>
            {callRows.length === 0 ? (
              <Text className={styles.groupTitle}>{t('chat.ledger.tracesEmpty')}</Text>
            ) : (
              callRows.map((call, position) => {
                // 序号 = 时序位置：最旧 1，最新最大（新纪录头部插入时整体顺延，
                // 与场景史的场号同语义：数字随时间单调增长）
                const ordinal = callRows.length - position;
                const isError = call.status === 'error';
                return (
                  <div key={call.id} className={styles.callRow}>
                    <button
                      type="button"
                      className={styles.callHead}
                      aria-expanded={openCallId === call.id}
                      onClick={() =>
                        setOpenCallId((current) => (current === call.id ? null : call.id))
                      }
                    >
                      <span className={styles.callNo}>#{ordinal}</span>
                      <span
                        className={mergeClasses(styles.kindBadge, isError && styles.badgeError)}
                      >
                        {t(KIND_KEY[call.kind])}
                      </span>
                      <span className={styles.callModel}>{call.model}</span>
                      {isError && (
                        <span className={styles.callFailed}>{t('chat.ledger.callFailed')}</span>
                      )}
                      <span
                        className={mergeClasses(styles.callMeta, isError && styles.callMetaError)}
                      >
                        {t('chat.ledger.callTokens', {
                          tokIn: call.promptTokens ?? '—',
                          tokOut: call.completionTokens ?? '—',
                        })}
                        {' · '}
                        {(call.durationMs / 1000).toFixed(1)}s
                        {' · '}
                        {formatClockSec(call.startedAt, i18n.language)}
                      </span>
                    </button>
                    {openCallId === call.id && <CallDetail call={call} />}
                  </div>
                );
              })
            )}
          </section>
        </>
      )}
    </aside>
  );
}
