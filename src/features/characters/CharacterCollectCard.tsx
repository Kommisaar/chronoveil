/**
 * 角色页典藏卡（collect 档，第四对比档，2026-09-16）：亮色收藏卡形——
 * 主题面卡内嵌「留白图框 + 下方正文 + 元信息/主操作行」的分区结构，与
 * 全幅色面族（「整卡色面 + 底部黑带」的满幅形态）相对。设计来源：
 * 2026-09-16 用户供图（外部收藏卡设计）拍板，按其卡面语言落地：
 *
 * - 图框是卡内独立圆角面（四周留白呼吸感），内有头像/渐变色面 + 首字
 *   水印。曾按供图挂 ⋯ 导出菜单角标（参照角标收藏钮位），2026-09-16
 *   用户拍板「导出按钮放到删除旁边」随移编辑器动作行，角标菜单整体
 *   裁撤，图框回归纯展示面（scrim 实底与守卫锚随之消失）；
 * - 正文区直接落主题表面：名字/人设摘录用 Fluent 前景 token（fg1/fg2 ×
 *   中性面），对比度由主题对保证——明暗切换（既有 uiTheme 体系，
 *   AppProviders 消费）自动成立，**无需 scrim 实底与 contrastGuard 守卫
 *   数学**。这是与全幅族的本质差异：色面恒定的是图框（身份色），表面随
 *   主题。文案 span 不用 Text（Fluent Card 自带
 *   `.fui-Text { color: currentcolor }` 两类名后代规则，单类名的 Griffel
 *   color 压不过它，暗色下被掩盖、亮色下会变深底深字）；
 * - 称号轮换（2026-09-16 用户拍板「一次只显示一个，然后轮换」）：称号「」
 *   包裹内联名字后；多称号按 TITLES_ROTATE_MS 周期轮换单显，全部称号 grid
 *   同格堆叠常驻 DOM，激活项 opacity 1、其余 0；换题两段式「先完全淡出，
 *   再淡入」（同日拍板）——淡出态零延迟加速淡出，淡入态延迟一个段长后
 *   减速淡入（transition 参数取自目标态），单段 TITLES_CROSSFADE_MS。字色
 *   走主题前景 token fg2（2026-09-16 用户拍板「字体颜色改成正常颜色」，
 *   同日早先的渐变流动 + 暗色掺白实验随之整体裁撤：keyframes
 *   titles-gradient-cycle、mixTowardWhite、titlesGradientStops 均已移除）。
 *   reduced-motion 不轮换，整串并显静置（信息完整优先）。
 * - 底部行 = 元信息（色点 + 会话数）。曾按供图行位映射「编辑」主操作
 *   pill（价格 + 购买钮的形），2026-09-16 用户拍板移除——与整卡点击同义
 *   的显式动作位冗余，进编辑只走整卡点击 / Enter / Space；
 * - data-editor-trigger（FLIP 锚点）、preReveal/enterPop + register/
 *   revealDelay 接线（--enter-delay CSS 变量 + as CSSProperties）与
 *   角色卡入场动画同款（keyframes card-enter-pop 在 app.css）。
 */
import {
  Card,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CharacterSummary } from '../../api/types';
import {
  ACCELERATE_CURVE,
  DECELERATE_CURVE,
  POP_IN_MS,
  SPRING_CURVE,
  TITLES_CROSSFADE_MS,
  TITLES_ROTATE_MS,
} from '../../components/motion';
import { SURFACE_RADIUS_PAGE_CARD } from '../../components/surfaceSpec';
import { useCardLiftStyles } from '../../components/useCardLiftStyles';
import { excerptOf } from '../../lib/excerpt';
import { dotGradientOf, posterGradientOf } from './posterGradient';

