/**
 * 世界编辑器左栏：满高世界色画布（实时预览）。
 *
 * 世界渐变 + 首字水印 + 名称/历法名两行，随右栏表单输入实时更新——形态
 * 学自角色编辑器的 PosterPane（features 禁互引，worlds 域内自建；两处以
 * 内不提取公共海报件）。纯预览，对读屏隐藏（aria-hidden）防与右栏表单
 * 重复。组件不依赖表单钩子：渐变/名称/历法标签均由调用方以 props 注入。
 */
import { Text, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  canvas: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  // 首字水印（同 PosterPane 参数）：不加 textShadow（半透明填充透出暗晕
  // 像污渍，与海报墙同款取舍）
  letter: {
    position: 'absolute',
    top: '24px',
    left: '0px',
    right: '0px',
    textAlign: 'center',
    fontSize: '72px',
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: 1,
    color: 'rgba(255, 255, 255, 0.24)',
    userSelect: 'none',
  },
  scrim: {
    position: 'absolute',
    left: '0px',
    right: '0px',
    bottom: '0px',
    height: '55%',
    pointerEvents: 'none',
    backgroundImage:
      'linear-gradient(180deg, rgba(14, 13, 22, 0) 0%, rgba(14, 13, 22, 0.55) 45%, rgba(13, 12, 20, 0.92) 100%)',
  },
  content: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: tokens.spacingVerticalL,
  },
  name: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: '#ffffff',
    wordBreak: 'break-word',
  },
  calendar: {
    color: 'rgba(255, 255, 255, 0.66)',
    fontSize: tokens.fontSizeBase200,
  },
});

export interface WorldCanvasPaneProps {
  /** 画布背景渐变（worldGradientOf(world.id)，每世界恒定）。 */
  gradient: string;
  /** 世界名（空名回退由调用方解决）；首字水印跟随其首字。 */
  nameText: string;
  /** 历法名标签（default → 「默认数字历」，预设 → 既有 labelKey）。 */
  calendarLabel: string;
}

export function WorldCanvasPane({ gradient, nameText, calendarLabel }: WorldCanvasPaneProps) {
  const styles = useStyles();
  return (
    <aside className={styles.canvas} style={{ backgroundImage: gradient }} aria-hidden>
      <Text className={styles.letter}>{nameText.slice(0, 1)}</Text>
      <div className={styles.scrim} />
      <div className={styles.content}>
        <Text className={styles.name}>{nameText}</Text>
        <Text className={styles.calendar}>{calendarLabel}</Text>
      </div>
    </aside>
  );
}
