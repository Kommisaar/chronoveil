/**
 * 世界页满幅深底卡（stage 档，三方向对比期第三档，2026-09-15）：整卡即
 * worldGradientOf 世界色深底白字，文字全部落在底部黑实底带上。与角色页
 * 舞台卡（CharacterStageCard）同族的「全幅色面」语言——竖色面是角色域、
 * 世界同为整块色面但**内容全部常显**：揭示（hover 浮出称号/人设）是角色
 * stage 卡的专属语言，世界卡无 hover 揭示层。
 *
 * - 内容层级（设计主张同两档：卡面承载身份）：世界名（大字主角）/
 *   历法徽章 pill + 更新日期（配置退居次位）/ 世界观摘录（excerptOf 64
 *   字档两行 clamp；空则渲染「还没有世界观」占位——满幅卡有正文区，占位
 *   是行动邀请，同 WorldPlateCard 拍板）；
 * - 原生 button（非 Fluent Card，同 WorldPlateCard / CharacterStageCard
 *   选型）：裸 button + Griffel 类即测试契约「点击进编辑」，Enter/Space
 *   原生自带；
 * - 文字对比度（新 scrim 常量，本文件单一事实源）：WORLD_BLEED_SCRIM_
 *   ALPHA=0.62 黑实底 + WORLD_BLEED_META_TEXT_ALPHA=0.8 次级白，最坏
 *   合成数学与 CharacterPosterCard 的 POSTER_SCRIM_ALPHA / POSTER_META_
 *   TEXT_ALPHA、CharacterStageCard 的同名约束相同（互指见常量注释），
 *   守卫断言组见 src/components/contrastGuard.test.ts 的 WORLD_BLEED_*
 *   组（结构断言 + 最坏合成计算）；
 * - hover 仅底色微变无位移：白色 5% 薄纱叠层（sheen）自身 :hover 提亮
 *   ——Griffel 无「卡 hover → 子元素变化」的选择器保障，薄纱满幅铺卡且
 *   在 button 内（点击自然冒泡进编辑），装饰层 aria-hidden；只动 opacity，
 *   prefers-reduced-motion 降级为瞬切；
 * - data-editor-trigger / preReveal/enterPop + register/revealDelay 接线
 *   照抄 WorldPlateCard（--enter-delay CSS 变量 + as CSSProperties）。
 */
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorldSummary } from '../../api/types';
import { EDITOR_FADE_MS, POP_IN_MS, SPRING_CURVE } from '../../components/motion';
import { SURFACE_RADIUS_PAGE_CARD } from '../../components/surfaceSpec';
import { excerptOf } from '../../lib/excerpt';
import { worldGradientOf } from './worldGradient';

/**
 * 世界满幅卡文字区压暗下限（本文件单一事实源）：与 CharacterPosterCard 的
 * POSTER_SCRIM_ALPHA（0.62）、CharacterStageCard 的 STAGE_SCRIM_ALPHA（0.62）
 * 同值同语义互指——同为「白字 × 世界色深底」的实底下限，最坏合成数学相同：
 * 实底之下合成灰 = ceil(255 × 0.38) = 97（取整保守）→ 白字对比 ≈6.19:1 ≥
 * AA 4.5:1。守卫断言组：src/components/contrastGuard.test.ts 的
 * WORLD_BLEED_TEXT_SCRIM_FLOOR；改值须四处同步（含守卫）。
 */
const WORLD_BLEED_SCRIM_ALPHA = 0.62;

/**
 * 世界满幅卡次级文字（徽章/日期/摘录）不透明度（本文件单一事实源）：与
 * CharacterPosterCard 的 POSTER_META_TEXT_ALPHA（0.8）、CharacterStageCard
 * 的 STAGE_META_TEXT_ALPHA（0.8）同值同语义互指——半透明白按「合成像素 ×
 * 背景」计对比：0.8 合成 = 223 → ≈4.65:1 ≥ 4.5（0.66 档 ≈3.74:1 不达标，
 * 故空态占位也停在 0.8 档——实底上不存在更低的合法示弱档）。守卫断言组：
 * src/components/contrastGuard.test.ts 的 WORLD_BLEED_TEXT_META_ALPHA；
 * 改值须四处同步（含守卫）。
 */
