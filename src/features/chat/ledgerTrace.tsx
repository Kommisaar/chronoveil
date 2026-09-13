/**
 * 叙事账本第三段：调用轨迹（本会话的 LLM 调用记录）。
 *
 * - 条目倒序（最新在上）：startedAt 降序，同刻按 id 降序（后落的行更晚入库）。
 *   行 = 序号（时序位，最旧 1）+ kind 徽标（中文映射）+ 模型名 + 元信息行
 *   （IN/OUT tok · 耗时s · HH:mm:ss），error 记录红色标记并附「失败」徽标。
 * - 点击行展开详情（同时只开一行）：请求消息按 role 分色（system 灰斜体 /
 *   user 蓝 / assistant 正文色 / tool 黄）+ role 标签、回复正文 / 思考过程 /
 *   错误信息（有则显示）、工具调用（name + arguments 等宽原文）。性能克制：
 *   promptJson 等大字段只在展开时 parse（列表行不碰），JSON 解析失败降级
 *   显示原文，不炸。
 * - 段头右侧出会话汇总：N 次调用（M 失败，M>0 时追加）· ↑IN 合计 · ↓OUT
 *   合计（token 合计仅统计 status=ok，null 记 0；N 含 error）。
 *
 * 数据由面板壳维护（初始拉取 + streamHub.onTrace 实时增量），本组件只管
 * 渲染与展开态；展开行跨会话无意义，随 sessionId 切换重置。
 */
import { Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmCall } from './streamHub';
import { useLedgerSectionStyles } from './useLedgerSectionStyles';

const useStyles = makeStyles({
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

/** kind 徽标 i18n key 映射（中文映射走 i18n；枚举添新值时此处编译期报缺键）。 */
const KIND_KEY: Record<LlmCall['kind'], string> = {
  dialogue: 'chat.ledger.kind.dialogue',
  explorer: 'chat.ledger.kind.explorer',
  director: 'chat.ledger.kind.director',
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

export interface LedgerTraceSectionProps {
  /** 当前会话：切换时重置展开行（跨会话的展开状态无意义）。 */
  sessionId: number;
  /** 会话级调用记录（初始拉取 + onTrace 实时增量由面板壳维护；null = 拉取未落定）。 */
  calls: LlmCall[] | null;
}

export function LedgerTraceSection({ sessionId, calls }: LedgerTraceSectionProps) {
  const styles = useStyles();
  const chrome = useLedgerSectionStyles();
  const { t, i18n } = useTranslation();
  // 展开详情的行（同时只开一行，点击切换）；跨会话无意义，会话切换时重置
  const [openCallId, setOpenCallId] = useState<number | null>(null);

  // 会话切换重置展开行：跨会话的 openCallId 无意义
  useEffect(() => {
    setOpenCallId(null);
  }, [sessionId]);

  const callRows = [...(calls ?? [])].sort((a, b) => b.startedAt - a.startedAt || b.id - a.id);
  // 会话汇总：N 含 error；M = 失败数（M>0 才展示）；token 合计仅统计 status=ok，
  // null 记 0（某条没报 token 不拖累其余条的合计）
  const failedCount = callRows.filter((c) => c.status === 'error').length;
  const okCalls = callRows.filter((c) => c.status === 'ok');
  const tokIn = okCalls.reduce((sum, c) => sum + (c.promptTokens ?? 0), 0);
  const tokOut = okCalls.reduce((sum, c) => sum + (c.completionTokens ?? 0), 0);

  return (
    <section className={chrome.section} aria-label={t('chat.ledger.traces')}>
      <div className={styles.sectionHead}>
        <Text className={chrome.sectionTitle}>{t('chat.ledger.traces')}</Text>
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
        <Text className={chrome.groupTitle}>{t('chat.ledger.tracesEmpty')}</Text>
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
                onClick={() => setOpenCallId((current) => (current === call.id ? null : call.id))}
              >
                <span className={styles.callNo}>#{ordinal}</span>
                <span className={mergeClasses(styles.kindBadge, isError && styles.badgeError)}>
                  {t(KIND_KEY[call.kind])}
                </span>
                <span className={styles.callModel}>{call.model}</span>
                {isError && <span className={styles.callFailed}>{t('chat.ledger.callFailed')}</span>}
                <span className={mergeClasses(styles.callMeta, isError && styles.callMetaError)}>
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
  );
}