/** prefers-reduced-motion 实时监听（称号轮换的 JS 侧降级开关：reduce 时
 * 不轮换、整串并显静置；CSS 侧动画由各 Griffel 类的 @media 门控）。 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

const useStyles = makeStyles({
  // 主题面卡：padding 自持（全幅族是 padding 0 + 色面满幅，本卡正文与
  // 图框之间要留白），16px 页级大圆角（surfaceSpec 单一事实源）与全幅族同档
  card: {
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    display: 'flex',
    flexDirection: 'column',
    borderRadius: SURFACE_RADIUS_PAGE_CARD,
    '--fui-Card--border-radius': SURFACE_RADIUS_PAGE_CARD,
    cursor: 'pointer',
  },

  // —— 留白图框：卡内独立圆角面（身份色面恒定，不随主题） ——
  frame: {
    position: 'relative',
    width: '100%',
    // 4:3 横档（供图比例）：比竖版海报矮，典藏档定位是「展示面」不是海报墙
    aspectRatio: '4 / 3',
    borderRadius: tokens.borderRadiusXLarge,
    overflow: 'hidden',
    // 头像未加载/为空时的身份色底：posterGradientOf 恒色（同人恒同色）
    backgroundColor: tokens.colorNeutralBackground2,
  },
  frameImg: {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    position: 'absolute',
    inset: '0px',
  },
  // 首字水印（无头像时）：白 24% 半透明浮于渐变色面上（88px 档装饰性
  // 水印，WCAG 1.4.3 豁免纯装饰文字；半透明填充不加 textShadow——模糊
  // 暗晕观感像污渍，2026-09-09 用户反馈实锤）
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
  // 名字 + 称号同行（2026-09-16 用户拍板，称号自独立行内联）：baseline
  // 对齐，名字不缩、称号占余宽截断（minWidth 0 是 flex 内 ellipsis 前提）
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
  // 称号容器：层叠轮换（2026-09-16「一次只显示一个，然后轮换」）——
  // 所有称号 grid 同格堆叠常驻 DOM，激活项 opacity 1、其余 0，换题两段式
  // 「先完全淡出，再淡入」（On/Off 类，见下）
  identity: {
    minWidth: 0,
    overflow: 'hidden',
    flexShrink: 1,
    display: 'grid',
    fontSize: tokens.fontSizeBase200,
  },
  identityItem: {
    gridRow: '1',
    gridColumn: '1',
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground2,
  },
  // 两段式换题的「淡入态」：transition 参数取自目标态——落上 On 类时先
  // 延迟一个段长（等旧题完全淡出），再减速淡入自己这段。
  identityItemOn: {
    transitionProperty: 'opacity',
    transitionDuration: `${TITLES_CROSSFADE_MS}ms`,
    transitionTimingFunction: DECELERATE_CURVE,
    transitionDelay: `${TITLES_CROSSFADE_MS}ms`,
  },
  // 「淡出态」：零延迟加速淡出（不写 transitionDelay，避开 0ms 动效字面量）。
  identityItemOff: {
    transitionProperty: 'opacity',
    transitionDuration: `${TITLES_CROSSFADE_MS}ms`,
    transitionTimingFunction: ACCELERATE_CURVE,
  },
  // 人设摘录：两行 clamp（-webkit-box 老盒模——标准 line-clamp 尚未落地，
  excerpt: {
    marginTop: '2px',
    display: '-webkit-box',
    WebkitLineClamp: '2',
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },

  // —— 底部行：元信息行（曾挂「编辑」主操作 pill，2026-09-16 用户拍板
  //    移除，进编辑只走整卡点击 / 键盘）；marginTop auto 把行钉在卡底
  //    （网格行拉伸到最高卡时其余卡正文不留悬空） ——
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
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: tokens.borderRadiusCircular,
    flexShrink: 0,
  },

  // —— 入场动画（keyframes 在 app.css，reduced-motion 门控在 @media 内；
  //    Griffel 不透出 keyframes， Griffel 类挂动画的既有全仓口径） ——
  preReveal: {
    opacity: 0,
  },
  enterPop: {
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'card-enter-pop',
      animationDuration: `${POP_IN_MS}ms`,
      animationTimingFunction: SPRING_CURVE,
      animationFillMode: 'backwards',
      animationDelay: 'var(--enter-delay, 0ms)',
    },
  },
});

export interface CharacterCollectCardProps {
  character: CharacterSummary;
  /** 卡片在网格中的序号：进 useRevealOnScroll 的 ref 登记与错峰取值。 */
  index: number;
  /** 揭示动画批内错峰延迟（ms）；undefined = 尚未滚入视口，透明占位。 */
  revealDelay: number | undefined;
  /** callback ref 工厂（useRevealOnScroll）：登记元素供 IntersectionObserver 观察。 */
  register: (index: number) => (el: Element | null) => void;
  /** 点击 / Enter / 空格进编辑（整卡即唯一动作位；导出走编辑器动作行）。 */
  onOpen: (character: CharacterSummary) => void;
}

