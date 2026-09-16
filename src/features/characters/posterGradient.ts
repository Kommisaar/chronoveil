// 海报渐变调色板（角色页典藏卡图框与编辑器迷你预览共用）：深色低饱和、
// 呼应应用图标的靛紫系，扩展邻近色共 6 组。
export const POSTER_GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ['#332a6e', '#6b46b8'], // 靛紫
  ['#1e3a66', '#3f6ab3'], // 暮蓝
  ['#5e2347', '#a04580'], // 玫紫
  ['#1d4a41', '#3c8170'], // 松石
  ['#5a3f1c', '#9a7a3f'], // 琥珀
  ['#57231f', '#a04a3c'], // 绯红
];

/** 每角色恒定渐变色对（按 id 取模），同人不同处配色漂移不可接受。 */
export function gradientPairOf(id: number): readonly [string, string] {
  return (
    POSTER_GRADIENTS[Math.abs(id) % POSTER_GRADIENTS.length] ??
    (['#332a6e', '#6b46b8'] as const)
  );
}

export function gradientOf(id: number): string {
  const [from, to] = gradientPairOf(id);
  return `linear-gradient(150deg, ${from} 0%, ${to} 100%)`;
}

/** #RRGGBB → [r, g, b]；accent_color 列无库级格式约束，非法输入返回 null。 */
function parseHex(hex: string): readonly [number, number, number] | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const value = hex.slice(1);
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/** 有效性收口：非法 accent 串一律按未设置处理（跟随海报）。 */
function validAccent(accentColor: string | null): string | null {
  return accentColor !== null && parseHex(accentColor) !== null ? accentColor : null;
}

/**
 * 每角色最终海报渐变（海报墙卡片与编辑器海报共用）：显式强调色**原色直出**
 * （2026-09-09 用户定稿：色板里选的颜色应显示原始颜色，不再程序化压暗）；
 * 未设置 / 非法则按 id 取模定色（手调色对本身即深色调性）。
 */
export function posterGradientOf(character: { id: number; accentColor: string | null }): string {
  const accent = validAccent(character.accentColor);
  if (accent !== null) {
    return `linear-gradient(150deg, ${accent} 0%, ${accent} 100%)`;
  }
  return gradientOf(character.id);
}

/** 卡片元信息小圆点：跟随强调色时原色直出，否则沿用隔壁色对（id + 1）。 */
export function dotGradientOf(character: { id: number; accentColor: string | null }): string {
  const accent = validAccent(character.accentColor);
  if (accent !== null) {
    return `linear-gradient(150deg, ${accent} 0%, ${accent} 100%)`;
  }
  return gradientOf(character.id + 1);
}

/**
 * 强调色（编辑器右栏渐变背景等界面着色）：角色显式配置优先；
 * 未配置（null）取海报渐变亮端（第二色）作派生默认——旧行零回填即有色。
 */
export function accentColorOf(character: { id: number; accentColor: string | null }): string {
  return validAccent(character.accentColor) ?? gradientPairOf(character.id)[1];
}
