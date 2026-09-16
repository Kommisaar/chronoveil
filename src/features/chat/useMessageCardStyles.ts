/**
 * 流式消息行卡壳（2026-09-16 对话流二次重设计定稿「顶签卡」）：与历史条目
 * （MessageEntry.entry）同语言——分组卡壳 6px 圆角 + stroke1 边 + bg1 面 +
 * 顶缘 3px 说话人色签（颜色经行内 borderTopColor 注入）+ 题头带（同日用户
 * 拍板姓名题头化：底缘细线分区、无底面着色，姓名升 fg1 半粗）。两处卡壳声明
 * 同值互指（改值须同步）；正文排版（body）同值互指，HistoryMessageBody 亦消费。
 */
import { makeStyles, tokens } from '@fluentui/react-components';

export const useMessageCardStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusLarge,
    // 顶缘 3px 色签（MessageEntry.entry 同值互指）；颜色行内注入
    borderTopWidth: '3px',
    // 卡壳不自带内边距：题头带满幅贴边，正文内边距由 main 自担
    // （MessageEntry.entry 同值互指）
  },
  // 题头带：说话人名居左（流式行无钟面时间），底缘细线与正文分区（无底面
  // 着色，透明落在卡壳 bg1 上；MessageEntry.header 同值互指，改值须同步）
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalS,
    minWidth: '0px',
    padding: '8px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  // 说话人名升为卡面标题 fg1 半粗 base300（MessageEntry.speaker 同值互指）
  speaker: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
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
    // 缺 pre-wrap 会把刻意保留的换行折叠成空格（MessageEntry.body 与
    // HistoryMessageBody 均同值）。横向溢出不依赖 white-space 承担：长词
    // 断行由 word-break 负责（pre-wrap 只保留空白，不断词）
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
});
