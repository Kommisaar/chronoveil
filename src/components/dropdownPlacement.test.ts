// @vitest-environment node —— 纯几何计算无 DOM 依赖，跳过 jsdom 环境创建
// dropdownPlacement 子菜单纵向选边单测：四分支（下方放得下 / 上方放得下 /
// 两侧都不足选下方 / 选上方）与限高负值守卫。取矩形等量测时序由组件浏览器
// 实测验证（jsdom 全零矩形走不了真实布局），见 DropdownPushButton.openSubmenu。
import { describe, expect, it } from 'vitest';
import { placeSubmenuVertically } from './dropdownPlacement';

// 常用场景参数：列表直显上限 288（8 行 × 36）、盒内边距 8、子菜单实高 80
//（2 叶 × 36 + 8）。
const ARGS = { subH: 80, listCap: 288, boxPad: 8 };

describe('placeSubmenuVertically（子菜单纵向选边）', () => {
  it('下方放得下：顶对齐行顶，限高 = 直显上限', () => {
    const r = placeSubmenuVertically({
      ...ARGS,
      rowTop: 500,
      rowBottom: 536,
      bounds: { top: 8, bottom: 712 },
    });
    expect(r).toEqual({ top: 500, maxHeight: 288 });
  });

  it('下方放不下、上方放得下：底边对齐行底向上展开', () => {
    const r = placeSubmenuVertically({
      ...ARGS,
      rowTop: 700,
      rowBottom: 736,
      bounds: { top: 8, bottom: 712 },
    });
    // top = 736 - 80 = 656（子菜单 656–736 全在界内）
    expect(r).toEqual({ top: 656, maxHeight: 288 });
  });

  it('两侧都不足且下方空间更大：贴行顶并限高到下方余量', () => {
    const r = placeSubmenuVertically({
      subH: 700,
      listCap: 288,
      boxPad: 8,
      rowTop: 20,
      rowBottom: 56,
      bounds: { top: 8, bottom: 712 },
    });
    // availBelow = 692 < 700 且 availAbove = 48 < 700，下方更大 → 限高 692 - 8 = 684
    expect(r).toEqual({ top: 20, maxHeight: 684 });
  });

  it('两侧都不足且上方空间更大：钳到上界并限高到上方余量', () => {
    const r = placeSubmenuVertically({
      subH: 300,
      listCap: 288,
      boxPad: 8,
      rowTop: 200,
      rowBottom: 236,
      bounds: { top: 8, bottom: 380 },
    });
    // availBelow = 180 < 300、availAbove = 228 < 300，上方更大 → 钳上界 8、
    // 限高 228 - 8 = 220
    expect(r).toEqual({ top: 8, maxHeight: 220 });
  });

  it('限高扣除后为负时归零（不产生负 maxHeight）', () => {
    const r = placeSubmenuVertically({
      ...ARGS,
      rowTop: 706,
      rowBottom: 712,
      bounds: { top: 704, bottom: 712 },
    });
    // availBelow = 6 < availAbove = 8，两者均 < boxPad 8 → 上方分支，限高 8 - 8 = 0
    expect(r).toEqual({ top: 704, maxHeight: 0 });
  });
});
