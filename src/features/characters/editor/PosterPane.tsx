/**
 * 角色编辑器左栏：电影海报占满整列的实时预览。
 *
 * 渐变 + 首字水印 + 名字 + 称号 + 出场风格，随表单输入实时更新，与海报墙
 * 语言统一（渐变规则同 posterGradientOf；称号行 2026-09-15 卡面升级随墙内
 * 同步——墙内墙外「文本形态」一致：整串「」+「·」连接；字号/色档/截断随
 * 各自容器分档，非逐位同构）。纯预览，对读屏隐藏（aria-hidden）防与右栏表单重复。
 */
import { Text, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  // —— 左：电影海报占满整列 ——
  poster: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  posterLetter: {
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
    // 与海报墙一致：不加 textShadow（半透明填充透出暗晕像污渍）
  },
  posterScrim: {
    position: 'absolute',
    left: '0px',
    right: '0px',
    bottom: '0px',
    height: '55%',
    pointerEvents: 'none',
    backgroundImage:
      'linear-gradient(180deg, rgba(14, 13, 22, 0) 0%, rgba(14, 13, 22, 0.55) 45%, rgba(13, 12, 20, 0.92) 100%)',
  },
  posterContent: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: tokens.spacingVerticalL,
  },
  posterName: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: '#ffffff',
    wordBreak: 'break-word',
  },
  posterMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginTop: '4px',
  },
  posterMetaText: {
    color: 'rgba(255, 255, 255, 0.66)',
    fontSize: tokens.fontSizeBase200,
  },
  // 称号行（2026-09-15 卡面升级）：色档沿 posterMetaText——本栏是 aria-hidden
  // 装饰预览、无实底，沿用其既有次级文字档；单行截断与海报墙 identityB 一致
  posterTitles: {
    color: 'rgba(255, 255, 255, 0.66)',
    fontSize: tokens.fontSizeBase200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  posterDot: {
    width: '8px',
    height: '8px',
    borderRadius: tokens.borderRadiusCircular,
    flexShrink: 0,
  },
});

export interface PosterPaneProps {
  /** 海报背景渐变（外壳渲染主题派生，随表单输入实时更新）。 */
  posterGradient: string;
  /** 海报名（回退名）；首字水印跟随其首字，新建空名时同取「新」。 */
  nameText: string;
  /** 称号行文本（调用方已拼好「称号一 · 称号二」）；空串 = 无称号不渲染。 */
  titlesText: string;
  /** 出场风格色点渐变（与强调色板同一派生）。 */
  dotGradient: string;
  /** 出场风格标签文案。 */
  styleLabel: string;
}

export function PosterPane({
  posterGradient,
  nameText,
  titlesText,
  dotGradient,
  styleLabel,
}: PosterPaneProps) {
  const styles = useStyles();
  return (
    <aside className={styles.poster} style={{ backgroundImage: posterGradient }} aria-hidden>
      {/* 首字水印跟随海报名的回退名：新建空名时与海报名一致取
          「新」，比 72px 的间隔号「·」缩成一粒悬浮小点更成海报 */}
      <Text className={styles.posterLetter}>{nameText.slice(0, 1)}</Text>
      <div className={styles.posterScrim} />
      <div className={styles.posterContent}>
        <Text className={styles.posterName}>{nameText}</Text>
        {titlesText ? (
          <Text className={styles.posterTitles}>{`「${titlesText}」`}</Text>
        ) : null}
        <div className={styles.posterMeta}>
          <span className={styles.posterDot} style={{ backgroundImage: dotGradient }} />
          <Text className={styles.posterMetaText}>{styleLabel}</Text>
        </div>
      </div>
    </aside>
  );
}
