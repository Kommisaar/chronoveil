/**
 * 角色管理竖版电影海报卡（2026-09-09 用户定稿，单一形态）：
 * 全幅渐变 + 底部压暗白字。
 *
 * - 每角色渐变按 id 取模 6 组深色低饱和调色板（posterGradientOf），同人恒同色；
 * - 入场动画定稿弹性（card-enter-pop）：揭示延迟由父级的 useRevealOnScroll
 *   按视口序号下发（首屏立即成批、折叠线以下滚入才播，批内按 motion.ts
 *   的清单浮现统一档错峰）；
 *   必须走 Griffel 类 + mergeClasses：Fluent Card 内部对 className 再过一次
 *   Griffel 合并，字符串拼接的全局类会被静默丢弃（repo 规约）；
 * - 卡菜单（Task-04）：海报右上角 ⋯ 触发器出「导出角色卡」；点击/键盘事件
 *   不冒泡到卡片（否则会同时打开编辑器）；触发器挂 28px 圆形实底芯保证恒白
 *   图标的非文字对比度下限（2026-09-14，POSTER_ICON_SCRIM_ALPHA，含 hover/
 *   按下交互态同值覆写，机制见常量注释）；
 * - 交互与测试契约不变：卡片是 .fui-Card、名字独立文本节点、点击进编辑；
 * - 海报文字（首字母水印/名字/问候/元信息）一律用普通 span 而非 Text：
 *   Fluent Card 自带 `.fui-Card哈希 .fui-Text { color: currentcolor }`
 *   两类名后代规则（useCardStyles.styles.raw.js），单类名的 Griffel color
 *   压不过它——暗色下继承值恰为白色被掩盖，亮色下会变成深底深字；
 * - 文字区对比度下限（2026-09-13，与选人卡 CharacterPickGrid 同病同修）：
 *   accent 原色直出可为纯白，白字直落渐变最坏无下界——contentB 挂
 *   POSTER_SCRIM_ALPHA 黑实底给出数学下限（推导见常量注释与
 *   contrastGuard.test.ts 海报文字断言组）；scrimB 只剩视觉过渡职能
 *   （与选人卡 scrim/名字条的分工同构）。
 */
