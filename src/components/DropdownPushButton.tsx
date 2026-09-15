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
import { mergeClasses } from '@fluentui/react-components';
import {
  Checkmark20Regular,
  ChevronDown20Regular,
  ChevronRight20Regular,
} from '@fluentui/react-icons';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { DROPDOWN_POP_MS } from './motion';
import { useDropdownPushStyles } from './useDropdownPushStyles';
// 级联子系统共用常量与二级飞出层（本文件超 500 行上限时按职责拆出的伴生件）
import {
  DropdownPushSubmenu,
  ITEM_HEIGHT_PX,
  SUBMENU_PAD_PX,
  SUBMENU_WIDTH_PX,
} from './DropdownPushSubmenu';
// 落位几何纯函数（主菜单与子菜单共用的可视边界口径与子菜单纵向选边）
import { findClipBounds, MARGIN_PX, placeSubmenuVertically } from './dropdownPlacement';
/** 菜单与锚点的间距（纵向落位与横向翻转共用；裁剪余量 MARGIN_PX 在
 *  dropdownPlacement）。 */
const GAP_PX = 6;


export interface DropdownPushOption {
  value: string;
  label: string;
  /** 菜单行内的弱化次级说明（如引擎 id）缀在文案后；触发钮只显 label。 */
  detail?: string;
  /** 行首图标（复刻 RoundMenu 的图标行）；缺省不占位。 */
  icon?: ReactNode;
  /** 级联子菜单（复刻 RoundMenu submenu，2026-09-14）：有 children 的行自身
   *  不可选，悬停/点击在行右侧展开二级飞出层，选中叶子才触发 onChange（叶子
   *  value 需全局唯一，建议调用方用「父 id::子 id」复合键）。仅支持两级。
   *  叶子 label 用裸名（不带父级前缀）：二级菜单里父行就在旁边（子菜单名也
   *  取父 label），前缀冗余；触发钮脱离子菜单上下文，由组件组合
   *  「父 label / 叶 label」补回指认信息（2026-09-14 用户反馈去前缀）。 */
  children?: DropdownPushOption[];
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
  /** 值未命中任何选项时的触发钮占位文案（如「未设置」）；缺省显示原值。 */
  placeholder?: string;
  className?: string;
}

type Phase = 'closed' | 'open' | 'closing';

