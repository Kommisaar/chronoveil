/**
 * DropdownPushButton 样式钩子（2026-09-15 自 DropdownPushButton.tsx 纯搬移拆出）：
 * 触发钮（含禁用/交互反馈分支）、下拉菜单、选项行与级联指示的样式单一事实
 * 源。拆分原因：主文件触及 500 行硬上限，样式块按职责外置（同
 * DropdownPushSubmenu 的伴生件口径）。
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import { ITEM_HEIGHT_PX } from './DropdownPushSubmenu';

export const useDropdownPushStyles = makeStyles({
  root: {
    position: 'relative',
    display: 'inline-flex',
    minWidth: '0px',
  },
  // 触发钮对齐 Fluent secondary 控件语言（bg1 + 1px 描边 + hover bg2），
  // 与行内原生 Fluent 按钮同排不跳调
  triggerDisabled: {
    opacity: '0.45',
    // 禁用不保留 pointer 光标（暗示可点）；原生 disabled 不匹配 :active，
    // 但 :hover 仍按指针位置匹配，故悬停/按压反馈拆到 triggerInteractive，
    // 只在未禁用时挂载（同 SegmentedControl segmentIdle 口径）
    cursor: 'default',
  },
  trigger: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalXXS,
    width: '100%',
    // 32px = Fluent Button medium 高度：与同行原生按钮（预览动画）等高
    // （2026-09-14 用户反馈；旧 Fluent Dropdown 按钮是 30px，勿沿用）
    height: '32px',
    padding: '0px 6px 0px 12px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300,
    cursor: 'pointer',
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: tokens.colorBrandForeground1,
      outlineOffset: '1px',
    },
  },
  // 悬停/按下三件套（底 + 描边 + 前景）对齐原生 Fluent Button 次级形态：
  // 从注入样式表实测其 hover/active 规则（背景 Background1Hover/Pressed、
  // 描边 Stroke1Hover/Pressed），按下有明确压暗反馈（用户反馈补齐）。
  // 独立类挂载：禁用态不触发 hover，也不会因点击出现按压态
  triggerInteractive: {
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      border: `1px solid ${tokens.colorNeutralStroke1Hover}`,
      color: tokens.colorNeutralForeground1Hover,
    },
    ':active': {
      backgroundColor: tokens.colorNeutralBackground1Pressed,
      border: `1px solid ${tokens.colorNeutralStroke1Pressed}`,
      color: tokens.colorNeutralForeground1Pressed,
    },
  },
  // 箭头旋转是 aria-expanded 的可视冗余：补间收进 no-preference 媒体块
  // （同 pieces.tsx chevron 门控），减弱动态瞬时翻转
  chevron: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
    '@media (prefers-reduced-motion: no-preference)': {
      transitionProperty: 'transform',
      transitionDuration: tokens.durationFast,
      transitionTimingFunction: tokens.curveEasyEase,
    },
  },
  chevronOpen: {
    transform: 'rotate(180deg)',
  },
  menu: {
    position: 'absolute',
    left: '0px',
    width: '100%',
    zIndex: 20,
    padding: '4px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow16,
  },
  menuBelow: {
    top: 'calc(100% + 6px)',
  },
  menuAbove: {
    bottom: 'calc(100% + 6px)',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    width: '100%',
    height: `${ITEM_HEIGHT_PX}px`,
    flexShrink: 0,
    padding: '0px 8px',
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300,
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2 },
  },
  itemIcon: {
    display: 'inline-flex',
    flexShrink: 0,
    color: tokens.colorNeutralForeground2,
  },
  itemText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  itemCheck: {
    marginLeft: 'auto',
    flexShrink: 0,
    color: tokens.colorBrandForeground1,
  },
  // 级联父行的子菜单指向箭头：方向指示不是选中标记，灰色与触发钮 chevron
  // 同色（复用 itemCheck 会染上品牌蓝——2026-09-15 用户反馈）
  itemArrow: {
    marginLeft: 'auto',
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
  },
  // 级联父行：行容器做子菜单定位参照（relative）；本身不可选（无勾选语义）
  subItem: {
    position: 'relative',
  },
});
