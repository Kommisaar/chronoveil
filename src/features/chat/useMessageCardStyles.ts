/**
 * 流式消息行卡壳（2026-09-16 对话流二次重设计定稿「顶签卡」）：与历史条目
 * （MessageEntry.entry）同语言——分组卡壳 6px 圆角 + stroke1 边 + bg1 面 +
 * 顶缘 3px 说话人色签（颜色经行内 borderTopColor 注入）。两处卡壳声明同值
 * 互指（改值须同步）；正文排版（body）同值互指，HistoryMessageBody 亦消费。
 */
import { makeStyles, tokens } from '@fluentui/react-components';

export const useMessageCardStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    width: '100%',
    padding: '12px 16px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusLarge,
    // 顶缘 3px 色签（MessageEntry.entry 同值互指）；颜色行内注入
    borderTopWidth: '3px',
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalS,
    minWidth: '0px',
  },
  // 说话人名：彩色身份交给顶签，名字保持安静（fg2 半粗小字，MessageEntry 同值）
  speaker: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  body: {
    fontSize: tokens.fontSizeBase300,
    lineHeight: '1.8',
    // 块内单换行随解析器保留上屏（审计问题 3）：解析器的微停规则认 \n，
    // 缺 pre-wrap 会把刻意保留的换行折叠成空格（MessageEntry.body 与
    // HistoryMessageBody 均同值）。横向溢出不依赖 white-space 承担：长词
    // 断行由 word-break 负责（pre-wrap 只保留空白，不断词）
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
});
