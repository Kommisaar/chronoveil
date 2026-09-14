/**
 * 下拉推钮（2026-09-14 复刻 qfluentwidgets 的 DropDownPushButton + RoundMenu，
 * 替换角色编辑器「动画样式」的 Fluent Dropdown）：触发钮 = 当前值 + 下拉
 * 箭头，点击弹出圆角菜单（行首图标 + 文案 + 弱化次级说明，选中行尾勾）。
 * 与 Fluent Dropdown 的差异即复刻需求点：
 * - maxVisibleItems 必填：菜单最多直显 N 行（行高 ITEM_HEIGHT_PX 单一事实源），
 *   超出列表内滚，打开时自动滚到选中行；
 * - 开合动效：app.css 的 dropdown-pop-in / dropdown-pop-out（Griffel 不透出
 *   keyframes），时长单一事实源 motion.ts 的 DROPDOWN_POP_MS（CSS 侧
 *   --cv-dropdown-pop-ms 互指，parity 由 motion.test.ts 断言），进弹簧退安静，
 *   减弱动态瞬时开合；退场为 closing 态 + 定时卸载，动画播完菜单才离场。
 * 落位：默认贴锚点下方展开；下方放不下且上方放得下时翻转向下→向上，两侧
 * 都放不下选更大一侧并对列表限高（面板永远贴锚点，绝不钳位到远处盖住按钮
 * ——同 AccentColorPicker 对「弹层越出画面」的踩坑口径），横向不钳位（菜单
 * 与触发钮同宽）。
 */
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { Checkmark20Regular, ChevronDown20Regular } from '@fluentui/react-icons';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { DROPDOWN_POP_MS } from './motion';

/** 菜单行高：maxVisibleItems 换算列表 max-height 的单一事实源。 */
const ITEM_HEIGHT_PX = 36;
/** 菜单与锚点的间距 / 落位量测时与裁剪边界的余量（同 AccentColorPicker 口径）。 */
const GAP_PX = 6;
const MARGIN_PX = 8;