export function DropdownPushButton(props: DropdownPushButtonProps) {
  const styles = useDropdownPushStyles();
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
  // 级联子菜单：当前展开的父行 value + 飞出层落位（相对主菜单盒的偏移与列
  // 表限高，null = 收起）。
  const [openSub, setOpenSub] = useState<string | null>(null);
  const [subPos, setSubPos] = useState<{ left: number; top: number; maxHeight: number } | null>(
    null,
  );

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
    setOpenSub(null);
    setPhase('open');
  };
  const requestClose = (): void => {
    // closing 期间重复触发（Esc + 点外部连发）只记一次退场定时
    if (phase !== 'open' || closeTimer.current !== null) return;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setPhase('closed');
      setOpenSub(null);
    }, DROPDOWN_POP_MS);
    setPhase('closing');
  };

  // 点外部即关（pointerdown 捕获按下瞬间）+ Esc 即收。requestClose 是渲染期
  // 闭包、语义只随 phase 变化，刻意不列依赖（列了则每次渲染重挂监听）。
  useEffect(() => {
    if (phase !== 'open') return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Element;
      if (wrapRef.current && !wrapRef.current.contains(target)) {
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

  // 主菜单与子菜单共用的可视边界（最近裁剪容器 ∩ 视口，口径单一事实源在
  // dropdownPlacement.findClipBounds；以触发钮包裹层为起点向上找）。
  const clipBounds = () => findClipBounds(wrapRef.current);

  // 落位量测：打开后、首帧绘制前（useLayoutEffect）在 clipBounds 内选边——
  // 下方放不下且上方放得下则翻转，都放不下选更大一侧并限高。closing 复用
  // 已算好的落位（动画期间不重排）。量测依赖真实布局，jsdom 全零矩形恒走
  // 下方默认，翻转分支由浏览器实测验证（单测不覆盖，原因见测试文件头）。
  useLayoutEffect(() => {
    if (phase !== 'open' || placement !== null) return;
    const wrap = wrapRef.current;
    const menu = menuRef.current;
    if (!wrap || !menu) return;

    const { top: topBound, bottom: bottomBound } = clipBounds();

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

  // 选中项递归查找（两级：父行 value 不参与选中，叶子命中即当前值）；命中
  // 叶子时连同父行带回——触发钮的组合文案需要父级上下文（见 children 契约）。
  const findSelected = (
    options: DropdownPushOption[],
  ): { option: DropdownPushOption; parent?: DropdownPushOption } | undefined => {
    const top = options.find((o) => o.value === props.value);
    if (top !== undefined) return { option: top };
    for (const o of options) {
      const leaf = (o.children ?? []).find((c) => c.value === props.value);
      if (leaf !== undefined) return { option: leaf, parent: o };
    }
    return undefined;
  };
  const selected = findSelected(props.options);
  // 当前展开子菜单的父选项（openSub/subPos 齐备才有；悬空 id 不渲染飞出层）
  const sub =
    openSub !== null && subPos !== null
      ? (props.options.find((o) => o.value === openSub) ?? null)
      : null;

  /** 悬停/点击父行：以行矩形定位子菜单。横向主菜单右侧展开，视口右缘放不
   *  下翻左侧；纵向选边（估算实高 = 叶子数 × 行高 + 盒内边距，直显上限截断
   *  ——形制固定故无需等渲染量测）交给 placeSubmenuVertically 纯函数，边界
   *  取 clipBounds 与主菜单落位同口径。选边数学已单测；事件期取矩形等时序
   *  依赖真实布局，jsdom 全零矩形走不了真实分支（浏览器实测验证）。偏移换
   *  算到主菜单盒坐标——子菜单是其 absolute 子元素（留在 FluentProvider 子
   *  树内继承主题变量，portal 出去会丢 token，见 DropdownPushSubmenu 头注）。 */
  const openSubmenu = (o: DropdownPushOption, el: HTMLElement): void => {
    const menu = menuRef.current;
    if (!menu) return;
    const r = el.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    let left = r.right + GAP_PX - m.left;
    if (r.right + GAP_PX + SUBMENU_WIDTH_PX > window.innerWidth - MARGIN_PX) {
      // 翻到行左侧；钳位换算到菜单盒坐标（允许伸到菜单左外侧，只保视口余量）
      left = Math.max(r.left - SUBMENU_WIDTH_PX - GAP_PX - m.left, MARGIN_PX - m.left);
    }
    const { top: boundTop, bottom: boundBottom } = clipBounds();
    const listCap = props.maxVisibleItems * ITEM_HEIGHT_PX;
    const subH =
      Math.min((o.children ?? []).length * ITEM_HEIGHT_PX, listCap) + SUBMENU_PAD_PX * 2;
    // 纵向选边纯函数（口径与分支细节见 dropdownPlacement.placeSubmenuVertically）
    const placementV = placeSubmenuVertically({
      rowTop: r.top,
      rowBottom: r.bottom,
      bounds: { top: boundTop, bottom: boundBottom },
      subH,
      listCap,
      boxPad: SUBMENU_PAD_PX * 2,
    });
    setSubPos({
      left,
      top: placementV.top - m.top,
      maxHeight: placementV.maxHeight,
    });
    setOpenSub(o.value);
  };
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
        className={mergeClasses(
          styles.trigger,
          props.disabled ? styles.triggerDisabled : styles.triggerInteractive,
        )}
        aria-label={props.ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={props.disabled ? false : open}
        disabled={props.disabled}
        onClick={() => (phase === 'open' ? requestClose() : openMenu())}
      >
        {/* 叶子选中时组合「父 / 叶」：触发钮处没有二级菜单的父行上下文，
            裸名无法指认（同值在别的服务下可能重名）；detail 仍不上面板。 */}
        <span className={styles.itemText}>
          {selected === undefined
            ? (props.placeholder ?? props.value)
            : selected.parent === undefined
              ? selected.option.label
              : `${selected.parent.label} / ${selected.option.label}`}
        </span>
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
            {props.options.map((o) => {
              const hasSub = (o.children?.length ?? 0) > 0;
              if (!hasSub) {
                return (
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
                );
              }
              // 级联父行：不可选，悬停/点击展开右侧子菜单（叶子才回调 onChange）
              return (
                <div
                  key={o.value}
                  className={styles.subItem}
                  onMouseEnter={(e) => openSubmenu(o, e.currentTarget)}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    aria-haspopup="true"
                    aria-expanded={openSub === o.value}
                    className={styles.item}
                    onClick={(e) => openSubmenu(o, e.currentTarget)}
                  >
                    {o.icon ? <span className={styles.itemIcon}>{o.icon}</span> : null}
                    <span className={styles.itemText}>
                      {o.detail ? `${o.label} · ${o.detail}` : o.label}
                    </span>
                    <ChevronRight20Regular className={styles.itemArrow} />
                  </button>
                </div>
              );
            })}
          </div>
          {/* 二级飞出层：主菜单的 absolute 子元素（偏移已折算到菜单盒，见
              openSubmenu；悬空父 id 不渲染）。 */}
          {sub !== null && subPos !== null ? (
            <DropdownPushSubmenu
              parent={sub}
              left={subPos.left}
              top={subPos.top}
              maxHeight={subPos.maxHeight}
              value={props.value}
              closing={phase === 'closing'}
              onSelect={(v) => {
                props.onChange(v);
                requestClose();
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
