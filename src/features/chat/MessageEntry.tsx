/**
 * 消息条目（2026-09-16 对话流二次重设计定稿：顶签卡，用户在六形态比选中
 * 拍板）：分组卡壳（6px 圆角 + stroke1 边 + bg1 面，SettingsCard 语言）+
 * 顶缘 3px 说话人色签——角色条取模板卡强调色（speakerIdentity 链），用户条
 * 中性灰；卡内题头带（说话人左，中断徽标与时间一并缀于带尾、徽标在时间前
 * （2026-09-16 用户指定）；同日用户拍板姓名题头化：底缘细线分区、无底面
 * 着色，姓名升 fg1 半粗作卡面标题）+ 正文全幅。重新
 * 生成钮挂在末条 AI 回复卡内（同日用户指定，自输入区移入、只留图标；
 * ChatView 按末条 assistant 注入回调）。比选脚手架
 * （StyleProbeSwitcher 与落选五形态）已拆除；流式行卡壳在
 * useMessageCardStyles 同语言（顶签值互指，改值须同步）。
 */
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular } from '@fluentui/react-icons';
import type { ChatMessage } from '../../api/types';
import { useTranslation } from 'react-i18next';
import { HistoryMessageBody } from './HistoryMessageBody';
import { useChatViewStyles } from './useChatViewStyles';

const useStyles = makeStyles({
  entry: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: '0px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    // 顶签 = 顶缘 3px 色签，其余三边 1px；颜色经行内 borderTopColor 注入
    //（说话人角色色是动态值进不了 Griffel 类）。与流式行卡壳
    //（useMessageCardStyles.card）同值互指
    borderRadius: tokens.borderRadiusLarge,
    borderTopWidth: '3px',
    // 卡壳不自带内边距：题头带满幅贴边，正文内边距由 main 自担（与流式行同值）
  },
  // 题头带：说话人左 / 时间右，底缘细线与正文分区（无底面着色，题头带透明
  // 落在卡壳 bg1 上）。与 useMessageCardStyles.header 同值互指（改值须同步）
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalS,
    minWidth: '0px',
    padding: '8px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  // 说话人名：彩色身份交给顶签，名字升为卡面标题（fg1 半粗 base300）；
  // marginRight:auto 吸收富余空间——中断徽标与时间因此一并贴带尾
  speaker: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    marginRight: 'auto',
  },
  time: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: '0px',
    padding: '12px 16px',
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
  // 卡内重生成钮：图标钮收拢贴左（flex column 默认 stretch 会拉通满卡宽）；
  // marginTop 在正文区 8px gap 之上再空一档，与正文拉开呼吸感。
  // subtle 在 hover/按压会把图标染成品牌色调（NeutralForeground2Brand*），
  // 与「前景保持中性」拍板冲突：按选择器特异度 (0,3,1)/(0,4,1) 压过 subtle
  // 内置的 (0,3,0)/(0,4,0) 图标色规则——前景恒中性，反馈只走背景色
  regenerate: {
    alignSelf: 'flex-start',
    marginTop: tokens.spacingVerticalS,
    '&:hover span.fui-Button__icon': { color: tokens.colorNeutralForeground1 },
    '&:hover:active span.fui-Button__icon': { color: tokens.colorNeutralForeground1 },
    '&:active:focus-visible span.fui-Button__icon': { color: tokens.colorNeutralForeground1 },
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
  /** 重新生成回调（2026-09-16 用户指定：钮移入末条 AI 回复卡内）。仅末条
   *  assistant 由 ChatView 注入；缺席即不渲染钮。 */
  onRegenerate?: (() => void) | undefined;
  /** 生成进行中的禁用态（ChatView busy，与原输入区钮同语义）。 */
  regenerateDisabled?: boolean | undefined;
}

export function MessageEntry(props: MessageEntryProps) {
  const { message, speaker, speakerColor, time, onRegenerate, regenerateDisabled } = props;
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
      <div className={styles.header}>
        <Text className={styles.speaker}>{speaker}</Text>
        {/* 中断状态缀于时间前（2026-09-16 用户指定）：状态属消息元信息，与
            姓名/时间同带；富余空间由姓名的 marginRight:auto 吸收，徽标与时间
            一并贴带尾，题头 gap 提供两者间距 */}
        {message.interrupted && (
          <Badge appearance="outline" shape="rounded">
            {t('chat.interrupted')}
          </Badge>
        )}
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
        {onRegenerate !== undefined && (
          // 重新生成（2026-09-16 自输入区移入末条 AI 回复卡内；同日用户拍板
          // 只留图标、上方加大间距、无边框）。外观用 Fluent subtle：前景中性
          // 色不着色、无边框，悬停/按压染背景色（hover=bg2、按压=bg2Pressed）。
          // 图标钮无可读文字，可访问名由 Tooltip relationship=
          // "label" 静态注入的 aria-label 承担（C3，同发送/停止钮）；
          // disabledFocusable 而非原生 disabled：禁用期悬停提示仍可达（CAND-05）
          <Tooltip content={t('chat.regenerate')} relationship="label">
            <Button
              size="small"
              appearance="subtle"
              className={styles.regenerate}
              icon={<ArrowSync24Regular />}
              aria-label={t('chat.regenerate')}
              disabledFocusable={regenerateDisabled === true}
              onClick={(event) => {
                // 本钮随旧条摘除而卸载：带焦元素从 DOM 移除时 Chromium 焦点
                // 回退会把滚动容器弹回顶部（2026-09-16 实测复现，scrollTop
                // 底部 → 0），点击瞬间先失焦再触发重生成
                event.currentTarget.blur();
                onRegenerate();
              }}
            />
          </Tooltip>
        )}
      </div>
    </div>
  );
}