import {
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
import { useTranslation } from 'react-i18next';
import type { CharacterSummary } from '../../api/types';
import { POP_IN_MS, SPRING_CURVE } from '../../components/motion';
import { SURFACE_RADIUS_PAGE_CARD } from '../../components/surfaceSpec';
import { useCardLiftStyles } from '../../components/useCardLiftStyles';
import { dotGradientOf, posterGradientOf } from './posterGradient';

/**
 * 海报文字区压暗下限（对比度守卫配对依据，与 src/app/layout/CharacterPickGrid.tsx
 * 的 PICK_SCRIM_ALPHA 及 src/components/contrastGuard.test.ts 的
 * POSTER_TEXT_SCRIM_FLOOR 互指）：同为「OnBrand 文字压暗下限」语义，值同为
 * 0.62——最坏合成数学相同：accent 原色直出（posterGradientOf 不压暗）可为纯白，
 * 纯白 accent × (1 − 0.62) 黑实底 → 灰 255×0.38=96.9 → 取整 97（向上保守）→
 * 相对亮度 ≈0.1195 → 白字对比 ≈6.19:1 ≥ AA 4.5:1。选 0.62 而非恰过线的
 * 0.55（≈4.76:1）留余量，与选人卡同档。语境差异（故不共享常量，各自文件内
 * 单一事实源 + 守卫文本锚定）：选人卡是迷你卡上逐元素实底（名字条/首字徽标/
 * 角标），本卡是底部文字区 contentB 整块实底，且实底之下另有 scrimB 渐变负责
 * 海报→文字带的视觉过渡——实底叠下层时总压暗 = 1 − (1−0.62)(1−s) ≥ 0.62，
 * 下限不受下层影响（scrimB 为深色调，只会更暗）。
 */
const POSTER_SCRIM_ALPHA = 0.62;

/**
 * 次级文字（元信息行）不透明度：半透明白必须按「文字合成像素 × 背景」计对比，
 * 0.66 不达标——0.66 白 × 97 灰最坏合成 = 255×0.66+97×0.34=201.28 → 取整 201
 * （向下保守）→ 对比 ≈3.74:1 < 4.5；0.8 → 合成 255×0.8+97×0.2=223.4 → 223 →
 * 对比 ≈4.65:1 ≥ 4.5（恰过线的 0.78≈4.52 余量过薄弃用）。选提文字不透明度而非
 * 提 scrim：0.62 下限与选人卡共享语义，再抬只会让海报更闷。推导与断言见
 * contrastGuard.test.ts 海报文字断言组，两侧同步改。
 */
const POSTER_META_TEXT_ALPHA = 0.8;

/**
 * 卡菜单触发器实底芯压暗下限（对比度守卫配对依据，与 src/components/contrastGuard.test.ts
 * 的 POSTER_ICON_SCRIM_FLOOR 互指）：⋯ 触发器图标恒白 #ffffff（非文字图形，按
 * WCAG 1.4.11 非文字线 3:1 计），原本直落原始渐变无下界（contrastGuard 台账
 * 残留已知项，2026-09-14 实底芯修复转正）。触发器挂 rgba(0,0,0,本档) 28px 圆形
 * 实底芯后，最坏合成与 POSTER_SCRIM_ALPHA 同构（值也同档，互指）：纯白 accent
 * × (1 − 0.62) → 灰 ceil(255×0.38)=97 → 白图标对比 ≈6.19:1 ≥ 3:1，余量充足。
 *
 * 交互态同值覆写（2026-09-14 reviewer 实锤，首版静息态-only 即败于此）：Fluent
 * transparent 外观在 ':hover' 与 ':hover:active,:active:focus-visible' 上各有
 * 底色规则（colorTransparentBackgroundHover/Pressed，本装版本 alias 实证值为
 * 全透明），按选择器键与静息声明并存——hover/按下时组件规则胜出，把实底芯
 * 整体替换回透明，恒白图标在纯白 accent 上重新无下界。故 cardMenuTrigger 以
 * 逐字相同的选择器串同值覆写（键不同则 mergeClasses 不构成冲突，覆写无效）；
 * 菜单展开态（useRootExpandedStyles 的 transparent 底）是非伪类的基础声明，
 * 被本类后置的基础声明直接压过，无需单列。覆写串由守卫 it 文本锚定防回归。
 */
const POSTER_ICON_SCRIM_ALPHA = 0.62;

const useStyles = makeStyles({
  // —— 海报卡共享件（头像图 / 高光 / 色点） ——
  posterImg: {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    position: 'absolute',
    inset: '0px',
  },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: tokens.borderRadiusCircular,
    flexShrink: 0,
  },

  // —— 竖版电影海报卡：全幅渐变 + 底部压暗白字 ——
  cardB: {
    padding: '0px',
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end',
    minHeight: '300px',
    overflow: 'hidden',
    // 16px 大圆角与编辑器面板对齐（SURFACE_RADIUS_PAGE_CARD，页面级卡面
    // 规范见 surfaceSpec.ts）；喂给 Card 的圆角变量让 ::after
    // 聚焦环同步跟随（否则键盘 focus 时方角环会露出来）
    borderRadius: SURFACE_RADIUS_PAGE_CARD,
    '--fui-Card--border-radius': SURFACE_RADIUS_PAGE_CARD,
  },
  letterB: {
    position: 'absolute',
    top: '30px',
    left: '0px',
    right: '0px',
    textAlign: 'center',
    fontSize: '88px',
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: 1,
    color: 'rgba(255, 255, 255, 0.24)',
    userSelect: 'none',
    // 不加 textShadow：半透明填充会透出模糊暗晕，观感像污渍（2026-09-09 用户反馈"脏"）
  },
  scrimB: {
    position: 'absolute',
    left: '0px',
    right: '0px',
    bottom: '0px',
    height: '70%',
    pointerEvents: 'none',
    backgroundImage:
      'linear-gradient(180deg, rgba(14, 13, 22, 0) 0%, rgba(14, 13, 22, 0.55) 45%, rgba(13, 12, 20, 0.92) 100%)',
  },
  contentB: {
    position: 'relative',
    // 文字区实底（POSTER_SCRIM_ALPHA 下限）：OnBrand 白字 × 任意 accent ≥AA，
    // 叠在下方的 scrimB 只会更暗、不破下限（选人卡名字条实底同构分工——
    // 那边 scrim 只管过渡，这边同）
    backgroundColor: `rgba(0, 0, 0, ${POSTER_SCRIM_ALPHA})`,
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    width: '100%',
    padding: tokens.spacingVerticalM,
  },
  nameB: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    // OnBrand token（双主题 #ffffff，运行时读主题）：配对前景与守卫断言同源；
    // 可读性由 contentB 实底（POSTER_SCRIM_ALPHA）保证，见常量注释
    color: tokens.colorNeutralForegroundOnBrand,
    wordBreak: 'break-word',
  },
  metaB: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    rowGap: '2px',
    gap: tokens.spacingHorizontalS,
    marginTop: '4px',
  },
  metaTextB: {
    // 半透明白次级文字：不透明度下限 POSTER_META_TEXT_ALPHA（0.66 最坏合成
    // ≈3.74:1 不达标，见常量注释推导）
    color: `rgba(255, 255, 255, ${POSTER_META_TEXT_ALPHA})`,
    fontSize: tokens.fontSizeBase200,
  },

  // —— 卡菜单（Task-04 导出入口）：海报右上角的 ⋯ 触发器，白字保证暗色海报上可读 ——
  cardMenuTrigger: {
    position: 'absolute',
    top: '8px',
    right: '8px',
    zIndex: 1,
    // 28px 圆形实底芯（POSTER_ICON_SCRIM_ALPHA 下限）：恒白 ⋯ 图标浮在任意
    // accent 渐变上无对比度下界，实底芯给出数学下限（推导见常量注释，守卫
    // 断言见 contrastGuard.test.ts 的 POSTER_ICON_SCRIM_FLOOR 组）。组件
    // iconOnly-small 档 maxWidth=24px 会把盒钳回 24×28 胶囊，显式锁 maxWidth
    // 与 height 同值成正圆
    width: '28px',
    minWidth: '28px',
    maxWidth: '28px',
    height: '28px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: `rgba(0, 0, 0, ${POSTER_ICON_SCRIM_ALPHA})`,
    // 交互态同值覆写（理由与机制见常量注释）：两个选择器串逐字取自
    // @fluentui/react-button useButtonStyles.styles.raw.js 的 transparent 外观
    // 规则——键一致 mergeClasses 才按同键冲突让本类胜出，hover/按下时芯不消失
    ':hover': {
      backgroundColor: `rgba(0, 0, 0, ${POSTER_ICON_SCRIM_ALPHA})`,
    },
    ':hover:active,:active:focus-visible': {
      backgroundColor: `rgba(0, 0, 0, ${POSTER_ICON_SCRIM_ALPHA})`,
    },
  },
  cardMenuIcon: {
    // 触发器图标恒白：可读性由触发器实底芯（POSTER_ICON_SCRIM_ALPHA）保证，
    // 不再依赖「渐变恒深色」的旧假设；配对断言见 contrastGuard.test.ts 的
    // POSTER_ICON_SCRIM_FLOOR 组
    color: '#ffffff',
  },

  clickable: {
    cursor: 'pointer',
  },

  // —— 入场动画（定稿弹性；keyframes 在 app.css；reduced-motion 门控在 @media 内） ——
  // 揭示前占位：滚入视口前以透明等待；揭示后换动画类，动画类里的
  // backwards fill 会在批内延迟期接手维持 from 态，动画止于自然态。
  preReveal: {
    opacity: 0,
  },
  enterPop: {
    '@media (prefers-reduced-motion: no-preference)': {
      animationName: 'card-enter-pop',
      // 弹簧入场档（POP_IN_MS，原 480 与弹层/FLIP 的 400 归并为一档），
      // 曲线共享常量 SPRING_CURVE——均出自 src/components/motion.ts
      animationDuration: `${POP_IN_MS}ms`,
      animationTimingFunction: SPRING_CURVE,
      animationFillMode: 'backwards',
      animationDelay: 'var(--enter-delay, 0ms)',
    },
  },
});

