/**
 * 世界页名册行（ledger 档，2026-09-15 三方向对比期第二档）：编辑风条目
 * 列表——行间留白 + 1px 细线、无卡片框，身份信息（世界观摘录）同行展示。
 *
 * - 原生 button（同 WorldPlateCard 先例）：行即「点击进编辑」的测试契约，
 *   Enter/Space 原生自带；user agent 字色/居中/表单字体全部收编到主题；
 * - 左 44px 方形世界色块：worldGradientOf 渐变底 + 居中白色首字（同世界恒
 *   同色；视觉档与角色行对齐，两页共用全局档位时形态一致）；整块
 *   aria-hidden（同图版卡画布拍板）；
 * - 信息列三行：世界名 + 同行历法徽章 pill（样式抄 WorldPlateCard 徽章）/
 *   世界观摘录（excerptOf 64 字档单行截断；空则渲染空态占位——图版卡拍板：
 *   摘录是身份主角，空态占位是「去写下世界观」的行动邀请）/ 更新日期；
 * - data-editor-trigger 必挂：编辑器 getTriggerRect 按世界 id 现测本行矩形
 *   做 FLIP 共享元素过渡；入场 preReveal/enterPop + register/revealDelay
 *   props 同图版卡形态（keyframes 在 app.css）。
 */
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorldSummary } from '../../api/types';
import { POP_IN_MS, SPRING_CURVE } from '../../components/motion';
import { excerptOf } from '../../lib/excerpt';
import { worldGradientOf } from './worldGradient';

const useStyles = makeStyles({
  // —— 行本体：横向 flex = 世界色块 + 信息列（契约与角色行同族，见文件头） ——
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: '10px 12px',
    // 行内小件档圆角（与角色行同档；页面级 16px 大圆角是图版卡的身份）
    borderRadius: tokens.borderRadiusMedium,
    border: '0px',
    backgroundColor: tokens.colorNeutralBackground1,
    // 原生 button 自带 user agent 字色/居中/表单字体，全部收编到主题
    color: tokens.colorNeutralForeground1,
    textAlign: 'left',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    cursor: 'pointer',
    width: '100%',
    // 悬停无位移（同图版卡口径）：仅底色变，不 lift
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
    ':active': {
      backgroundColor: tokens.colorNeutralBackground1Pressed,
    },
    // 行分隔细线（设计定稿「留白 + 1px 细线」）：末行无线，不封边框
    ':not(:last-child)': {
      borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    },
  },

  // —— 左 44px 方形世界色块 ——
  identity: {
    width: '44px',
    height: '44px',
    flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityLetter: {
    fontSize: '20px',
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: 1,
    // 白色首字（方案拍板）：worldGradientOf 调色板恒深色低饱和，白字可读
    color: '#ffffff',
    userSelect: 'none',
  },

  // —— 信息列：三行（名字+徽章 / 摘录 / 日期） ——
  info: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
    flexShrink: 1,
  },
  nameLine: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  name: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
  // 历法徽章（小 pill，样式抄 WorldPlateCard 徽章）：历法名出自预设五选
  // （有界长度），nowrap 防止 pill 内断行变形；flexShrink 0 防被长名字挤没
  calendarBadge: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '1px 8px',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase200,
    flexShrink: 0,
  },
  excerpt: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // 空态占位（worldbookEmpty）：色档降一档示弱（同图版卡拍板，见文件头）
  excerptEmpty: {
    color: tokens.colorNeutralForeground3,
  },
  date: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },

  // —— 入场动画（与图版卡/角色行同款；keyframes 在 app.css；reduced-motion
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

export interface WorldLedgerRowProps {
  world: WorldSummary;
  /** 行在名册中的序号：进 useRevealOnScroll 的 ref 登记与错峰取值。 */
  index: number;
  /** 揭示动画批内错峰延迟（ms）；undefined = 尚未滚入视口，透明占位。 */
  revealDelay: number | undefined;
  /** callback ref 工厂（useRevealOnScroll）：登记元素供 IntersectionObserver 观察。 */
  register: (index: number) => (el: Element | null) => void;
  /** 点击 / Enter / 空格进编辑（原生 button 自带键盘激活）。 */
  onOpen: (world: WorldSummary) => void;
}

export function WorldLedgerRow({ world, index, revealDelay, register, onOpen }: WorldLedgerRowProps) {
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
      // FLIP 共享元素过渡锚点：编辑器 getTriggerRect 按世界 id 现测本行矩形
      data-editor-trigger={world.id}
      className={mergeClasses(
        styles.row,
        revealDelay === undefined ? styles.preReveal : styles.enterPop,
      )}
      style={enterStyle}
      onClick={() => onOpen(world)}
    >
      {/* 世界色块：worldGradientOf 每世界恒定（纯装饰不进 a11y 树） */}
      <span className={styles.identity} style={{ backgroundImage: worldGradientOf(world.id) }} aria-hidden>
        <span className={styles.identityLetter}>{world.name.slice(0, 1)}</span>
      </span>
      <span className={styles.info}>
        <span className={styles.nameLine}>
          <span className={styles.name}>{world.name}</span>
          {/* 历法徽章：null 历法 → 「默认数字历」；有历法无名 → 空串（防御
              性兜底，现网历法必有名，复访条件见图版卡徽章注释） */}
          <span className={styles.calendarBadge}>
            {world.calendar === null ? t('worlds.calendarNone') : world.calendar.name ?? ''}
          </span>
        </span>
        {/* 世界观摘录：空态占位是行动邀请（同图版卡拍板，见文件头） */}
        {excerpt ? (
          <span className={styles.excerpt}>{excerpt}</span>
        ) : (
          <span className={mergeClasses(styles.excerpt, styles.excerptEmpty)}>
            {t('worlds.worldbookEmpty')}
          </span>
        )}
        <span className={styles.date}>{new Date(world.updatedAt).toLocaleDateString()}</span>
      </span>
    </button>
  );
}
