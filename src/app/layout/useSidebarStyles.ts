// 会话侧栏样式（自 Sidebar.tsx 拆出，2026-09-13：三态接入后组件文件超
// 500 行上限，先例同 useChatViewStyles—— Griffel 样式钩子独立成文件）。
// 结构：root 只承担 0/232 宽度裁切，inner 固定 232px 承载内容滑出；
// 图标钮外观由 useGhostIconButtonStyles 承载，此处只剩本地特例覆写。
import { makeStyles, tokens } from '@fluentui/react-components';

export const useSidebarStyles = makeStyles({
  // root 只承担宽度裁切：宽度经行内样式注入（0 ↔ 232 过渡）。宽度过渡属
  // 装饰性运动，整体收进 no-preference 门控（2026-09-13 补齐，修法参照
  // useCardLiftStyles）——开启「减弱动态」时收起/展开瞬时完成；两段式
  // 收起的 inner 隐藏兜底（COLLAPSE_HIDE_MS）不依赖过渡，行为不受影响
  root: {
    overflow: 'hidden',
    flexShrink: 0,
    '@media (prefers-reduced-motion: no-preference)': {
      transitionProperty: 'width',
      transitionDuration: tokens.durationGentle,
      transitionTimingFunction: tokens.curveDecelerateMid,
    },
  },
  inner: {
    position: 'relative', // 共享指示条的定位包含块
    width: '232px', // 固定宽：收起时整体滑出被 root 裁掉，而非挤压换行
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    overflowY: 'auto',
  },
  // 会话条目行：选择按钮（占满）+ 删除钮；原条目的 marginLeft 上移到行
  row: {
    display: 'flex',
    alignItems: 'center',
    marginLeft: tokens.spacingHorizontalXS,
  },
  item: {
    flex: 1,
    minWidth: 0, // 标题省略号生效前提（flex 子项默认 min-width:auto）
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    minHeight: '44px',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground1,
    textDecoration: 'none',
    textAlign: 'left',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  itemActive: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Selected },
  },
  // 条目删除钮本地特例（small 档外观/尺寸/悬停底色由钩子承载）：右距 +
  // 常态前景三阶（比钩子默认的次级前景再淡一阶，低调常驻的原设计）+
  // 悬停染危险色（语义特例，钩子头注预告的覆写点）。生成中禁删的守卫在
  // 点击路径上（requestDelete），不禁用按钮以便给出可发现的提示
  deleteBtn: {
    flexShrink: 0,
    marginRight: '2px',
    color: tokens.colorNeutralForeground3,
    ':hover': { color: tokens.colorPaletteRedForeground1 },
  },
  // 共享选中指示条：与活动栏同款（3×16 品牌色圆角竖条）。位置（translate）
  // 由 JS 写入——需 X+Y 双轴位移；默认隐藏，定位后显示。绝对定位子项不
  // 参与 flex/gap 布局；zIndex 提层防止选中底色压住竖条
  indicator: {
    position: 'absolute',
    zIndex: 1,
    left: '0',
    top: '0px',
    width: '3px',
    height: '16px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorBrandBackground,
    pointerEvents: 'none',
    visibility: 'hidden',
  },
  // 条目选择钮的抹平类：它是文字钮（条目 padding、正文字号），不在幽灵
  // 图标钮钩子的收编范围——钩子的固定容器档位（28/36px 居中 + svg 规格）
  // 与其形态冲突，硬套需覆写全部档位属性，得不偿失（审计 C2 仅迁图标钮）
  buttonReset: {
    border: 'none',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    cursor: 'pointer',
  },
  label: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // 头部行：标题 + 工具钮组（新建 / 收起）。行高 36 与活动栏首条目同带
  // （内层 padding-top 8 → 行跨 y 8-44），钮组右缘对齐会话条目右端
  section: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '36px',
    flexShrink: 0,
    padding: `0 0 ${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}`,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  sectionActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
  },
  // 头部图标钮（新建 / 收起）本地特例（medium 档外观/尺寸/悬停底色由钩子
  // 承载，两钮共用规格）：悬停前景压回次级——原设计悬停只提底色不升前景，
  // 按「视觉零变化」以原值为准覆写钩子的悬停前景升阶
  iconBtn: {
    ':hover': { color: tokens.colorNeutralForeground2 },
  },
  title: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    display: 'block',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  empty: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  // 清单三态（加载/失败）的容器：吃掉清单区剩余高度——StateBlock root 是
  // height:100% 的页面级垂直居中块，直接作本栏 flex 子项会参照整栏高、
  // 连同头部工具行一起溢出滚动
  stateWrap: {
    flex: 1,
    minHeight: '0px', // 允许被压缩到清单区实际剩余高，防溢出
  },
  // 轻提示（生成中禁删 / 删除失败等操作反馈）：就地一行，红字，自动消隐；
  // 属段内级轻提示（审计 A4 两级形制），不升页面级占位块
  hint: {
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM}`,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorPaletteRedForeground1,
  },
});