const useStyles = makeStyles({
  root: {
    position: 'relative',
    display: 'inline-flex',
    minWidth: '0px',
  },
  // 触发钮对齐 Fluent secondary 控件语言（bg1 + 1px 描边 + hover bg2），
  // 与行内原生 Fluent 按钮同排不跳调
  triggerDisabled: {
    opacity: '0.45',
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
    // 悬停/按下三件套（底 + 描边 + 前景）对齐原生 Fluent Button 次级形态：
    // 从注入样式表实测其 hover/active 规则（背景 Background1Hover/Pressed、
    // 描边 Stroke1Hover/Pressed），按下有明确压暗反馈（用户反馈补齐）
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
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: tokens.colorBrandForeground1,
      outlineOffset: '1px',
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
});

export interface DropdownPushOption {
  value: string;
  label: string;
  /** 菜单行内的弱化次级说明（如引擎 id）缀在文案后；触发钮只显 label。 */
  detail?: string;
  /** 行首图标（复刻 RoundMenu 的图标行）；缺省不占位。 */
  icon?: ReactNode;
}

export interface DropdownPushButtonProps {
  options: DropdownPushOption[];
  value: string;
  onChange: (value: string) => void;
  /** 可访问名（触发钮 aria-label + 菜单 listbox 名）。 */
  ariaLabel: string;
  /** 菜单最多直显的行数，超出内滚（复刻 setMaxVisibleItems 语义）。 */
  maxVisibleItems: number;
  /** 禁用（跟随全局态）：断交互 + 压暗，值由调用方显示全局基准。 */
  disabled?: boolean;
  className?: string;
}

type Phase = 'closed' | 'open' | 'closing';

export function DropdownPushButton(props: DropdownPushButtonProps) {
  const styles = useStyles();
  const [phase, setPhase] = useState<Phase>('closed');
  // 落位（null = 未量测，走 CSS 默认下方展开）：翻转方向 + 两侧都放不下时
  // 的列表限高
  const [placement, setPlacement] = useState<{
    above: boolean;
    listMaxHeight?: number;
  } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);

  const clearCloseTimer = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  useEffect(() => clearCloseTimer, []);

  // 禁用翻转时立即收起（跟随全局切换瞬间不留残菜单）。phase 为闭包值刻意
  // 不列依赖：翻转瞬间无论 open/closing 都归 closed，语义不受旧值影响。
  useEffect(() => {
    if (props.disabled && phase !== 'closed') {
      clearCloseTimer();
      setPhase('closed');
    }
  }, [props.disabled]);

  const openMenu = (): void => {
    if (props.disabled) return;
    clearCloseTimer();
    setPlacement(null);
    setPhase('open');
  };
  const requestClose = (): void => {
    // closing 期间重复触发（Esc + 点外部连发）只记一次退场定时
    if (phase !== 'open' || closeTimer.current !== null) return;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setPhase('closed');
    }, DROPDOWN_POP_MS);
    setPhase('closing');
  };

  // 点外部即关（pointerdown 捕获按下瞬间）+ Esc 即收。requestClose 是渲染期
  // 闭包、语义只随 phase 变化，刻意不列依赖（列了则每次渲染重挂监听）。
  useEffect(() => {
    if (phase !== 'open') return;
    const onPointerDown = (e: PointerEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        requestClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') requestClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [phase]);

  // 落位量测：打开后、首帧绘制前（useLayoutEffect）在「最近裁剪容器
  // （overflow 非 visible 祖先）∩ 视口」内选边——下方放不下且上方放得下
  // 则翻转，都放不下选更大一侧并限高。closing 复用已算好的落位（动画期间
  // 不重排）。量测依赖真实布局，jsdom 全零矩形恒走下方默认，翻转分支由
  // 浏览器实测验证（单测不覆盖，原因见测试文件头）。
  useLayoutEffect(() => {
    if (phase !== 'open' || placement !== null) return;
    const wrap = wrapRef.current;
    const menu = menuRef.current;
    if (!wrap || !menu) return;

    let clipTop: number | null = null;
    let clipBottom: number | null = null;
    let node: HTMLElement | null = wrap.parentElement;
    while (node) {
      const cs = getComputedStyle(node);
      // overflow 为空串视为未裁剪：jsdom 的 getComputedStyle 不解析 overflow
      // （返回 ''），不豁免会把单测里每个祖先都误判成裁剪容器
      if (cs.overflowY !== '' && cs.overflowY !== 'visible') {
        const r = node.getBoundingClientRect();
        clipTop = r.top;
        clipBottom = r.bottom;
        break;
      }
      node = node.parentElement;
    }
    const topBound = Math.max(clipTop ?? 0, 0) + MARGIN_PX;
    const bottomBound =
      Math.min(clipBottom ?? window.innerHeight, window.innerHeight) - MARGIN_PX;

    const wrapRect = wrap.getBoundingClientRect();
    const menuH = menu.offsetHeight;
    const listH = listRef.current?.offsetHeight ?? 0;
    const belowTop = wrapRect.bottom + GAP_PX;
    const aboveBottom = wrapRect.top - GAP_PX;
    const availBelow = bottomBound - belowTop;
    const availAbove = aboveBottom - topBound;

    if (menuH <= availBelow) {
      setPlacement({ above: false });
    } else if (menuH <= availAbove) {
      setPlacement({ above: true });
    } else if (availBelow >= availAbove) {
      setPlacement({
        above: false,
        listMaxHeight: Math.max(availBelow - (menuH - listH), 0),
      });
    } else {
      setPlacement({
        above: true,
        listMaxHeight: Math.max(availAbove - (menuH - listH), 0),
      });
    }

    // 打开即把选中行滚入可视（直显行数受限时选中项可能在内滚区外）；
    // scrollIntoView 在 jsdom 无实现，能力探测后调用（行为增强，缺实现无碍交互）
    const selectedEl = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (selectedEl && typeof selectedEl.scrollIntoView === 'function') {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [phase, placement]);

  const selected = props.options.find((o) => o.value === props.value);
  const open = phase !== 'closed';
  const visibleCap = props.maxVisibleItems * ITEM_HEIGHT_PX;
  const listMaxHeight =
    placement?.listMaxHeight !== undefined
      ? Math.min(visibleCap, placement.listMaxHeight)
      : visibleCap;
  return (
    <div ref={wrapRef} className={mergeClasses(styles.root, props.className)}>
      <button
        type="button"
        className={mergeClasses(styles.trigger, props.disabled && styles.triggerDisabled)}
        aria-label={props.ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={props.disabled ? false : open}
        disabled={props.disabled}
        onClick={() => (phase === 'open' ? requestClose() : openMenu())}
      >
        <span className={styles.itemText}>{selected ? selected.label : props.value}</span>
        <ChevronDown20Regular
          className={mergeClasses(styles.chevron, open && styles.chevronOpen)}
        />
      </button>
      {open ? (
        <div
          ref={menuRef}
          role="listbox"
          aria-label={props.ariaLabel}
          className={`${styles.menu} ${
            placement?.above ? styles.menuAbove : styles.menuBelow
          } ${phase === 'closing' ? 'dropdown-pop-out' : 'dropdown-pop-in'}`}
        >
          <div ref={listRef} className={styles.list} style={{ maxHeight: `${listMaxHeight}px` }}>
            {props.options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === props.value}
                className={styles.item}
                onClick={() => {
                  props.onChange(o.value);
                  requestClose();
                }}
              >
                {o.icon ? <span className={styles.itemIcon}>{o.icon}</span> : null}
                {/* label 与 detail 合成单文本节点：可访问名按整串计算
                    （分嵌套 span 会在元素边界丢空格，读屏名成「甲· a」） */}
                <span className={styles.itemText}>
                  {o.detail ? `${o.label} · ${o.detail}` : o.label}
                </span>
                {o.value === props.value ? (
                  <Checkmark20Regular className={styles.itemCheck} />
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
