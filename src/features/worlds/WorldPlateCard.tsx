/**
 * 世界页横版「图版卡」（gallery 档，2026-09-15 晚间用户批准重设计定稿）：
 * 上图下文——顶部 96px 世界色画布（worldGradientOf 渐变 + 首字水印）+
 * 信息体（世界名 / 历法徽章·更新日期 / 世界观摘录）。设计主张：卡面承载
 * 身份（世界观正文是主角），配置信息（历法/日期）退居次位；竖=角色域、
 * 横=世界域，形态即域别——横版图版卡对齐角色页海报墙的视觉分量，替代
 * 同日早前的「6px 色带 + 两行字」档案卡定稿（后者降级为 ledger/stage 过渡档）。
 *
 * - 原生 button（非 Fluent Card，同档案卡先例）：宽扁信息卡不需要 Card 的
 *   interactive 语义栈，裸 button + Griffel 类即测试契约「点击进编辑」，
 *   Enter/Space 原生自带；
 * - 必须挂 data-editor-trigger={world.id}：编辑器 getTriggerRect 按世界 id
 *   现测本卡矩形做 FLIP 共享元素过渡（Task-08 编辑器接线依赖，替换旧档案
 *   卡时不可丢）；
 * - 圆角 SURFACE_RADIUS_PAGE_CARD（16px，页级卡面规范见 surfaceSpec.ts）：
 *   图版卡与海报卡同升页面级卡面档；overflow hidden 让色画布裁进圆角；
 * - 悬停无位移（仅底色变化）：lift 的 translateY/scale 在宽扁信息卡上观感
 *   浮动（用户定稿，沿档案卡口径），hover/pressed 只换底色，不 lift；
 * - 世界观摘录空态渲染占位（worldbookEmpty）：与海报卡「空则整行不渲染」
 *   是有意的拍板差异——图版卡有独立正文区（摘录是身份主角），空态占位是
 *   「去写下世界观」的行动邀请而非噪声；海报卡无正文区，占位只会挤占
 *   海报视觉（差异决策记录于两卡文件头）；
 * - 入场动画与档案卡/海报卡同款（card-enter-pop 弹簧 + useRevealOnScroll
 *   视口揭示批内错峰）。
 */
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorldSummary } from '../../api/types';
import { POP_IN_MS, SPRING_CURVE } from '../../components/motion';
import { SURFACE_RADIUS_PAGE_CARD } from '../../components/surfaceSpec';
import { excerptOf } from '../../lib/excerpt';
import { worldGradientOf } from './worldGradient';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    padding: '0px',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    // 页级卡面 16px 大圆角（surfaceSpec.ts 单一事实源），overflow hidden
    // 把色画布裁进圆角
    borderRadius: SURFACE_RADIUS_PAGE_CARD,
    backgroundColor: tokens.colorNeutralBackground1,
    overflow: 'hidden',
    // 原生 button 自带 user agent 字色/居中/表单字体，全部收编到主题
    color: tokens.colorNeutralForeground1,
    textAlign: 'left',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    cursor: 'pointer',
    // 悬停无位移（定稿，见文件头）：仅底色轻变，不 lift
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
    ':active': {
      backgroundColor: tokens.colorNeutralBackground1Pressed,
    },
  },
  // 世界色画布：整块 aria-hidden（渐变与首字水印皆纯装饰，不进 a11y 树）
  canvas: {
    height: '96px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 首字水印：同海报卡 letterB 的色档与 userSelect 档，字号按横版矮画布收窄
  letter: {
    fontSize: '48px',
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: 1,
    color: 'rgba(255, 255, 255, 0.24)',
    userSelect: 'none',
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '12px 16px 14px',
  },
  name: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    minWidth: 0,
  },
  // 历法徽章（小 pill）：历法名出自预设五选（有界长度），nowrap 防止 pill
  // 内断行变形
  calendarBadge: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '1px 8px',
    whiteSpace: 'nowrap',
  },
  // 世界观摘录（身份主角）：两行 clamp——多行截断只能走 -webkit-box 老盒模
  // （标准 line-clamp 尚未落地），griffel 直收 vendor 属性键
  excerpt: {
    display: '-webkit-box',
    WebkitLineClamp: '2',
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  // 空态占位（worldbookEmpty）：同款两行 clamp，色档降一档示弱（见文件头
  // 与海报卡的拍板差异）
  excerptEmpty: {
    color: tokens.colorNeutralForeground3,
  },

  // —— 入场动画（与档案卡/海报卡同款；keyframes 在 app.css；reduced-motion
  //    门控在 @media 内）。揭示前占位：滚入视口前以透明等待；揭示后换动画类，
  //    backwards fill 在批内延迟期接手维持 from 态，动画止于自然态。 ——
  preReveal: {
    opacity: 0,
  },
  enterPop: {
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'card-enter-pop',
      // 弹簧入场档（POP_IN_MS）与曲线 SPRING_CURVE 均出自 src/components/motion.ts
      animationDuration: `${POP_IN_MS}ms`,
      animationTimingFunction: SPRING_CURVE,
      animationFillMode: 'backwards',
      animationDelay: 'var(--enter-delay, 0ms)',
    },
  },
});

