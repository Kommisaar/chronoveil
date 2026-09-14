/**
 * 级联子菜单飞出层（自 DropdownPushButton 拆出，2026-09-14：原文件触及 500 行
 * 上限，二级飞出层按职责独立成件）。作为主菜单（position:absolute）的子元素
 * 渲染，left/top 为相对主菜单盒的偏移（调用方按行矩形折算：横向右缘放不下
 * 翻左侧，纵向按估算实高选边——下方放不下且上方放得下则向上展开、两侧都不
 * 足则钳在视口内并限高，见 DropdownPushButton.openSubmenu）：主菜单自身无
 * overflow 裁剪，开合动画的 transform 只收编 fixed 后代（absolute 的包含块
 * 是就近定位祖先 = 主菜单），故既不被主菜单列表内滚裁剪，也不受动画影响。
 * 曾尝试 portal 到 body——脱离 FluentProvider 变量作用域后 token 全部解析
 * 失败（背景透明、描边/前景退回初始黑，2026-09-14 实坑），留在主菜单子树内
 * 即天然继承主题。
 */
import { makeStyles, tokens } from '@fluentui/react-components';
import { Checkmark20Regular } from '@fluentui/react-icons';
import type { DropdownPushOption } from './DropdownPushButton';

/** 菜单行高：本模块是级联子系统的单一事实源（DropdownPushButton 的直显行数
 *  换算与此处行形制共用该值）。 */
export const ITEM_HEIGHT_PX = 36;
/** 子菜单定宽：定位计算（右缘翻转）与样式共用。 */
export const SUBMENU_WIDTH_PX = 220;
/** 子菜单盒上下内边距：样式与「估算实高 = 叶子行数 × 行高 + 2×此值」共用。 */
export const SUBMENU_PAD_PX = 4;

const useStyles = makeStyles({
  submenu: {
    position: 'absolute',
    zIndex: 30,
    padding: `${SUBMENU_PAD_PX}px`,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow16,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    overflowY: 'auto',
  },
  // 菜单行形制与 DropdownPushButton 主菜单的 item 同款（两处以内不抽公共件，
  // 改行形制时须两处同改——互指义务见两侧文件头）
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
});

/** 二级飞出层：叶子行渲染与主菜单一致（label + detail + 选中勾），选中叶子
 *  经 onSelect 回调（调用方负责收菜单）。 */
export function DropdownPushSubmenu(props: {
  /** 当前展开的父选项（children 即叶子清单，可访问名取其 label）。 */
  parent: DropdownPushOption;
  /** 相对主菜单盒的偏移（调用方折算，含翻转与视口钳位）。 */
  left: number;
  top: number;
  /** 叶子列表限高（px，调用方按锚点可视域折算）。 */
  maxHeight: number;
  /** 当前选中值（叶子命中即勾选）。 */
  value: string;
  /** 退场动画态（closing 播 pop-out，否则 pop-in）。 */
  closing: boolean;
  onSelect: (value: string) => void;
}) {
  const styles = useStyles();
  return (
    <div
      role="listbox"
      aria-label={props.parent.label}
      className={`${styles.submenu} ${props.closing ? 'dropdown-pop-out' : 'dropdown-pop-in'}`}
      style={{ left: `${props.left}px`, top: `${props.top}px` }}
    >
      <div className={styles.list} style={{ maxHeight: `${props.maxHeight}px` }}>
        {(props.parent.children ?? []).map((c) => (
          <button
            key={c.value}
            type="button"
            role="option"
            aria-selected={c.value === props.value}
            className={styles.item}
            onClick={() => props.onSelect(c.value)}
          >
            {c.icon ? <span className={styles.itemIcon}>{c.icon}</span> : null}
            {/* label 与 detail 合成单文本节点：可访问名按整串计算（同主菜单） */}
            <span className={styles.itemText}>
              {c.detail ? `${c.label} · ${c.detail}` : c.label}
            </span>
            {c.value === props.value ? (
              <Checkmark20Regular className={styles.itemCheck} />
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
