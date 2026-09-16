/**
 * 世界页 gallery 档卡片（2026-09-16 用户拍板按角色页典藏卡形制改造，同日
 * 原「上图下文」宽扁图版卡 WorldPlateCard 随之退役并更名归档）：主题面卡
 * 内嵌「留白图框 + 下方正文 + 底部元信息行」的分区结构，与
 * CharacterCollectCard 同形（跨 feature 禁互引，卡面语言在本文件按世界域
 * 重述）：
 *
 * - 图框是卡内独立圆角面（四周留白呼吸感）。世界无头像，恒为世界色渐变
 *   （worldGradientOf 按 id 恒定，地志调色板与角色靛紫系拉开域别）+ 首字
 *   水印；整框 aria-hidden（渐变与水印皆纯装饰，卡的可及名由正文区世界名
 *   承担）。曾按宽扁横版做 96px 通栏色画布，随形制改造退役；
 * - 正文区直接落主题表面：世界名 fg1、世界观摘录 fg2（Fluent 前景 token ×
 *   中性面，对比度由主题对保证，明暗切换自动成立，无需 scrim 实底与
 *   contrastGuard 守卫数学——同角色典藏卡口径）。摘录 64 字档两行 clamp，
 *   仍是世界域身份主角；空态渲染「还没有世界观」占位（世界域拍板：占位是
 *   「去写下世界观」的行动邀请而非噪声，与角色卡「空则不渲染」是有意
 *   差异，ledger/stage 档同此拍板）；
 * - 底部行 = 元信息（历法徽章 pill + 更新日期），marginTop auto 把行钉在
 *   卡底（网格行拉伸到最高卡时其余卡正文不留悬空）；
 * - 悬停 lift（useCardLiftStyles 弹簧上浮 + 阴影，与角色典藏卡同款）：原
 *   「悬停无位移」拍板针对宽扁横版卡的浮动观感，形制改造后随典藏形制
 *   回归弹性语言；
 * - Fluent Card + tabIndex 0 + Enter/Space 激活（同角色典藏卡交互契约；
 *   原「宽扁信息卡不需要 Card 的 interactive 语义栈」裸 button 选型随
 *   形制失效）；
 * - preReveal/enterPop + register/revealDelay 接线
 *   （--enter-delay CSS 变量 + as CSSProperties）与角色卡入场动画同款
 *   （keyframes card-enter-pop 在 app.css，reduced-motion 门控在 @media 内）。
 */
import {
  Card,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorldSummary } from '../../api/types';
import { POP_IN_MS, SPRING_CURVE } from '../../components/motion';
import { SURFACE_RADIUS_PAGE_CARD } from '../../components/surfaceSpec';
import { useCardLiftStyles } from '../../components/useCardLiftStyles';
import { excerptOf } from '../../lib/excerpt';
import { worldGradientOf } from './worldGradient';