export interface CharacterPosterCardProps {
  character: CharacterSummary;
  /** 卡片在网格中的序号：进 useRevealOnScroll 的 ref 登记与错峰取值。 */
  index: number;
  /** 揭示动画批内错峰延迟（ms）；undefined = 尚未滚入视口，透明占位。 */
  revealDelay: number | undefined;
  /** callback ref 工厂（useRevealOnScroll）：登记元素供 IntersectionObserver 观察。 */
  register: (index: number) => (el: Element | null) => void;
  /** 点击 / Enter / 空格进编辑（脏守卫在父级）。 */
  onOpen: (character: CharacterSummary) => void;
  /** 卡菜单「导出角色卡」（Task-04）：成功/取消静默，真错误由父级就地红字。 */
  onExport: (id: number) => void;
}

export function CharacterPosterCard({
  character,
  index,
  revealDelay,
  register,
  onOpen,
  onExport,
}: CharacterPosterCardProps) {
  const styles = useStyles();
  const lift = useCardLiftStyles();
  const { t } = useTranslation();
  const enterStyle =
    revealDelay === undefined
      ? undefined
      : ({ '--enter-delay': `${revealDelay}ms` } as CSSProperties);
  // null = 跟随全局（0014）：卡片元数据行显示跟随语义而非空值。
  const styleMeta = `${t('characters.renderStyle')} · ${character.renderStyle ?? t('characters.followGlobal')}`;

  return (
    <Card
      size="small"
      tabIndex={0}
      ref={register(index)}
      data-editor-trigger={character.id}
      className={mergeClasses(
        styles.cardB,
        lift.root,
        styles.clickable,
        revealDelay === undefined ? styles.preReveal : styles.enterPop,
      )}
      style={{
        ...enterStyle,
        backgroundImage: posterGradientOf(character),
      }}
      onClick={() => onOpen(character)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(character);
        }
      }}
    >
      {/* 卡菜单（Task-04）：⋯ 触发器置海报右上角；点击/键盘事件不冒泡
          到卡片（否则会同时打开编辑器）。 */}
      <Menu>
        <MenuTrigger>
          <MenuButton
            aria-label={t('characters.cardMenu')}
            appearance="transparent"
            size="small"
            className={styles.cardMenuTrigger}
            icon={<MoreHorizontalRegular className={styles.cardMenuIcon} />}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem icon={<ArrowDownloadRegular />} onClick={() => onExport(character.id)}>
              {t('characters.export')}
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
      {character.avatar ? (
        <img className={styles.posterImg} src={character.avatar} alt={character.name} />
      ) : (
        <span className={styles.letterB}>{character.name.slice(0, 1)}</span>
      )}
      <div className={styles.scrimB} />
      <div className={styles.contentB}>
        <span className={styles.nameB}>{character.name}</span>
        <div className={styles.metaB}>
          <span className={styles.dot} style={{ backgroundImage: dotGradientOf(character) }} />
          <span className={styles.metaTextB}>{styleMeta}</span>
          <span className={styles.metaTextB}>
            {t('characters.sessionCount', { count: character.sessionCount })}
          </span>
        </div>
      </div>
    </Card>
  );
}
