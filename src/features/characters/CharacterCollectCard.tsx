/**
 * 角色页典藏卡（collect 档，第四对比档，2026-09-16）：亮色收藏卡形——
 * 主题面卡内嵌「留白图框 + 下方正文 + 元信息/主操作行」的分区结构，与
 * 全幅色面族（「整卡色面 + 底部黑带」的满幅形态）相对。设计来源：
 * 2026-09-16 用户供图（外部收藏卡设计）拍板，按其卡面语言落地：
 *
 * - 图框是卡内独立圆角面（四周留白呼吸感），内有头像/渐变色面 + 首字
 *   水印；⋯ 导出菜单触发器坐图框右上角（参照供图的角标收藏钮位）；
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
 * - 底部行 = 元信息（色点 + 会话数）在左、「编辑」主操作 pill 在右（供图
 *   的「价格 + 购买钮」行位映射；无价格语义，元信息补位；动画样式文本
 *   2026-09-16 用户拍板移除）。
 *   pill 与整卡点击同义（点击进编辑契约），是显式动作位不是新功能；
 * - 嵌套交互三处（⋯ 触发器 / 菜单项 / 编辑 pill）全部 stopPropagation
 *   ——门户 click 沿 React 树冒泡，不截会「导出/编辑」与整卡 onClick
 *   双触发；pill 的 keydown 也要截：Enter/Space 在 pill 上原生 click 与
 *   冒泡到卡的键盘路径会双触发；
 * - data-editor-trigger（FLIP 锚点）、preReveal/enterPop + register/
 *   revealDelay 接线（--enter-delay CSS 变量 + as CSSProperties）与
 *   角色卡入场动画同款（keyframes card-enter-pop 在 app.css）。
 */
import {
  Button,
  Card,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { ArrowDownloadRegular, MoreHorizontalRegular } from '@fluentui/react-icons';
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

/**
 * 图框 ⋯ 触发器实底芯压暗下限（本文件单一事实源；守卫配对依据 =
 * src/components/contrastGuard.test.ts 的收藏卡触发器断言组）：⋯ 触发器图标
 * 恒白 #ffffff（非文字图形，按 WCAG 1.4.11 非文字线 3:1 计），直落头像/
 * 渐变色面无下界（用户强调色原色直出可为纯白）。触发器挂 rgba(0,0,0,本档)
 * 28px 圆形实底芯后，最坏合成 = 纯白 accent × (1 − 0.62) → 灰
 * ceil(255×0.38)=97 → 白图标对比 ≈6.19:1 ≥ 3:1，余量充足。同值 0.62 家族
 * 互指：CharacterPickGrid 的 PICK_SCRIM_ALPHA（选人卡文字/角标实底）、
 * WorldFullBleedCard 的 WORLD_BLEED_SCRIM_ALPHA（世界满幅卡文字实底），
 * 守卫断言组分别数值锚定；改值须同步（含守卫）。
 *
 * 交互态同值覆写（2026-09-14 reviewer 实锤于同构先例）：Fluent transparent
 * 外观在 ':hover' 与 ':hover:active,:active:focus-visible' 上各有底色规则
 * （本装版本 alias 实证值为全透明），按选择器键与静息声明并存——hover/按下
 * 时组件规则胜出，把实底芯整体替换回透明，恒白图标在纯白 accent 上重新无
 * 下界。故 frameMenuTrigger 以逐字相同的选择器串同值覆写（键一致
 * mergeClasses 才按同键冲突让本类胜出）；覆写串由守卫 it 文本锚定防回归。
 */
const COLLECT_ICON_SCRIM_ALPHA = 0.62;

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

  // 图框角标（⋯ 导出菜单）：28px 圆形实底芯 + 交互态同值覆写（机制与
  // 守卫锚定见 COLLECT_ICON_SCRIM_ALPHA 常量注释）
  frameMenuTrigger: {
    position: 'absolute',
    top: '8px',
    right: '8px',
    zIndex: 1,
    width: '28px',
    minWidth: '28px',
    maxWidth: '28px',
    height: '28px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: `rgba(0, 0, 0, ${COLLECT_ICON_SCRIM_ALPHA})`,
    ':hover': {
      backgroundColor: `rgba(0, 0, 0, ${COLLECT_ICON_SCRIM_ALPHA})`,
    },
    ':hover:active,:active:focus-visible': {
      backgroundColor: `rgba(0, 0, 0, ${COLLECT_ICON_SCRIM_ALPHA})`,
    },
  },
  frameMenuIcon: {
    color: '#ffffff',
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

  // —— 底部行：元信息在左、主操作 pill 在右；marginTop auto 把行钉在
  //    卡底（网格行拉伸到最高卡时其余卡正文不留悬空） ——
  footer: {
    marginTop: 'auto',
    paddingTop: tokens.spacingVerticalM,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
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
  // 主操作 pill：全圆角（供图黑 pill 的形；色走 brand 交互语义）
  pill: {
    borderRadius: tokens.borderRadiusCircular,
    minWidth: '64px',
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
  /** 点击 / Enter / 空格进编辑（整卡与底部 pill 同义，脏守卫在父级）。 */
  onOpen: (character: CharacterSummary) => void;
  /** 图框角标菜单「导出角色卡」：成功/取消静默，真错误由父级就地红字。 */
  onExport: (id: number) => void;
}

export function CharacterCollectCard({
  character,
  index,
  revealDelay,
  register,
  onOpen,
  onExport,
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
      {/* 留白图框：身份色面/头像 + 角标菜单；图框渐变恒定不随主题（身份色），
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
        {/* 角标菜单：触发器与菜单项都要 stopPropagation——门户 click 沿
            React 树冒泡，不截会导出同时进编辑（见文件头嵌套交互契约） */}
        <Menu>
          <MenuTrigger>
            <MenuButton
              aria-label={t('characters.cardMenu')}
              appearance="transparent"
              size="small"
              className={styles.frameMenuTrigger}
              icon={<MoreHorizontalRegular className={styles.frameMenuIcon} />}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem
                icon={<ArrowDownloadRegular />}
                onClick={(e) => {
                  e.stopPropagation();
                  onExport(character.id);
                }}
              >
                {t('characters.export')}
              </MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
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

      {/* 底部行：元信息 + 主操作 pill。pill 的 click 与 keydown 都截断冒泡
          ——否则整卡 onClick / 卡键盘路径叠加原生 click 双触发进编辑 */}
      <div className={styles.footer}>
        <div className={styles.meta}>
          <span className={styles.dot} style={{ backgroundImage: dotGradientOf(character) }} />
          <span className={styles.metaText}>
            {t('characters.sessionCount', { count: character.sessionCount })}
          </span>
        </div>
        <Button
          appearance="primary"
          size="small"
          className={styles.pill}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(character);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {t('characters.editCard')}
        </Button>
      </div>
    </Card>
  );
}
