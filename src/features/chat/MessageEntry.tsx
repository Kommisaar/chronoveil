/**
 * 消息条目（2026-09-16 对话流二次重设计定稿：顶签卡，用户在六形态比选中
 * 拍板）：分组卡壳（6px 圆角 + stroke1 边 + bg1 面，SettingsCard 语言）+
 * 顶缘 3px 说话人色签——角色条取模板卡强调色（speakerIdentity 链），用户条
 * 中性灰；卡内信头式题头（说话人左 / 时间右）+ 正文全幅。比选脚手架
 * （StyleProbeSwitcher 与落选五形态）已拆除；流式行卡壳在
 * useMessageCardStyles 同语言（顶签值互指，改值须同步）。
 */
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Badge,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import type { ChatMessage } from '../../api/types';
import { useTranslation } from 'react-i18next';
import { HistoryMessageBody } from './HistoryMessageBody';
import { useChatViewStyles } from './useChatViewStyles';

const useStyles = makeStyles({
  entry: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: '0px',
    padding: '12px 16px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    // 顶签 = 顶缘 3px 色签，其余三边 1px；颜色经行内 borderTopColor 注入
    //（说话人角色色是动态值进不了 Griffel 类）。与流式行卡壳
    //（useMessageCardStyles.card）同值互指
    borderRadius: tokens.borderRadiusLarge,
    borderTopWidth: '3px',
  },
  meta: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalS,
    minWidth: '0px',
  },
  // 说话人名：彩色身份交给顶签，名字保持安静（fg2 半粗小字）
  speaker: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  time: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginLeft: 'auto',
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: '0px',
  },
  body: {
    fontSize: tokens.fontSizeBase300,
    lineHeight: '1.8',
    // 块内单换行随解析器保留上屏（审计问题 3）：解析器的微停规则认 \n，
    // 缺 pre-wrap 会把刻意保留的换行折叠成空格。横向溢出不依赖 white-space
    // 承担：长词断行由 word-break 负责（HistoryMessageBody 与流式行同值）
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  reasoning: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  // 中断标记卡内收拢贴左（flex column 默认 stretch 会拉通满卡宽）
  interrupted: {
    alignSelf: 'flex-start',
    fontSize: tokens.fontSizeBase200,
  },
});

export interface MessageEntryProps {
  message: ChatMessage;
  /** 说话人名（ChatView 按阵容快照回显，未知 '—'）。 */
  speaker: string;
  /** 顶签颜色（角色条 = 角色色，用户条中性灰，speakerIdentity 链）。 */
  speakerColor: string;
  /** 时间标签（ChatView formatClock）。 */
  time: string;
}

export function MessageEntry(props: MessageEntryProps) {
  const { message, speaker, speakerColor, time } = props;
  const styles = useStyles();
  const view = useChatViewStyles();
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  return (
    <div
      className={styles.entry}
      // 顶签颜色是动态值进不了 Griffel 类，行内覆写类内占位顶缘色
      style={{ borderTopColor: speakerColor }}
    >
      <div className={styles.meta}>
        <Text className={styles.speaker}>{speaker}</Text>
        <span className={styles.time}>{time}</span>
      </div>
      <div className={styles.main}>
        {/* 思考两态切换机制现状（M4 / ADR-011 分工保留，自 ChatView 历史行
            迁入）：流式期由引擎在 StreamingMessage 的容器内渲染 think 胶囊
            （engine.css 只读），本处 Accordion 是落库终态形态。收尾瞬间
            （settleSession）：refresh 的 setMessages(fresh) 与紧随的
            streamHub.end() 在同一轮 React 提交生效——历史行（新 key）挂载与
            流式行卸载同帧完成，是列表重挂载替换而非同元素两态切换，两形态无
            共存帧，真正的交叉淡化（旧淡出叠新淡入）无落点。退而求其次：终态
            侧 200ms 淡入（reasoningEnter，档位 motion.ts CROSSFADE_MS）消硬
            切感；流式胶囊瞬时移除是已知取舍。淡入挂在 Accordion 挂载上不区分
            收尾/载入：会话载入时思考折叠随页面渐入同语言淡入。 */}
        {message.reasoning !== null && (
          <Accordion
            className={mergeClasses(view.reasoning, view.reasoningEnter)}
            collapsible
          >
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
          <div className={styles.body}>{message.content}</div>
        ) : (
          <HistoryMessageBody content={message.content} />
        )}
        {message.interrupted && (
          <Badge className={styles.interrupted} appearance="outline" shape="rounded">
            {t('chat.interrupted')}
          </Badge>
        )}
      </div>
    </div>
  );
}
