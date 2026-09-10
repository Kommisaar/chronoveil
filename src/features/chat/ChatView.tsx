import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  shorthands,
  Text,
  Textarea,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowSync24Regular,
  ArrowUp24Regular,
  RecordStop24Regular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  cancelGeneration,
  getConfig,
  listCharacters,
  listMessages,
  regenerateLast,
  sendMessage,
} from '../../api/commands';
import { isTauri } from '../../api/client';
import type {
  CharacterSummary,
  ChatMessage,
  ConfigDto,
} from '../../api/types';
import { EmptyState } from '../../components/EmptyState';
import { renderStaticMarkdown } from '../../engine';
import { formatClock } from '../../lib/relativeTime';
import { useUiStore } from '../../stores/ui';
import { StreamingMessage } from './StreamingMessage';
import { CANCEL_REASON, streamHub } from './streamHub';

const useStyles = makeStyles({
  root: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  stream: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    // 15% 百分比边距（2026-09-08 用户指定）：随窗口等比
    padding: '24px 15%',
  },
  streamInner: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  // 消息行：叙事流排版（2026-09-08 四方案比选，用户选定 C）——去卡片化，
  // 角色名品牌色小标 + 时间，正文全幅；卡片只是外壳的时代结束，正文仍
  // markdown-lite 原文直显，引擎搬家（阶段 4）后由引擎直插 DOM（ADR-011）
  row: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '4px',
  },
  msgHeader: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  msgHeaderUser: {
    alignSelf: 'flex-end',
  },
  msgSpeaker: {
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground1,
  },
  msgSpeakerUser: {
    color: tokens.colorNeutralForeground3,
  },
  msgBody: {
    fontSize: tokens.fontSizeBase300,
    lineHeight: '1.8',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  msgBodyUser: {
    alignSelf: 'flex-end',
    maxWidth: '60%',
    textAlign: 'right',
    color: tokens.colorBrandForeground2,
  },
  reasoning: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  interrupted: {
    fontSize: tokens.fontSizeBase200,
  },
  notice: {
    margin: '0 15%',
    padding: '4px 0 0',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorPaletteRedForeground1,
  },
  composer: {
    margin: '0 15%',
    padding: '12px 0 20px',
  },
  // 输入卡（2026-09-08 用户参照图样式）：大圆角卡片，文本域无边框融入
  // 卡片，底部动作行只留发送按钮
  composerCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '10px 12px 10px 16px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: '16px',
    ':focus-within': { ...shorthands.borderColor(tokens.colorBrandStroke1) },
  },
  // Textarea 的 Fluent 边框/背景/焦点装饰由 app.css 全局中和（含 hover/
  // focus 全态），这里只管排版与尺寸
  inputRoot: {
    minHeight: '44px',
  },
  input: {
    padding: '0px',
    fontSize: tokens.fontSizeBase300,
    lineHeight: '1.6',
    minHeight: '44px',
  },
  composerActions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: tokens.spacingHorizontalS,
  },
  composerActionsWithRegen: {
    justifyContent: 'space-between',
  },
  regenerate: {
    fontSize: tokens.fontSizeBase200,
  },
});

/**
 * 引擎命名空间主题变量的聊天侧覆写（审计问题 3，保守适配）：engine.css 顶部的
 * --cv-* 默认值 = demo 暗色硬编码，聊天流容器按 Fluent 主题 token 覆写后随
 * 主题切换。内联 CSS 变量（而非 Griffel 规则）：变量名不在 Griffel 属性白名单，
 * 且行内样式挂在容器上即对全部引擎直插 DOM（历史行 + 流式行）生效。
 * - 场景线 ✦ 挖空底必须与所在表面背景一致：聊天表面是 AppShell content 的
 *   colorNeutralBackground1，暗色主题下 demo 的 #141822 本就是错色矩形；
 * - ✦ 记号色随 UI 次级前景；
 * - 线体 / 动作 / 加粗 / decode 等文字色暂不覆写（亮色对比度评估见 engine.css
 *   变量段注释），保持 demo 观感零回归。
 */
