/**
 * 角色页名册行（ledger 档，2026-09-15 三方向对比期第二档，用户批准方案）：
 * 编辑风条目列表，信息密度与扫读效率优先——行间靠留白 + 1px 细线分隔、无
 * 卡片框（名册不是卡片墙），身份信息（称号/人设摘录）同行展示。
 *
 * - 原生 button（同 WorldPlateCard / 旧档案卡先例）：行即「点击进编辑」的
 *   测试契约，Enter/Space 原生自带；user agent 字色/居中/表单字体全部收编
 *   到主题（border 置 0 后由容器口径的 :not(:last-child) 细线接管行分隔）；
 * - 左 44px 方形身份块：有头像 cover 填充；无头像 posterGradientOf 渐变底 +
 *   居中白色首字（同人恒同色，规则同海报卡）；整块 aria-hidden（渐变与首字
 *   皆纯装饰不进 a11y 树，名字在信息列内，同图版卡画布拍板）；
 * - 信息列三行：名字 + 同行称号（空则不出）/ 人设摘录（excerptOf 64 字档，
 *   空则整行不渲染——海报卡同款拍板，留白比占位噪声干净）/ 元信息行（域色
 *   点 + 动画样式 + 会话数）；
 * - 行右端 ⋯ 导出菜单：形态抄 CharacterPosterCard（Menu/MenuTrigger/
 *   MenuPopover）。菜单契约（2026-09-15 reviewer 实测）：①菜单是嵌在可点行
 *   内的 interactive，规范上属嵌套违例，WebView2 运行时可接受（reviewer
 *   裁定维持）；②触发器与菜单项两处都必须 stopPropagation——React 门户
 *   事件沿 React 树冒泡（MenuPopover 虽渲染在 document.body，菜单项的合成
 *   click 仍会抵达行 button 的 onClick），菜单项不截会导出同时打开编辑器。
 *   触发器落中性底行上，无需海报卡的黑实底芯（那是恒白图标浮暗
 *   渐变的对比度下限，此处图标随前景色走）；
 * - data-editor-trigger 必挂：编辑器 getTriggerRect 按角色 id 现测本行矩形
 *   做 FLIP 共享元素过渡；入场 preReveal/enterPop + register/revealDelay
 *   props 同海报卡形态（keyframes 在 app.css）。
 */