export function CharacterCollectCard({
  character,
  index,
  revealDelay,
  register,
  onOpen,
}: CharacterCollectCardProps) {
  const styles = useStyles();
  const lift = useCardLiftStyles();
  const { t } = useTranslation();
  const prefersReducedMotion = usePrefersReducedMotion();
  // 称号轮换（2026-09-16 用户拍板「一次只显示一个，然后轮换」）：多称号按
  // TITLES_ROTATE_MS 周期轮转单显；reduced-motion 不轮换（整串并显静置，
  // 信息完整优先）；单称号无可轮换
  const rotateTitles = character.titles.length > 1 && !prefersReducedMotion;
  const [titleIndex, setTitleIndex] = useState(0);
  useEffect(() => {
    if (!rotateTitles) return;
    const timer = window.setInterval(
      () => setTitleIndex((i) => (i + 1) % character.titles.length),
      TITLES_ROTATE_MS,
    );
    return () => window.clearInterval(timer);
  }, [rotateTitles, character.titles.length]);
  const enterStyle =
    revealDelay === undefined
      ? undefined
      : ({ '--enter-delay': `${revealDelay}ms` } as CSSProperties);
  // 身份两行（空则整行不渲染——留白比占位干净）：轮换中单显一个称号
  //（其余层叠待显），否则（单称号 / reduced-motion）整串「」包裹；人设
  // 摘录 excerptOf 48 字档。悬停 title 恒显完整称号串
  const titlesJoined =
    character.titles.length > 0 ? `「${character.titles.join(' · ')}」` : '';
  const titlesText = rotateTitles
    ? `「${character.titles[titleIndex % character.titles.length] ?? ''}」`
    : titlesJoined;
  const personaExcerpt = excerptOf(character.persona, 48);

  return (
    <Card
      size="small"
      tabIndex={0}
      ref={register(index)}
      data-editor-trigger={character.id}
      className={mergeClasses(
        styles.card,
        lift.root,
        revealDelay === undefined ? styles.preReveal : styles.enterPop,
      )}
      style={enterStyle}
      onClick={() => onOpen(character)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(character);
        }
      }}
    >
      {/* 留白图框：身份色面/头像（纯展示面——角标导出菜单已于 2026-09-16
          随「导出移至编辑器动作行」裁撤）；图框渐变恒定不随主题（身份色），
          正文区才落主题表面（文件头「本质差异」） */}
      <div
        className={styles.frame}
        style={{ backgroundImage: posterGradientOf(character) }}
      >
        {character.avatar ? (
          <img className={styles.frameImg} src={character.avatar} alt={character.name} />
        ) : (
          <span className={styles.letter}>{character.name.slice(0, 1)}</span>
        )}
      </div>

      {/* 正文区：主题前景 token（span 非 Text，见文件头）；称号轮换见
          文件头「称号轮换」 */}
      <div className={styles.nameRow}>
        <span className={styles.name}>{character.name}</span>
        {titlesText ? (
          <span className={styles.identity} title={titlesJoined}>
            {rotateTitles ? (
              character.titles.map((title, i) => (
                <span
                  key={`${title}-${i}`}
                  className={mergeClasses(
                    styles.identityItem,
                    i === titleIndex % character.titles.length
                      ? styles.identityItemOn
                      : styles.identityItemOff,
                  )}
                  style={{ opacity: i === titleIndex % character.titles.length ? 1 : 0 }}
                >
                  {`「${title}」`}
                </span>
              ))
            ) : (
              <span className={styles.identityItem}>{titlesText}</span>
            )}
          </span>
        ) : null}
      </div>
      {personaExcerpt ? (
        <span className={styles.excerpt}>{personaExcerpt}</span>
      ) : null}

      {/* 底部行：元信息（进编辑只走整卡点击 / 键盘——「编辑」pill 已于
          2026-09-16 用户拍板移除） */}
      <div className={styles.footer}>
        <div className={styles.meta}>
          <span className={styles.dot} style={{ backgroundImage: dotGradientOf(character) }} />
          <span className={styles.metaText}>
            {t('characters.sessionCount', { count: character.sessionCount })}
          </span>
        </div>
      </div>
    </Card>
  );
}
