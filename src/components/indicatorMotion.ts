// 选中指示条共享动效（风格移植自 relay-harbor）：单个共享指示条在切换
// 目标时从当前视觉位置位移到新条目，中途纵向拉长再收短（WAAPI 关键帧
// ——transition 做不了中途形变）。tokens 运行时值是 var(--…) 引用，
// WAAPI 需要具体数值，按 @fluentui/tokens 定义取字面量（主题调整需同步）。
export const INDICATOR_DURATION = 400; // durationSlower：位移动画行程长、带形变，慢于面板宽度动画
export const INDICATOR_EASING = 'cubic-bezier(0, 0, 0, 1)'; // curveDecelerateMid：统一减速曲线
export const INDICATOR_STRETCH = 1.75;

/** 读取指示条当前 translate 位移；未定位过（无 transform）返回 null。
    取 getComputedStyle 矩阵——动画运行中亦反映实时值，便于中断续走 */
function readTranslate(indicator: HTMLElement): { x: number; y: number } | null {
  const m = getComputedStyle(indicator).transform.match(/matrix.*\((.+)\)/);
  if (!m) return null;
  const parts = m[1]?.split(',').map(Number) ?? [];
  // matrix(a,b,c,d,tx,ty)
  const tx = parts[4];
  const ty = parts[5];
  return parts.length >= 6 && tx !== undefined && ty !== undefined ? { x: tx, y: ty } : null;
}

/** 把指示条移到目标位移（相对定位原点的 translate 像素）：初次定位
    （无当前位置）或系统开启「减弱动态效果」时直接就位 */
export function moveIndicator(indicator: HTMLElement, target: { x: number; y: number }): void {
  const current = readTranslate(indicator);
  indicator.style.transform = `translate(${target.x}px, ${target.y}px)`;
  if (!current || (current.x === target.x && current.y === target.y)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  indicator.animate(
    [
      { transform: `translate(${current.x}px, ${current.y}px) scaleY(1)` },
      {
        transform: `translate(${(current.x + target.x) / 2}px, ${(current.y + target.y) / 2}px) scaleY(${INDICATOR_STRETCH})`,
      },
      { transform: `translate(${target.x}px, ${target.y}px) scaleY(1)` },
    ],
    { duration: INDICATOR_DURATION, easing: INDICATOR_EASING },
  );
}