const engineThemeVars = {
  '--cv-scene-line-bg': tokens.colorNeutralBackground1,
  '--cv-scene-line-mark': tokens.colorNeutralForeground3,
} as CSSProperties;

/**
 * 历史 assistant 行正文（审计问题 1 接线）：引擎 renderStaticMarkdown 直插 DOM
 * （ADR-011 静态路径，无动画无光标），与流式期完全同语法语义——动作斜体/加粗/
 * 场景线/列表在收尾重拉后不再回退成字面星号。引擎容器内 DOM 不归 React 管
 * （同角色编辑器 PersonaPreviewBox 招式）：正文变化整容器重渲染，不得把 React
 * 子节点放进同一容器（reconcile 会打架）。user 行不走此路径：markdown-lite 是
 * assistant 叙事语法，user 按原文直显。
 */
function HistoryMessageBody({ content }: { content: string }) {
  const styles = useStyles();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) renderStaticMarkdown(ref.current, content);
  }, [content]);
  // 布局类沿用 msgBody（字号/行距/pre-wrap/断词）：引擎 .para 继承容器的
  // pre-wrap 与断词，与流式行排版一致
  return <div ref={ref} className={styles.msgBody} />;
}

/**
 * 聊天主视图（UI-001 / UC-001 / TASK-006）。
 * 生成闭环接线：发送（用户条落库 → 流式渲染走引擎）→ 终态（done/error/cancel）
 * 落库后重拉列表；停止立即静止；重新生成从零走完整演出（FR-008）。
 * 事件路由经 streamHub（按 session_id，多路并发互不串扰，FR-007 / ADR-007）。
 * 侧栏活性刷新（TASK-010 / FR-007「每条新消息刷新」）：用户条落库、重新生成
 * 替换落库、任一会话生成终态（hub 终态回调，含后台会话）三个事件时点触发
 * store.refreshSessionsQuietly —— 失败静默，不阻塞聊天主路径。
 * 历史 assistant 行正文经引擎静态渲染（TASK-12 / 审计问题 1 / ADR-011）：
 * 与流式期同语法语义；引擎主题变量在聊天流容器覆写（审计问题 3）。
 */
