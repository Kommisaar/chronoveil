/**
 * 消息卡样式（2026-09-16 用户拍板「角色色轨卡」，取代 2026-09-08 的去卡片化
 * 叙事流）：每条对话条目一张全宽分组卡——说话人以左缘 3px 色轨标识（角色条
 * 取该卡强调色 accentColorOf，用户条中性灰，见 speakerIdentity.ts），卡内题头
 * 行（说话人 + 时间）+ 正文。历史行（ChatView）与流式行（StreamingMessage）
 * 共用本钩子，保证两形态卡壳逐值一致。
 *
 * 档位与规范：圆角走分组卡档 borderRadiusLarge（6px，SettingsCard 同款，
 * surfaceSpec 两档规范中非页面级档）；边框 stroke1、卡面 bg1（分组卡语言）；
 * 色轨以 borderLeft 3px 落地、颜色由调用方经行内 borderLeftColor 注入
 * （动态色进不了 Griffel 类，行内样式覆盖类占位色）。
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
    // 三边 1px + 左缘 3px：色轨即左边框，圆角处由浏览器自然拼接；
    // 左色是类内占位，运行时必被行内 borderLeftColor 覆写（speakerIdentity）
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    borderLeft: `3px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  // 题头行：说话人左、时间右（信头式）。基准色 fg3 供时间继承
  header: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  // 说话人名：色轨已承载身份色，名字保持安静（fg2 半粗），不再用品牌色
  speaker: {
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
  },
  body: {
    fontSize: tokens.fontSizeBase300,
    lineHeight: '1.8',
    // 块内单换行随解析器保留上屏（审计问题 3）：解析器的微停规则认 \n，
    // 缺 pre-wrap 会把刻意保留的换行折叠成空格（流式行同款）。横向溢出不
    // 依赖 white-space 承担：长词断行由 word-break 负责
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
});
