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
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp24Regular } from '@fluentui/react-icons';
import { listCharacters, listMessages } from '../../api/commands';
import type { ChatMessage } from '../../api/types';
import { EmptyState } from '../../components/EmptyState';
import { formatClock } from '../../lib/relativeTime';
import { useUiStore } from '../../stores/ui';

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
    justifyContent: 'flex-end',
  },
});

/**
 * 聊天主视图（UI-001 / UC-001）。
 * 当前为静态原型：内容按原文显示；markdown-lite 解析与流式动画在引擎搬家（阶段 4）后接入（FR-002/004）。
 */
export function ChatView() {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [characterNames, setCharacterNames] = useState<Map<number, string>>(new Map());
  const [draft, setDraft] = useState('');
  const streamRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void listCharacters().then((characters) => {
      setCharacterNames(new Map(characters.map((c) => [c.id, c.name])));
    });
  }, []);

  useEffect(() => {
    if (activeSessionId === null) {
      setMessages([]);
      return;
    }
    void listMessages(activeSessionId).then(setMessages);
  }, [activeSessionId]);

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  if (activeSessionId === null) {
    return <EmptyState message={t('chat.empty')} />;
  }

  const speakerOf = (message: ChatMessage): string => {
    if (message.role === 'user') return t('chat.you');
    return (message.characterId !== null && characterNames.get(message.characterId)) || '—';
  };

  return (
    <div className={styles.root}>
      <div className={styles.stream} ref={streamRef}>
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
              <div
                className={mergeClasses(styles.msgBody, isUser && styles.msgBodyUser)}
              >
                {message.content}
              </div>
              {message.interrupted && (
                <Badge className={styles.interrupted} appearance="outline" shape="rounded">
                  {t('chat.interrupted')}
                </Badge>
              )}
            </div>
          );
          })}
        </div>
      </div>
      <div className={styles.composer}>
        <div className={styles.composerCard}>
          <Textarea
            root={{ className: styles.inputRoot }}
            textarea={{ className: styles.input }}
            resize="none"
            placeholder={t('chat.placeholder')}
            value={draft}
            onChange={(_, data) => setDraft(data.value)}
          />
          <div className={styles.composerActions}>
            <Button
              appearance="primary"
              icon={<ArrowUp24Regular />}
              aria-label={t('chat.send')}
              title={t('chat.send')}
              disabled={draft.trim().length === 0}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
