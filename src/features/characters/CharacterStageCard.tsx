/**
 * 角色页舞台卡（stage 档，三方向对比期第三档，2026-09-15）：全幅色面舞台——
 * 整卡即 posterGradientOf 全幅渐变色面，无中性正文区（gallery 海报卡是
 * 「渐变 + 底部文字带」的分区式，舞台卡是整块色面），文字全部落在底部黑
 * 实底带上。设计主张同两档：卡面承载身份，且比 gallery「配置退居次位」
 * 更进一步——静息态整卡只有名字 + 会话数，大字名字为主角。
 *
 * - 原生 button（非 Fluent Card，选型说明）：舞台卡不携带导出菜单（设计
 *   拍板：舞台档追求纯净展示面；导出经 gallery/ledger 档可达，切换器常驻
 *   工具栏）——没有 Card interactive 语义栈的消费点，裸 button + Griffel 类
 *   即测试契约「点击进编辑」，Enter/Space 原生自带（同 WorldPlateCard /
 *   CharacterLedgerRow 先例）；
 * - hover / focus 揭示层：浮出称号行（空称号不渲染）+ 人设摘录（excerptOf
 *   64 字档两行 clamp，空人设不渲染）。内容**常驻 DOM**（opacity/transform
 *   过渡切换而非条件挂载，读屏与 jsdom 直接可达——不设 aria-hidden 是本
 *   设计点）；键盘路径与 hover 等价。揭示切换用 React 状态（onMouseEnter/
 *   Leave + onFocus/Blur）而非 CSS 父选择器——Griffel 无「卡 hover → 子
 *   元素变化」的选择器保障（:has 不在 Griffel 伪类清单内）；onFocus 是
 *   focus-visible 的超集，点按获得的焦点也会揭示，但点按本就进编辑器，
 *   超集无可见副作用。动效铁律：只动 transform/opacity（translateY(4px→0)
 *   + opacity 的克制动效，卡片本体无位移），时长/曲线用 motion.ts 既有
 *   token（EDITOR_FADE_MS 纯淡化档 + DECELERATE_CURVE），prefers-reduced-
 *   motion 降级（位移与过渡整体收进 no-preference 门控，降级后 opacity
 *   瞬切、无位移）；
 * - 文字对比度（沿用海报卡常量档）：STAGE_SCRIM_ALPHA=0.62 黑实底 +
 *   STAGE_META_TEXT_ALPHA=0.8 次级白，最坏合成数学与 CharacterPosterCard
 *   的 POSTER_SCRIM_ALPHA / POSTER_META_TEXT_ALPHA 相同（posterGradientOf
 *   accent 原色直出可为纯白，实底给数学下限），跨文件同约束互指见常量注释；
 * - data-editor-trigger={id}（FLIP 锚点）、preReveal/enterPop + register/
 *   revealDelay 接线照抄 CharacterPosterCard（--enter-delay CSS 变量 +
 *   as CSSProperties）；名字为独立文本节点。
 */
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { CharacterSummary } from '../../api/types';
import { DECELERATE_CURVE, EDITOR_FADE_MS, POP_IN_MS, SPRING_CURVE } from '../../components/motion';
import { SURFACE_RADIUS_PAGE_CARD } from '../../components/surfaceSpec';
import { excerptOf } from '../../lib/excerpt';
import { posterGradientOf } from './posterGradient';

/**
 * 舞台卡文字区压暗下限（本文件单一事实源）：与 CharacterPosterCard 的
 * POSTER_SCRIM_ALPHA（0.62）同值同语义互指——同为「OnBrand 白字 × 任意
 * accent 渐变」的实底下限，最坏合成数学相同：accent 原色直出可为纯白，
 * 纯白 × (1 − 0.62) 黑实底 → 灰 ceil(255×0.38)=97 → 白字对比 ≈6.19:1 ≥
 * AA 4.5:1。同约束还存在于 WorldFullBleedCard 的 WORLD_BLEED_SCRIM_ALPHA
 * （守卫断言组见 src/components/contrastGuard.test.ts，含本常量的 stage 侧
 * 数值锚）；改值须四处同步（含守卫）。
 */
