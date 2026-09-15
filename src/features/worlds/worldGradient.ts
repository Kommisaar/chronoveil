// 世界渐变调色板（世界页档案卡的世界色源）：深色低饱和的「地志」调
//（青绿赭域），与角色海报的靛紫系拉开域别——世界是「地方」，不抢角色
// 的紫红蓝。同世界恒同色（按 id 取模），跨处配色漂移不可接受（同角色页
// posterGradient 规则）。
const WORLD_GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ['#0e3a42', '#1f6d6f'], // 深青海
  ['#20304f', '#46609a'], // 雾靛
  ['#43301d', '#7c5a33'], // 赭土
  ['#1d3a24', '#467a4e'], // 林壑
  ['#33302a', '#6b6252'], // 岩原
  ['#3b2742', '#6f4a7e'], // 暮霭
];

/** 每世界恒定色对（按 id 取模）。 */
function worldPairOf(id: number): readonly [string, string] {
  return WORLD_GRADIENTS[Math.abs(id) % WORLD_GRADIENTS.length] ?? ['#0e3a42', '#1f6d6f'];
}

/** 每世界恒定渐变：档案卡顶部色带与历法色点共用（色点取 id+1 错位色）。 */
export function worldGradientOf(id: number): string {
  const [from, to] = worldPairOf(id);
  return `linear-gradient(150deg, ${from} 0%, ${to} 100%)`;
}