const WORLD_BLEED_META_TEXT_ALPHA = 0.8;

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end',
    minHeight: '280px',
    padding: '0px',
    border: '0px',
    // 薄纱叠层（sheen，inset:0）的定位包含块
    position: 'relative',
    // 页级卡面 16px 大圆角（surfaceSpec.ts 单一事实源），满幅卡与图版卡同档
    borderRadius: SURFACE_RADIUS_PAGE_CARD,
    overflow: 'hidden',
    // 原生 button 自带 user agent 字色/居中/表单字体，全部收编到主题
    color: tokens.colorNeutralForegroundOnBrand,
    textAlign: 'left',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    cursor: 'pointer',
  },
  // hover 底色微变的薄纱叠层：满幅铺卡 + 自身 :hover（选型见文件头），
  // 纯装饰不承载文字（无对比度约束）。DOM 上置于内容之后——同为定位元素
  // 时后者绘制在上，指针落点（含文字区）恒命中薄纱，:hover 全卡稳定触发
  //（点击经冒泡仍进 button 的 onClick）
  sheen: {
    position: 'absolute',
    inset: '0px',
    zIndex: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    opacity: '0',
    '@media (prefers-reduced-motion: no-preference)': {
      transitionProperty: 'opacity',
      transitionDuration: `${EDITOR_FADE_MS}ms`,
    },
    ':hover': {
      opacity: '1',
    },
  },
  // 底部黑实底文字带（WORLD_BLEED_SCRIM_ALPHA 下限）：全部常显内容落此
  content: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    width: '100%',
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXL}`,
    backgroundColor: `rgba(0, 0, 0, ${WORLD_BLEED_SCRIM_ALPHA})`,
  },
  // 世界名大字主角：base500「详情头大标题」档（同 CharacterStageCard.name）
  name: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForegroundOnBrand,
    wordBreak: 'break-word',
  },
  // 配置元信息行：历法徽章 pill（形态照抄 WorldPlateCard.calendarBadge：
  // borderRadiusMedium + 1px 8px + nowrap）+ 更新日期；色档适配深底
  //（边框半透明白，文字 0.8 档）
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
    color: `rgba(255, 255, 255, ${WORLD_BLEED_META_TEXT_ALPHA})`,
    fontSize: tokens.fontSizeBase200,
  },
  calendarBadge: {
    border: '1px solid rgba(255, 255, 255, 0.4)',
    borderRadius: tokens.borderRadiusMedium,
    padding: '1px 8px',
    whiteSpace: 'nowrap',
  },
  // 世界观摘录（身份主角）：两行 clamp——多行截断只能走 -webkit-box 老盒模
  //（标准 line-clamp 尚未落地），griffel 直收 vendor 属性键（同
  // WorldPlateCard.excerpt）；空态占位同为 0.8 档（更低调档在最坏合成下
  // 不达标，见常量注释），不另设示弱色
  excerpt: {
    display: '-webkit-box',
    WebkitLineClamp: '2',
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    color: `rgba(255, 255, 255, ${WORLD_BLEED_META_TEXT_ALPHA})`,
    fontSize: tokens.fontSizeBase200,
  },

  // —— 入场动画（与图版卡同款；keyframes 在 app.css；reduced-motion 门控在
  //    @media 内）。揭示前占位：滚入视口前以透明等待；揭示后换动画类，
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

export interface WorldFullBleedCardProps {
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

export function WorldFullBleedCard({ world, index, revealDelay, register, onOpen }: WorldFullBleedCardProps) {
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
      aria-label={world.name}
      className={mergeClasses(
        styles.card,
        revealDelay === undefined ? styles.preReveal : styles.enterPop,
      )}
      style={{ ...enterStyle, backgroundImage: worldGradientOf(world.id) }}
      onClick={() => onOpen(world)}
    >
      <span className={styles.content}>
        <span className={styles.name}>{world.name}</span>
        <span className={styles.meta}>
          {/* null 历法 → 「默认数字历」；有历法无名 → 空串（同图版卡口径） */}
          <span className={styles.calendarBadge}>
            {world.calendar === null ? t('worlds.calendarNone') : world.calendar.name ?? ''}
          </span>
          <span aria-hidden>·</span>
          <span>{new Date(world.updatedAt).toLocaleDateString()}</span>
        </span>
        {/* 世界观摘录（身份主角）：空态占位是行动邀请（同图版卡拍板） */}
        {excerpt ? (
          <span className={styles.excerpt}>{excerpt}</span>
        ) : (
          <span className={styles.excerpt}>{t('worlds.worldbookEmpty')}</span>
        )}
      </span>
      {/* hover 薄纱：纯装饰（aria-hidden），满幅铺卡、置于内容之后以自身
          :hover 稳定提亮（层叠理由见样式注释） */}
      <span className={styles.sheen} aria-hidden />
    </button>
  );
}