const STAGE_SCRIM_ALPHA = 0.62;

/**
 * 舞台卡次级文字（会话数/称号/摘录）不透明度（本文件单一事实源）：与
 * CharacterPosterCard 的 POSTER_META_TEXT_ALPHA（0.8）同值同语义互指——
 * 半透明白按「合成像素 × 背景」计对比：0.8 合成 = 223 → ≈4.65:1 ≥ 4.5
 * （0.66 档 ≈3.74:1 不达标）。同约束同见于 WorldFullBleedCard 的
 * WORLD_BLEED_META_TEXT_ALPHA（守卫含本常量的 stage 侧数值锚）；改值须
 * 四处同步（含守卫）。
 */
const STAGE_META_TEXT_ALPHA = 0.8;

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end',
    minHeight: '340px',
    padding: '0px',
    border: '0px',
    // 页级卡面 16px 大圆角（surfaceSpec.ts 单一事实源），舞台大卡与海报卡同档
    borderRadius: SURFACE_RADIUS_PAGE_CARD,
    overflow: 'hidden',
    // 原生 button 自带 user agent 字色/居中/表单字体，全部收编到主题
    color: tokens.colorNeutralForegroundOnBrand,
    textAlign: 'left',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    cursor: 'pointer',
  },
  // 底部黑实底文字带（STAGE_SCRIM_ALPHA 下限）：静息态承载名字 + 会话数，
  // 揭示层（称号/摘录）也常驻其中——揭示是同一实底区内的浮现，不另起浮层
  content: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    width: '100%',
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXL}`,
    backgroundColor: `rgba(0, 0, 0, ${STAGE_SCRIM_ALPHA})`,
  },
  // 大字名字为主角：base500 是仓库「详情头大标题」档（ProviderCard.title 先例）
  name: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForegroundOnBrand,
    wordBreak: 'break-word',
  },
  // 会话数（静息态唯一元信息）：次级白 0.8 档
  count: {
    color: `rgba(255, 255, 255, ${STAGE_META_TEXT_ALPHA})`,
    fontSize: tokens.fontSizeBase200,
  },

  // —— hover/focus 揭示层：内容常驻 DOM，opacity/transform 过渡切换 ——
  reveal: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    opacity: '0',
    // 动效整体收进 no-preference 门控：位移与过渡只在允许动效时存在，
    // reduced-motion 下降级为 opacity 瞬切、无位移（常驻可达性不受影响）。
    // transform 两态必须同桶（本 slot 与 revealOpen 的 transform 同收进同一
    // @media 块）：Griffel 按 at-rules 分桶插 <style>——media 内规则归 'm' 桶、
    // media 外归 'd' 桶，styleBucketOrdering 使 m 桶文档序恒在后；两态
    // transform 分属两桶时同为单类选择器（特异性相等）按文档序取后者，
    // m 桶的闭态 4px 恒胜、开态永不归位（2026-09-15 reviewer 以锁定版
    // griffel 实锤）。同桶时两规则同 selector + 同 at-rules + 同 property →
    // 同键，mergeClasses 按后位胜出去重，revealOpen 的 0px 才压得过 4px
    //（opacity 无此坑：两态都声明在 media 外同桶，天然受去重保护）
    '@media (prefers-reduced-motion: no-preference)': {
      transform: 'translateY(4px)',
      transitionProperty: 'opacity, transform',
      transitionDuration: `${EDITOR_FADE_MS}ms`,
      transitionTimingFunction: DECELERATE_CURVE,
    },
  },
  revealOpen: {
    opacity: '1',
    // transform 必须与 reveal 的 transform 同桶（同收进同形 @media 块，机制
    // 与失效形态见 reveal 槽注释）：搬出 media 块会被 m/d 桶文档序压制，
    // 开态 0px 不生效——揭示块常驻低于设计位 4px；reduced-motion 下两态均
    // 无 transform，与文件头「降级后无位移」一致
    '@media (prefers-reduced-motion: no-preference)': {
      transform: 'translateY(0px)',
    },
  },
  // 称号行：整串「」包裹、「·」连接（同海报卡/名册行拍板）；被截断的称号
  // 全文经 title 悬停可读
  revealLine: {
    color: `rgba(255, 255, 255, ${STAGE_META_TEXT_ALPHA})`,
    fontSize: tokens.fontSizeBase200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // 人设摘录：两行 clamp——多行截断只能走 -webkit-box 老盒模（标准
  // line-clamp 尚未落地），griffel 直收 vendor 属性键（同 WorldPlateCard.excerpt）
  excerpt: {
    display: '-webkit-box',
    WebkitLineClamp: '2',
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    color: `rgba(255, 255, 255, ${STAGE_META_TEXT_ALPHA})`,
    fontSize: tokens.fontSizeBase200,
  },

  // —— 入场动画（与海报卡同款；keyframes 在 app.css；reduced-motion 门控在
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

export interface CharacterStageCardProps {
  character: CharacterSummary;
  /** 卡片在网格中的序号：进 useRevealOnScroll 的 ref 登记与错峰取值。 */
  index: number;
  /** 揭示动画批内错峰延迟（ms）；undefined = 尚未滚入视口，透明占位。 */
  revealDelay: number | undefined;
  /** callback ref 工厂（useRevealOnScroll）：登记元素供 IntersectionObserver 观察。 */
  register: (index: number) => (el: Element | null) => void;
  /** 点击 / Enter / 空格进编辑（原生 button 自带键盘激活）。 */
  onOpen: (character: CharacterSummary) => void;
}

export function CharacterStageCard({
  character,
  index,
  revealDelay,
  register,
  onOpen,
}: CharacterStageCardProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  // hover / focus 揭示态（选型与降级理由见文件头）
  const [revealed, setRevealed] = useState(false);
  const enterStyle =
    revealDelay === undefined
      ? undefined
      : ({ '--enter-delay': `${revealDelay}ms` } as CSSProperties);
  // 称号整串「」包裹、「·」连接（同海报卡/名册行拍板）；摘录走 excerptOf
  //（64 字档，与名册行同宽档——舞台卡揭示层比海报卡 48 字档宽一档）
  const titlesText = character.titles.length > 0 ? `「${character.titles.join(' · ')}」` : '';
  const personaExcerpt = excerptOf(character.persona, 64);

  return (
    <button
      type="button"
      ref={register(index)}
      // FLIP 共享元素过渡锚点：编辑器 getTriggerRect 按角色 id 现测本卡矩形
      data-editor-trigger={character.id}
      aria-label={character.name}
      className={mergeClasses(
        styles.card,
        revealDelay === undefined ? styles.preReveal : styles.enterPop,
      )}
      style={{ ...enterStyle, backgroundImage: posterGradientOf(character) }}
      onClick={() => onOpen(character)}
      // Enter/Space 显式收口（照抄 CharacterPosterCard 接法）：preventDefault
      // 压掉 UA 默认的 click 合成，避免真实浏览器里双触发；jsdom 不做按键
      // →click 合成，键盘用例直接打在这里
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(character);
        }
      }}
      onMouseEnter={() => setRevealed(true)}
      onMouseLeave={() => setRevealed(false)}
      onFocus={() => setRevealed(true)}
      onBlur={() => setRevealed(false)}
    >
      <span className={styles.content}>
        {/* 揭示层：称号 + 人设摘录常驻 DOM（空内容则整层不渲染——无内容可
            揭示），不设 aria-hidden，opacity/transform 过渡切换 */}
        {titlesText || personaExcerpt ? (
          <span className={mergeClasses(styles.reveal, revealed && styles.revealOpen)}>
            {titlesText ? (
              <span className={styles.revealLine} title={titlesText}>
                {titlesText}
              </span>
            ) : null}
            {personaExcerpt ? <span className={styles.excerpt}>{personaExcerpt}</span> : null}
          </span>
        ) : null}
        <span className={styles.name}>{character.name}</span>
        <span className={styles.count}>
          {t('characters.sessionCount', { count: character.sessionCount })}
        </span>
      </span>
    </button>
  );
}
