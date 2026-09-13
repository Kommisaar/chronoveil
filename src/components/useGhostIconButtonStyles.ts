/**
 * 幽灵图标钮（审计 C2 前置）：原生 button 手动抹平默认外观的统一样式钩子。
 * 收编对象（消费方接入是后续任务，现状文件只读作设计基准）：AppShell 的
 * expandBtn、useChatViewStyles 的 ledgerToggle、Sidebar 的 deleteBtn / iconBtn、
 * ActivityBar 的 item + buttonReset 等 6+ 处各自重写的 border:none / padding:0 /
 * cursor / '> svg' 尺寸样板。
 *
 * 用法（必须配合 mergeClasses，不能用模板字符串拼接——Griffel 每个返回值带
 * 序列标识，拼接后 mergeClasses 只认第一个序列，原因详见 useCardLiftStyles 头注）：
 *
 * ```tsx
 * const s = useGhostIconButtonStyles('medium');
 * <button type="button" className={mergeClasses(s.root, 本地特例)} onClick={...}>
 *   <Some20Regular />
 * </button>
 * ```
 *
 * 设计基准 = Sidebar iconBtn / ActivityBar 条目：透明底、次级前景、悬停底色
 * 提亮一阶 + 前景升一阶、容器 borderRadiusMedium。图标尺寸档位（16px / 20px）
 * 对齐 Fluent Button 的 size small / medium 图标规格——Fluent v9 主题没有
 * sizeIcon token（各组件按 size 档位硬编码 16/20/24），故此处以常量档位承载，
 * 后续消费方迁入时以本钩子为单一事实源。
 *
 * 已知特例由消费方本地覆写（mergeClasses 后写覆盖前）：
 * - 浮于内容之上的钮（AppShell expandBtn / ledgerToggle）：覆写不透明底色
 *   tokens.colorNeutralBackground1，避免滚动内容从钮底透出；
 * - 语义特例（Sidebar deleteBtn 悬停染危险色）：本地覆写 ':hover' 的 color。
 */
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';

export type GhostIconButtonSize = 'small' | 'medium';

export interface GhostIconButtonOptions {
  /**
   * 禁用态：前景降为禁用阶、光标 not-allowed（对齐 Fluent v9 Button 的禁用
   * 处方），并把悬停反馈压回透明底 / 禁用前景，避免「看似可点」。
   * 类型显式带 | undefined：exactOptionalPropertyTypes 下调用方持有的
   * 「可能为 undefined」的布尔值（如 store 判定结果）才能原样传入。
   */
  disabled?: boolean | undefined;
}

export interface GhostIconButtonStyles {
  /** 合并完成的根类（外观 + 档位 + 可选禁用态）；消费方在其后 mergeClasses 本地特例。 */
  root: string;
}

const useStyles = makeStyles({
  // 共同外观：手动抹平原生 button 默认样式。焦点环照搬 Fluent v9 Button 的
  // data-fui-focus-visible 处方（透明占位 outline + 内嵌 1px 焦点环阴影）——
  // 原生 button 拿不到该属性，改用 :focus-visible 伪类触发同款 token 组合；
  // 内嵌环不越出容器，收起态窄栏（overflow 裁切）下不会被剪掉。
  root: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0px',
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      color: tokens.colorNeutralForeground1,
    },
    ':focus-visible': {
      outlineWidth: tokens.strokeWidthThick,
      outlineStyle: 'solid',
      outlineColor: tokens.colorTransparentStroke,
      boxShadow: `0 0 0 ${tokens.strokeWidthThin} ${tokens.colorStrokeFocus2} inset`,
    },
    // 图标尺寸随档位覆盖；flexShrink:0 防容器挤压时 svg 被压缩（ActivityBar 先例：
    // 仅设 font-size 对带显式 width/height 属性的 svg 无效，必须 CSS 尺寸覆盖）
    '> svg': { flexShrink: 0 },
  },
  small: {
    width: '28px',
    height: '28px',
    '> svg': { width: '16px', height: '16px', fontSize: '16px' },
  },
  medium: {
    width: '36px',
    height: '36px',
    '> svg': { width: '20px', height: '20px', fontSize: '20px' },
  },
  disabled: {
    color: tokens.colorNeutralForegroundDisabled,
    cursor: 'not-allowed',
    // 悬停底色/前景一并压回禁用形态（mergeClasses 后写覆盖 root 的 ':hover'）
    ':hover': {
      backgroundColor: 'transparent',
      color: tokens.colorNeutralForegroundDisabled,
    },
  },
});

/** 幽灵图标钮统一样式：appearance 抹平 + 尺寸档位 + 悬停/焦点/禁用反馈单一事实源。 */
export function useGhostIconButtonStyles(
  size: GhostIconButtonSize,
  options?: GhostIconButtonOptions,
): GhostIconButtonStyles {
  const styles = useStyles();
  return {
    root: mergeClasses(
      styles.root,
      size === 'small' ? styles.small : styles.medium,
      options?.disabled === true && styles.disabled,
    ),
  };
}
