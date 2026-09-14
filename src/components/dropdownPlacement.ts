// DropdownPushButton 级联菜单的落位几何（纯计算，与 React 渲染解耦）。主菜
// 单落位与二级子菜单选边共用 findClipBounds 的同一可视边界口径：子菜单若只
// 看视口，会在对话框等内滚容器里戳出可视盒（2026-09-15 实测）。选边分支在
// 此为纯函数可直接单测；组件侧的量测时序（useLayoutEffect、事件期取矩形、
// 动画影响）仍由浏览器实测验证（jsdom 全零矩形量不出真实布局）。

/** 菜单与可视边界的余量（同 AccentColorPicker「弹层越出画面」的踩坑口径）。 */
export const MARGIN_PX = 8;

export interface PlacementBounds {
  top: number;
  bottom: number;
}

/** 最近裁剪容器（startEl 的 overflow 非 visible 祖先）∩ 视口的可视上下界
 *  （视口坐标；无裁剪祖先时即视口）。overflow 为空串视为未裁剪：jsdom 的
 *  getComputedStyle 不解析 overflow（返回 ''），不豁免会把单测里每个祖先都
 *  误判成裁剪容器。 */
export function findClipBounds(startEl: HTMLElement | null): PlacementBounds {
  let clipTop: number | null = null;
  let clipBottom: number | null = null;
  let node: HTMLElement | null = startEl?.parentElement ?? null;
  while (node) {
    const cs = getComputedStyle(node);
    if (cs.overflowY !== '' && cs.overflowY !== 'visible') {
      const r = node.getBoundingClientRect();
      clipTop = r.top;
      clipBottom = r.bottom;
      break;
    }
    node = node.parentElement;
  }
  return {
    top: Math.max(clipTop ?? 0, 0) + MARGIN_PX,
    bottom: Math.min(clipBottom ?? window.innerHeight, window.innerHeight) - MARGIN_PX,
  };
}

/** 子菜单纵向选边：估算实高 subH 在行两侧选边——下方放不下且上方放得下则
 *  底边对齐行底向上展开；两侧都不足选更大一侧，钳在 bounds 内并把列表限高
 *  到剩余空间（boxPad = 菜单盒上下内边距之和，限高时扣除）内滚。返回的 top
 *  为视口坐标（调用方再折算到主菜单盒偏移）。 */
export function placeSubmenuVertically(args: {
  rowTop: number;
  rowBottom: number;
  bounds: PlacementBounds;
  subH: number;
  listCap: number;
  boxPad: number;
}): { top: number; maxHeight: number } {
  const { rowTop, rowBottom, bounds, subH, listCap, boxPad } = args;
  const availBelow = bounds.bottom - rowTop;
  const availAbove = rowBottom - bounds.top;
  if (subH <= availBelow) return { top: rowTop, maxHeight: listCap };
  if (subH <= availAbove) return { top: rowBottom - subH, maxHeight: listCap };
  if (availBelow >= availAbove) {
    return { top: rowTop, maxHeight: Math.max(availBelow - boxPad, 0) };
  }
  return { top: bounds.top, maxHeight: Math.max(availAbove - boxPad, 0) };
}
