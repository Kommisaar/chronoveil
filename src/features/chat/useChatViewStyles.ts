/**
 * ChatView 的视图样式单一事实源：消息行叙事流排版 + 输入卡 + 引擎主题变量
 * 覆写。从 ChatView.tsx 拆出（500 行规范），导出形式从众 useLedgerSectionStyles
 * 先例；视图行为注释随归属搬移，逐字保留。
 * 导出钩子是合成入口：账本开关钮的外观/反馈由 useGhostIconButtonStyles 统一
 * 规格（审计 C2 迁入），基础 makeStyles 只保留排版与本地特例。
 */
import { makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import type { CSSProperties } from 'react';
import { CROSSFADE_MS, DECELERATE_CURVE } from '../../components/motion';
import { SURFACE_RADIUS_PAGE_CARD } from '../../components/surfaceSpec';
import { useGhostIconButtonStyles } from '../../components/useGhostIconButtonStyles';

const useChatViewBaseStyles = makeStyles({
  // 根改双列（叙事账本面板，FR-012）：聊天列 + 可选账本列；面板开合不挤压
  // 聊天流的滚动位置（stream 自身滚动容器不变）
  root: {
    height: '100%',
    display: 'flex',
  },
  // 聊天列：账本开关钮的定位包含块（浮动钮从众 AppShell 的 expandBtn 先例）
  chatColumn: {
    position: 'relative',
    flex: 1,
    minWidth: 0,
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  // 叙事账本开关钮（聊天列右上角浮动，头部无条带的布局下即事实上的头部区；
  // 15% 右边距的留白带内，常态不压消息正文）：只保留浮置定位与不透明底——
  // 外观（36px 容器 / 20px 图标 / borderRadiusMedium / 悬停提亮一阶前景升一阶 /
  // 键盘焦点环）由 useGhostIconButtonStyles('medium') 统一供给（审计 C2 迁入）。
  // 不透明底是该钩子头注列明的「浮于内容之上」已知特例：滚动内容不得从钮底透出
  ledgerToggleFloating: {
    position: 'absolute',
    top: '8px',
    right: '12px',
    zIndex: 2,
    backgroundColor: tokens.colorNeutralBackground1,
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
  // 思考两态收尾过渡（M4）：终态 Accordion 挂载即播 200ms 淡入（keyframes
  // 在 app.css 的 reasoning-fade-in），消「流式胶囊 → 折叠头」同位硬切感。
  // 挂载动画无延迟，fill-mode 无需 backwards。「减弱动态」下整个 @media
  // 分支缺席 → 直接切换无过渡（从众 useCardLiftStyles / enterPop 修法）。
  // 档位与机制见 motion.ts 的 CROSSFADE_MS 注释与 ChatView 渲染处注释。
  reasoningEnter: {
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'reasoning-fade-in',
      animationDuration: `${CROSSFADE_MS}ms`,
      animationTimingFunction: DECELERATE_CURVE,
    },
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
  // 卡片，底部动作行只留发送按钮。16px 是「页面级卡面」档（与角色编辑器
  // 面板、列表卡面同层），单一事实源见 src/components/surfaceSpec.ts 的两档
  // 规范——分组卡（SettingsCard）走 token 阶梯，不属本档
  composerCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '10px 12px 10px 16px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: SURFACE_RADIUS_PAGE_CARD,
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
 * 视图样式合成入口（消费方不变仍是一把取全）：基础排版 + 幽灵图标钮规格。
 * ledgerToggle = useGhostIconButtonStyles('medium') 打底，浮置定位与不透明底
 * 作为本地特例后置 mergeClasses（Griffel 约定：后写覆盖前，原因见该钩子头注）；
 * ledgerToggleFloating 不单独外泄——直接消费会丢掉统一外观。
 */
export function useChatViewStyles() {
  const base = useChatViewBaseStyles();
  const ghost = useGhostIconButtonStyles('medium');
  const { ledgerToggleFloating, ...view } = base;
  return {
    ...view,
    ledgerToggle: mergeClasses(ghost.root, ledgerToggleFloating),
  };
}

/**
 * 引擎命名空间主题变量的聊天侧覆写（审计问题 3，保守适配）：engine.css 顶部的
 * --cv-* 默认值 = demo 暗色硬编码，聊天流容器按 Fluent 主题 token 覆写后随
 * 主题切换。内联 CSS 变量（而非 Griffel 规则）：变量名不在 Griffel 属性白名单，
 * 且行内样式挂在容器上即对全部引擎直插 DOM（历史行 + 流式行）生效。
 * - 场景线 ✦ 挖空底必须与所在表面背景一致：聊天表面是 AppShell content 的
 *   colorNeutralBackground1，暗色主题下 demo 的 #141822 本就是错色矩形；
 * - ✦ 记号色随 UI 次级前景；
 * - 线体 / 动作 / 加粗 / decode 等文字色无需在此覆写：引擎已按所在表面明暗
 *   自适应注入亮/暗两套语法配色（src/engine/theme.ts 双主题调色板，亮色
 *   对比度达 AA），features 侧零改动。
 */
export const engineThemeVars = {
  '--cv-scene-line-bg': tokens.colorNeutralBackground1,
  '--cv-scene-line-mark': tokens.colorNeutralForeground3,
} as CSSProperties;