export interface WorldPlateCardProps {
  world: WorldSummary;
  /** 卡片在网格中的序号：进 useRevealOnScroll 的 ref 登记与错峰取值。 */
  index: number;
  /** 揭示动画批内错峰延迟（ms）；undefined = 尚未滚入视口，透明占位。 */
  revealDelay: number | undefined;
  /** callback ref 工厂（useRevealOnScroll）：登记元素供 IntersectionObserver 观察。 */
  register: (index: number) => (el: Element | null) => void;
  /** 点击 / Enter / 空格进编辑（原生 button 自带键盘激活）。 */
  onOpen: (world: WorldSummary) => void;
}

export function WorldPlateCard({ world, index, revealDelay, register, onOpen }: WorldPlateCardProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const enterStyle =
    revealDelay === undefined
      ? undefined
      : ({ '--enter-delay': `${revealDelay}ms` } as CSSProperties);
  const excerpt = excerptOf(world.worldbook, 64);

  return (
    <button
      type="button"
      ref={register(index)}
      // FLIP 共享元素过渡锚点：编辑器 getTriggerRect 按世界 id 现测本卡矩形
      data-editor-trigger={world.id}
      className={mergeClasses(
        styles.card,
        revealDelay === undefined ? styles.preReveal : styles.enterPop,
      )}
      style={enterStyle}
      onClick={() => onOpen(world)}
    >
      {/* 世界色画布：每世界恒定（worldGradientOf，同档案卡色带规则） */}
      <span className={styles.canvas} style={{ backgroundImage: worldGradientOf(world.id) }} aria-hidden>
        <span className={styles.letter}>{world.name.slice(0, 1)}</span>
      </span>
      <span className={styles.body}>
        <span className={styles.name}>{world.name}</span>
        <span className={styles.meta}>
          {/* 历法徽章：null 历法 → 「默认数字历」；有历法无名 → 空串 */}
          <span className={styles.calendarBadge}>
            {world.calendar === null ? t('worlds.calendarNone') : world.calendar.name ?? ''}
          </span>
          <span aria-hidden>·</span>
          <span>{new Date(world.updatedAt).toLocaleDateString()}</span>
        </span>
        {/* 世界观摘录（身份主角）：空态占位是行动邀请，见文件头拍板差异 */}
        {excerpt ? (
          <span className={styles.excerpt}>{excerpt}</span>
        ) : (
          <span className={mergeClasses(styles.excerpt, styles.excerptEmpty)}>
            {t('worlds.worldbookEmpty')}
          </span>
        )}
      </span>
    </button>
  );
}
