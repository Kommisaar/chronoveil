/**
 * 角色管理竖版电影海报卡（2026-09-09 用户定稿，双形态对比期结束移除横版）：
 * 全幅渐变 + 底部压暗白字。
 *
 * - 每角色渐变按 id 取模 6 组深色低饱和调色板（posterGradientOf），同人恒同色；
 * - 入场动画定稿弹性（card-enter-pop）：揭示延迟由父级的 useRevealOnScroll
 *   按视口序号下发（首屏立即成批、折叠线以下滚入才播，批内 60ms 错峰）；
 *   必须走 Griffel 类 + mergeClasses：Fluent Card 内部对 className 再过一次
 *   Griffel 合并，字符串拼接的全局类会被静默丢弃（repo 规约）；
 * - 卡菜单（Task-04）：海报右上角 ⋯ 触发器出「导出角色卡」；点击/键盘事件
 *   不冒泡到卡片（否则会同时打开编辑器）；
 * - 交互与测试契约不变：卡片是 .fui-Card、名字独立文本节点、点击进编辑；
 * - 海报文字（首字母水印/名字/问候/元信息）一律用普通 span 而非 Text：
 *   Fluent Card 自带 `.fui-Card哈希 .fui-Text { color: currentcolor }`
 *   两类名后代规则（useCardStyles.styles.raw.js），单类名的 Griffel color
 *   压不过它——暗色下继承值恰为白色被掩盖，亮色下会变成深底深字。
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
import { useCardLiftStyles } from '../../components/useCardLiftStyles';
import { dotGradientOf, posterGradientOf } from './posterGradient';

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
    // 16px 大圆角与编辑器面板对齐；喂给 Card 的圆角变量让 ::after
    // 聚焦环同步跟随（否则键盘 focus 时方角环会露出来）
    borderRadius: '16px',
    '--fui-Card--border-radius': '16px',
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
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    width: '100%',
    padding: tokens.spacingVerticalM,
  },
  nameB: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: '#ffffff',
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
    color: 'rgba(255, 255, 255, 0.66)',
    fontSize: tokens.fontSizeBase200,
  },

  // —— 卡菜单（Task-04 导出入口）：海报右上角的 ⋯ 触发器，白字保证暗色海报上可读 ——
  cardMenuTrigger: {
    position: 'absolute',
    top: '8px',
    right: '8px',
    zIndex: 1,
    minWidth: '28px',
    height: '28px',
  },
  cardMenuIcon: {
    // 触发器图标恒白：海报渐变恒为深色调（与卡内白字同一对比度基准）。
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
  const styleMeta = `${t('characters.renderStyle')} · ${character.renderStyle}`;

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