const useStyles = makeStyles({
  // 主题面卡：padding 自持（正文与图框之间留白），16px 页级大圆角
  //（surfaceSpec 单一事实源；--fui-Card--border-radius 压掉 Card 默认圆角）
  card: {
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    display: 'flex',
    flexDirection: 'column',
    borderRadius: SURFACE_RADIUS_PAGE_CARD,
    '--fui-Card--border-radius': SURFACE_RADIUS_PAGE_CARD,
    cursor: 'pointer',
  },

  // —— 留白图框：卡内独立圆角面（世界色恒定，不随主题） ——
  frame: {
    position: 'relative',
    width: '100%',
    // 定高 126px（2026-09-16 用户拍板「高度相对于角色卡不变，仅宽度变宽」）：
    // 与角色典藏卡标称列宽下 4:3 图框等高——(200px 网格列宽 − 2×16px 卡内
    // 边距) × 3/4 = 126px（角色侧参数见 CharacterCollectCard.frame 的 4:3 与
    // CharactersView.grid 的 minmax(200px)；CSS 值无法编译期互引，注释互指）。
    // 世界卡列宽 280px 起步更宽，图框恒为定高横幅档——4:3 等比会把加宽变
    // 成加高，与本拍板相悖
    height: '126px',
    borderRadius: tokens.borderRadiusXLarge,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  // 首字水印：白 24% 色档与 userSelect none（全仓水印通用档），浮于世界色
  // 渐变上（纯装饰文字 WCAG 1.4.3 豁免；不加 textShadow——模糊暗晕观感像
  // 污渍，2026-09-09 用户反馈实锤）
  letter: {
    position: 'absolute',
    inset: '0px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '72px',
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: 1,
    color: 'rgba(255, 255, 255, 0.24)',
    userSelect: 'none',
  },

  // —— 正文区：直接落主题表面，前景 token 对（无 scrim） ——
  nameRow: {
    marginTop: tokens.spacingVerticalM,
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  name: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    wordBreak: 'break-word',
    flexShrink: 0,
  },
  // 世界观摘录（身份主角）：两行 clamp——多行截断只能走 -webkit-box 老盒模
  // （标准 line-clamp 尚未落地），griffel 直收 vendor 属性键
  excerpt: {
    marginTop: '2px',
    display: '-webkit-box',
    WebkitLineClamp: '2',
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  // 空态占位（worldbookEmpty）：同款两行 clamp，色档降一档示弱（世界域
  // 拍板，见文件头）
  excerptEmpty: {
    color: tokens.colorNeutralForeground3,
  },

  // —— 底部行：元信息（历法徽章 + 更新日期），marginTop auto 钉卡底 ——
  footer: {
    marginTop: 'auto',
    paddingTop: tokens.spacingVerticalM,
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    rowGap: '2px',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
  },
  metaText: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  // 历法徽章（小 pill）：历法名出自预设五选（有界长度），nowrap 防止 pill
  // 内断行变形
  calendarBadge: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '1px 8px',
    whiteSpace: 'nowrap',
  },

  // —— 入场动画（与角色典藏卡同款；keyframes 在 app.css；reduced-motion
  //    门控在 @media 内）。揭示前占位：滚入视口前以透明等待；揭示后换动画
  //    类，backwards fill 在批内延迟期接手维持 from 态，动画止于自然态。 ——
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

export interface WorldGalleryCardProps {
  world: WorldSummary;
  /** 卡片在网格中的序号：进 useRevealOnScroll 的 ref 登记与错峰取值。 */
  index: number;
  /** 揭示动画批内错峰延迟（ms）；undefined = 尚未滚入视口，透明占位。 */
  revealDelay: number | undefined;
  /** callback ref 工厂（useRevealOnScroll）：登记元素供 IntersectionObserver 观察。 */
  register: (index: number) => (el: Element | null) => void;
  /** 点击 / Enter / 空格进编辑（整卡即唯一动作位）。 */
  onOpen: (world: WorldSummary) => void;
}

export function WorldGalleryCard({ world, index, revealDelay, register, onOpen }: WorldGalleryCardProps) {
  const styles = useStyles();
  const lift = useCardLiftStyles();
  const { t } = useTranslation();
  const enterStyle =
    revealDelay === undefined
      ? undefined
      : ({ '--enter-delay': `${revealDelay}ms` } as CSSProperties);
  const excerpt = excerptOf(world.worldbook, 64);

  return (
    <Card
      size="small"
      tabIndex={0}
      ref={register(index)}
      className={mergeClasses(
        styles.card,
        lift.root,
        revealDelay === undefined ? styles.preReveal : styles.enterPop,
      )}
      style={enterStyle}
      onClick={() => onOpen(world)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(world);
        }
      }}
    >
      {/* 留白图框：世界色渐变 + 首字水印（世界无头像，恒字面）。渐变恒定
          不随主题（身份色），正文区才落主题表面（文件头「本质差异」） */}
      <div className={styles.frame} style={{ backgroundImage: worldGradientOf(world.id) }} aria-hidden>
        <span className={styles.letter}>{world.name.slice(0, 1)}</span>
      </div>

      {/* 正文区：主题前景 token（span 非 Text——Fluent Card 自带
          .fui-Text { color: currentcolor } 两类名后代规则，单类名的 Griffel
          color 压不过它，同角色典藏卡口径） */}
      <div className={styles.nameRow}>
        <span className={styles.name}>{world.name}</span>
      </div>
      {/* 世界观摘录（身份主角）：空态占位是行动邀请（世界域拍板，见文件头） */}
      {excerpt ? (
        <span className={styles.excerpt}>{excerpt}</span>
      ) : (
        <span className={mergeClasses(styles.excerpt, styles.excerptEmpty)}>
          {t('worlds.worldbookEmpty')}
        </span>
      )}

      {/* 底部行：元信息（历法徽章 + 更新日期） */}
      <div className={styles.footer}>
        <div className={styles.meta}>
          {/* 历法徽章：null 历法 → 「默认数字历」；有历法无名 → 空串（防御
              性兜底，现网历法必有名——四预设 + 会话快照，开放空名历法时需
              复访改为不渲染徽章） */}
          <span className={styles.calendarBadge}>
            {world.calendar === null ? t('worlds.calendarNone') : world.calendar.name ?? ''}
          </span>
          <span className={styles.metaText} aria-hidden>·</span>
          <span className={styles.metaText}>{new Date(world.updatedAt).toLocaleDateString()}</span>
        </div>
      </div>
    </Card>
  );
}
