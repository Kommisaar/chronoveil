import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  Text,
  Textarea,
  mergeClasses,
} from '@fluentui/react-components';
import {
  ArrowSync24Regular,
  ArrowUp24Regular,
  Notebook24Regular,
  RecordStop24Regular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  cancelGeneration,
  getConfig,
  listMessages,
  regenerateLast,
  sendMessage,
} from '../../api/commands';
import { isTauri } from '../../api/client';
import type {
  ChatMessage,
  ConfigDto,
} from '../../api/types';
import { EmptyState } from '../../components/EmptyState';
import { formatClock } from '../../lib/relativeTime';
import { useUiStore } from '../../stores/ui';
import { HistoryMessageBody } from './HistoryMessageBody';
import { LedgerPanel } from './ledgerPanel';
import { StreamingMessage } from './StreamingMessage';
import { CANCEL_REASON, streamHub } from './streamHub';
import { engineThemeVars, useChatViewStyles } from './useChatViewStyles';

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
 * 叙事账本（FR-012）：头部右上浮动钮开关右侧内嵌面板，数据拉取与终态刷新
 * 内聚在 LedgerPanel，本视图只管开合与换会话换参。
 */
export function ChatView() {
  const styles = useChatViewStyles();
  const { t, i18n } = useTranslation();
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  // 会话清单单一数据源在 ui store（TASK-007 验收 4）：与 Sidebar 同源，
  // 不再各自 listSessions 本地缓存；重拉触发点统一在 store.refreshSessions
  const sessions = useUiStore((s) => s.sessions);
  // 事件级活性刷新（TASK-010）：落库 / 终态时点触发，失败在 store 侧静默
  const refreshSessionsQuietly = useUiStore((s) => s.refreshSessionsQuietly);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [config, setConfig] = useState<ConfigDto | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // 叙事账本面板开关（FR-012）：面板数据自管（挂载即拉取），这里只管开合
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const streamRef = useRef<HTMLDivElement | null>(null);

  // 流式生成状态（模块级 hub：切走会话不丢，FR-007）
  const hubVersion = useSyncExternalStore(streamHub.subscribe, streamHub.getVersion);
  const streamState = streamHub.stateOf(activeSessionId);
  const busy = pending || streamState !== null;

  useEffect(() => {
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
    const sessionId = activeSessionId;
    // 切会话竞态守卫（同 ledgerPanel 的 cancelled 模式）：卸载或切换后慢返的
    // 旧响应不落 state，防止覆盖新会话消息（U2）
    let cancelled = false;
    void listMessages(sessionId).then((fresh) => {
      if (!cancelled && useUiStore.getState().activeSessionId === sessionId) {
        setMessages(fresh);
      }
    });
    return () => {
      cancelled = true;
    };
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

  // 当前会话的 roster 回显（多角色阵容制）：历史消息说话人 / 流式行归属都按
  // 实例取——assistant 消息的 characterId 是说话实例真值（user 条恒 null），
  // 名字从会话的 instances 回显映射（实例身份的权威来源，D1 快照）。
  const activeRoster = sessions.find((s) => s.id === activeSessionId)?.instances ?? [];
  const instanceNames = new Map(activeRoster.map((instance) => [instance.id, instance.name]));

  const speakerOf = (message: ChatMessage): string => {
    if (message.role === 'user') return t('chat.you');
    return message.characterId === null ? '—' : (instanceNames.get(message.characterId) ?? '—');
  };

  // 流式行说话人：首个 LLM 位实例。D3 逐拍生成的按实例归属待 Rust 事件携带
  // 实例 id（事件流 v1 不区分实例），先以主 LLM 位显示；renderStyle 读实例
  // 快照回显（D1：改卡不回写，动态造人实例也无模板卡可查）。
  // 不做 `?? activeRoster[0]` 兜底：阵容无 LLM 位时把用户位当流式发声人是错误
  // 归属，缺位就诚实缺省（'—' / 无动效参数）。
  const primaryLlm = activeRoster.find((instance) => !instance.isUser);
  const sessionSpeaker = primaryLlm?.name ?? '—';
  const tuning = {
    style: primaryLlm?.renderStyle,
    msPerChar: config?.rhythmMsPerChar,
    punctPause: config?.punctPauseEnabled,
    durationMs: config?.animDurationBase,
  };
  const lastIsAssistant = messages.length > 0 && messages[messages.length - 1]?.role === 'assistant';

  return (
    <div className={styles.root}>
      <div className={styles.chatColumn}>
        {/* 叙事账本开关（FR-012）：聊天列右上角浮动钮（布局无头部条带，
            从众 AppShell 展开钮先例），aria-expanded 即开合语义 */}
        <button
          type="button"
          className={styles.ledgerToggle}
          aria-controls="ledger-panel"
          aria-expanded={ledgerOpen}
          aria-label={t('chat.ledger.title')}
          title={t('chat.ledger.title')}
          onClick={() => setLedgerOpen((open) => !open)}
        >
          <Notebook24Regular />
        </button>
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
                  // IME 组合期（中文等输入法确认候选词）的 Enter 属编辑行为，
                  // 不触发发送（U1），否则会发出半截消息
                  if (event.nativeEvent.isComposing) return;
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
      {ledgerOpen && <LedgerPanel sessionId={activeSessionId} />}
    </div>
  );
}