export function ChatView() {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  // 会话清单单一数据源在 ui store（TASK-007 验收 4）：与 Sidebar 同源，
  // 不再各自 listSessions 本地缓存；重拉触发点统一在 store.refreshSessions
  const sessions = useUiStore((s) => s.sessions);
  // 事件级活性刷新（TASK-010）：落库 / 终态时点触发，失败在 store 侧静默
  const refreshSessionsQuietly = useUiStore((s) => s.refreshSessionsQuietly);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [characters, setCharacters] = useState<Map<number, CharacterSummary>>(new Map());
  const [config, setConfig] = useState<ConfigDto | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);

  // 流式生成状态（模块级 hub：切走会话不丢，FR-007）
  const hubVersion = useSyncExternalStore(streamHub.subscribe, streamHub.getVersion);
  const streamState = streamHub.stateOf(activeSessionId);
  const busy = pending || streamState !== null;

  useEffect(() => {
    void listCharacters().then((list) => {
      setCharacters(new Map(list.map((c) => [c.id, c])));
    });
    void getConfig()
      .then(setConfig)
      .catch(() => {
        // 渲染参数取引擎默认即可，不阻塞聊天
      });
  }, []);

  const refresh = useCallback(async (sessionId: number) => {
    const fresh = await listMessages(sessionId);
    if (useUiStore.getState().activeSessionId === sessionId) {
      setMessages(fresh);
    }
    return fresh;
  }, []);

  useEffect(() => {
    if (activeSessionId === null) {
      setMessages([]);
      return;
    }
    void listMessages(activeSessionId).then(setMessages);
  }, [activeSessionId]);

  // 终态收尾（done/error）：Rust 侧已落库（ADR-001），重拉列表替换流式行。
  // 收尾只由 StreamingMessage 的 onSettled 驱动——done 先排空队列定格（无直出跳进），
  // error / stopping 冻结后半条以库中原文替换；后台会话的终态在切回挂载时收尾。
  const settleSession = useCallback(
    async (sessionId: number) => {
      const finalState = streamHub.stateOf(sessionId);
      try {
        await refresh(sessionId);
      } finally {
        streamHub.end(sessionId);
      }
      if (
        useUiStore.getState().activeSessionId === sessionId &&
        finalState?.status === 'error' &&
        finalState.errorReason !== CANCEL_REASON
      ) {
        setNotice(`${t('chat.failed')}${finalState.errorReason ? `：${finalState.errorReason}` : ''}`);
      }
    },
    [refresh, t],
  );

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, hubVersion]);

  // 生成终态 → 会话清单事件级刷新（TASK-010 验收 2 / FR-007）：hub 终态回调
  // 覆盖所有会话——含切走后的后台会话（多路并发，FR-007），事件级触发而非每
  // token（验收 3）；当前会话的终态同样经此刷新，无需在 settleSession 重复挂。
  useEffect(
    () => streamHub.onTerminal(() => refreshSessionsQuietly()),
    [refreshSessionsQuietly],
  );

  const onSend = async (): Promise<void> => {
    const content = draft.trim();
    if (content.length === 0 || activeSessionId === null || busy) return;
    setNotice(null);
    setDraft('');
    setPending(true);
    try {
      // 用户条立即落库返回（SEQ-001）；assistant 生成走事件通道流式回传
      const userMessage = await sendMessage(activeSessionId, content);
      setMessages((prev) => [...prev, userMessage]);
      // 用户条落库即刷新侧栏清单（TASK-010 验收 1：排序与相对时间即时更新）
      refreshSessionsQuietly();
      if (isTauri) {
        streamHub.begin(activeSessionId);
      } else {
        await refresh(activeSessionId); // 纯浏览器 mock：占位回复直接入列（无事件流）
      }
    } catch (e) {
      setDraft(content); // 发送失败保留草稿
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  const onStop = async (): Promise<void> => {
    if (activeSessionId === null) return;
    streamHub.markStopping(activeSessionId); // 立即静止（FR-001 / NFR-004）
    try {
      const cancelled = await cancelGeneration(activeSessionId);
      if (!cancelled) {
        // 竞态：恰在点停前已到终态 → 直接收尾
        await settleSession(activeSessionId);
      }
      // 取消成功时由 Rust 侧补发 error(interrupted=true) 终态事件触发收尾
    } catch {
      // 通道异常：终态事件 / 重开会话兜底
    }
  };

  const onRegenerate = async (): Promise<void> => {
    if (activeSessionId === null || busy) return;
    setNotice(null);
    setPending(true);
    try {
      // FR-008：返回被替换的旧条——从界面移除，新条从零走完整演出
      const old = await regenerateLast(activeSessionId);
      setMessages((prev) => prev.filter((m) => m.id !== old.id));
      // 替换落库（软删旧条 + 刷新 updated_at 单事务，ADR-001）→ 侧栏同步（TASK-010）
      refreshSessionsQuietly();
      if (isTauri) {
        streamHub.begin(activeSessionId);
      } else {
        await refresh(activeSessionId);
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  if (activeSessionId === null) {
    return <EmptyState message={t('chat.empty')} />;
  }

  const speakerOf = (message: ChatMessage): string => {
    if (message.role === 'user') return t('chat.you');
    return (message.characterId !== null && characters.get(message.characterId)?.name) || '—';
  };

  // 流式行的说话人 = 会话角色（FR-007：会话归属角色）
  const sessionCharacterId = sessions.find((s) => s.id === activeSessionId)?.characterId;
  const sessionSpeaker =
    (sessionCharacterId !== undefined && characters.get(sessionCharacterId)?.name) || '—';
  const tuning = {
    style: sessionCharacterId !== undefined ? characters.get(sessionCharacterId)?.renderStyle : undefined,
    msPerChar: config?.rhythmMsPerChar,
    punctPause: config?.punctPauseEnabled,
    durationMs: config?.animDurationBase,
  };
  const lastIsAssistant = messages.length > 0 && messages[messages.length - 1]?.role === 'assistant';

  return (
    <div className={styles.root}>
      <div
        className={styles.stream}
        ref={streamRef}
        style={engineThemeVars}
      >
        <div className={styles.streamInner}>
          {messages.map((message) => {
          const isUser = message.role === 'user';
          return (
            <div key={message.id} className={styles.row}>
              <div
                className={mergeClasses(
                  styles.msgHeader,
                  isUser && styles.msgHeaderUser,
                )}
              >
                <Text className={isUser ? styles.msgSpeakerUser : styles.msgSpeaker}>
                  {speakerOf(message)}
                </Text>
                <span>{formatClock(message.createdAt, i18n.language)}</span>
              </div>
              {message.reasoning !== null && (
                <Accordion className={styles.reasoning} collapsible>
                  <AccordionItem value="reasoning">
                    <AccordionHeader size="small">
                      {t('chat.reasoning')}
                      {message.thinkMs !== null && ` · ${(message.thinkMs / 1000).toFixed(1)}s`}
                    </AccordionHeader>
                    <AccordionPanel>{message.reasoning}</AccordionPanel>
                  </AccordionItem>
                </Accordion>
              )}
              {isUser ? (
                // user 行保持纯文本（markdown-lite 是 assistant 叙事语法）
                <div className={mergeClasses(styles.msgBody, styles.msgBodyUser)}>
                  {message.content}
                </div>
              ) : (
                <HistoryMessageBody content={message.content} />
              )}
              {message.interrupted && (
                <Badge className={styles.interrupted} appearance="outline" shape="rounded">
                  {t('chat.interrupted')}
                </Badge>
              )}
            </div>
          );
          })}
          {streamState && (
            <StreamingMessage
              key={streamState.sessionId}
              state={streamState}
              speaker={sessionSpeaker}
              tuning={tuning}
              onSettled={() => void settleSession(streamState.sessionId)}
            />
          )}
        </div>
      </div>
      {notice !== null && <div className={styles.notice}>{notice}</div>}
      <div className={styles.composer}>
        {/* composer-card：全局类挂点，app.css 的 Textarea 中和样式按此收窄作用域 */}
        <div className={mergeClasses(styles.composerCard, 'composer-card')}>
          <Textarea
            root={{ className: styles.inputRoot }}
            textarea={{
              className: styles.input,
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void onSend();
                }
              },
            }}
            resize="none"
            placeholder={t('chat.placeholder')}
            value={draft}
            onChange={(_, data) => setDraft(data.value)}
          />
          <div
            className={mergeClasses(
              styles.composerActions,
              lastIsAssistant && styles.composerActionsWithRegen,
            )}
          >
            {lastIsAssistant && (
              <Button
                size="small"
                className={styles.regenerate}
                icon={<ArrowSync24Regular />}
                aria-label={t('chat.regenerate')}
                title={t('chat.regenerate')}
                disabled={busy}
                onClick={() => void onRegenerate()}
              >
                {t('chat.regenerate')}
              </Button>
            )}
            {streamState ? (
              <Button
                appearance="primary"
                icon={<RecordStop24Regular />}
                aria-label={t('chat.stop')}
                title={t('chat.stop')}
                disabled={streamState.status === 'stopping'}
                onClick={() => void onStop()}
              />
            ) : (
              <Button
                appearance="primary"
                icon={<ArrowUp24Regular />}
                aria-label={t('chat.send')}
                title={t('chat.send')}
                disabled={busy || draft.trim().length === 0}
                onClick={() => void onSend()}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