import {
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
import { excerptOf } from '../../lib/excerpt';
import { dotGradientOf, posterGradientOf } from './posterGradient';

const useStyles = makeStyles({
  // —— 行本体：横向 flex = 身份块 + 信息列 + 导出菜单 ——
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: '10px 12px',
    // 行内小件档圆角（页面级 16px 大圆角是海报/图版卡的身份，名册行收一档）
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
    // 行分隔细线（设计定稿「留白 + 1px 细线」）：末行无线——名册底部以留白
    // 收尾，不封边框（名册不是卡片墙）
    ':not(:last-child)': {
      borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    },
  },

  // —— 左 44px 方形身份块 ——
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
  identityImg: {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  identityLetter: {
    fontSize: '20px',
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: 1,
    // 白色首字（方案拍板）：渐变底默认深色低饱和（posterGradientOf 调色板），
    // 白字可读；accent 原色直出的极端浅色是海报卡同款已知边界，不在本档处理
    color: '#ffffff',
    userSelect: 'none',
  },

  // —— 信息列：三行（名字+称号 / 摘录 / 元信息） ——
  info: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
    flexShrink: 1,
  },
  nameLine: {
    display: 'flex',
    alignItems: 'baseline',
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
  // 称号同行：色档弱于名字（fg3/base200），被截断的称号全文经 title 可读
  titles: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flexShrink: 1,
  },
  excerpt: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    minWidth: 0,
  },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: tokens.borderRadiusCircular,
    flexShrink: 0,
  },

  // 行右端 ⋯ 触发器：不做绝对定位（海报卡是覆盖在渐变上的浮层语义），名册行
  // 是常规 flex 尾件，随行排版；flexShrink 0 防被长名字挤没
  menuTrigger: {
    flexShrink: 0,
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

export interface CharacterLedgerRowProps {
  character: CharacterSummary;
  /** 行在名册中的序号：进 useRevealOnScroll 的 ref 登记与错峰取值。 */
  index: number;
  /** 揭示动画批内错峰延迟（ms）；undefined = 尚未滚入视口，透明占位。 */
  revealDelay: number | undefined;
  /** callback ref 工厂（useRevealOnScroll）：登记元素供 IntersectionObserver 观察。 */
  register: (index: number) => (el: Element | null) => void;
  /** 点击 / Enter / 空格进编辑（原生 button 自带键盘激活）。 */
  onOpen: (character: CharacterSummary) => void;
  /** 行菜单「导出角色卡」：成功/取消静默，真错误由父级就地红字。 */
  onExport: (id: number) => void;
}

export function CharacterLedgerRow({
  character,
  index,
  revealDelay,
  register,
  onOpen,
  onExport,
}: CharacterLedgerRowProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const enterStyle =
    revealDelay === undefined
      ? undefined
      : ({ '--enter-delay': `${revealDelay}ms` } as CSSProperties);
  // null = 跟随全局（0014）：元信息行显示跟随语义而非空值（同海报卡拼法）
  const styleMeta = `${t('characters.renderStyle')} · ${character.renderStyle ?? t('characters.followGlobal')}`;
  // 称号整串「」包裹、「·」连接（同海报卡拍板）；摘录走 excerptOf（64 字档，
  // 名册行比海报卡 48 字档宽一档）
  const titlesText = character.titles.length > 0 ? `「${character.titles.join(' · ')}」` : '';
  const personaExcerpt = excerptOf(character.persona, 64);

  return (
    <button
      type="button"
      ref={register(index)}
      // FLIP 共享元素过渡锚点：编辑器 getTriggerRect 按角色 id 现测本行矩形
      data-editor-trigger={character.id}
      className={mergeClasses(
        styles.row,
        revealDelay === undefined ? styles.preReveal : styles.enterPop,
      )}
      style={enterStyle}
      onClick={() => onOpen(character)}
    >
      {/* 身份块：有头像 cover 填充；无头像渐变底 + 白色首字（整块纯装饰） */}
      <span
        className={styles.identity}
        style={character.avatar ? undefined : { backgroundImage: posterGradientOf(character) }}
        aria-hidden
      >
        {character.avatar ? (
          <img className={styles.identityImg} src={character.avatar} alt="" />
        ) : (
          <span className={styles.identityLetter}>{character.name.slice(0, 1)}</span>
        )}
      </span>
      <span className={styles.info}>
        <span className={styles.nameLine}>
          <span className={styles.name}>{character.name}</span>
          {titlesText ? (
            <span className={styles.titles} title={titlesText}>
              {titlesText}
            </span>
          ) : null}
        </span>
        {/* 人设摘录空则整行不渲染（同海报卡拍板） */}
        {personaExcerpt ? <span className={styles.excerpt}>{personaExcerpt}</span> : null}
        <span className={styles.meta}>
          <span className={styles.dot} style={{ backgroundImage: dotGradientOf(character) }} />
          <span>{styleMeta}</span>
          <span>{t('characters.sessionCount', { count: character.sessionCount })}</span>
        </span>
      </span>
      {/* 行菜单：点击/键盘事件不冒泡进行（否则会同时打开编辑器） */}
      <Menu>
        <MenuTrigger>
          <MenuButton
            aria-label={t('characters.cardMenu')}
            appearance="transparent"
            size="small"
            className={styles.menuTrigger}
            icon={<MoreHorizontalRegular />}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {/* 菜单项也要 stopPropagation（契约见文件头②）：门户 click 沿 React
                树冒泡，不截会导出同时打开编辑器 */}
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
    </button>
  );
}
