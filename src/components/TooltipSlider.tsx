/**
 * 带值气泡的滑动条（2026-09-14 用户定稿：自绘实现，弃用 Fluent Slider——
 * 其轨/填充画在内部背景图里、外部换肤不可控）。结构：4px 圆轨（品牌色实填
 * 到拇指、余段中性灰）+ 16px 白环旋钮（KNOB_SIZE_PX）内嵌
 * 8px 中心着色点（DOT_SIZE_PX，hover 放大至 10）+ 悬停 / 聚焦时拇指上方
 * 浮出的值气泡；视觉之下是一枚透明原生 range input，承担拖
 * 动、方向键与读屏（标准自绘滑杆手法，Fluent 同款）。
 *
 * 强调色走 Fluent 品牌 token（colorBrandForeground1），白环 / 灰轨 / 气泡底
 * 全部主题 token，暗色自适应。几何口径单一事实源 KNOB_SIZE_PX：拇指行程 =
 * 宽度 − 拇指径，圆心再内缩半径；填充止点 --cv-fill 与气泡 left 同式。
 */
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

/** 旋钮（白色外圈）直径：行程 / 填充止点几何共用（跨处互指的单一事实源）。
 *  着色点直径只影响视觉；hover 放大只发生在着色点上（2026-09-14 用户定稿：
 *  外圈白圆与描边不变，仅中心着色区变化）。 */
const KNOB_SIZE_PX = 16;
const DOT_SIZE_PX = 8;
const DOT_HOVER_PX = 10;

const useStyles = makeStyles({
  root: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    height: '20px',
    minWidth: '0px',
    // 气泡显隐 = 悬停 或 拖动中。刻意不看 :focus-within：点击后原生 input
    // 长期持焦，气泡会常驻不散（2026-09-14 用户反馈）；键盘值回显靠行内
    // 数值文本，不靠气泡
    '&:hover > span': {
      opacity: '1',
    },
  },
  // 拖动中强制显（指针拖出条外时 :hover 已断，需 JS 状态接管）
  dragging: {
    '& > span': {
      opacity: '1',
    },
  },
  track: {
    position: 'absolute',
    left: '0px',
    right: '0px',
    top: '50%',
    marginTop: '-2px',
    height: '4px',
    borderRadius: '2px',
    // 连续渐变实填到拇指圆心（--cv-fill 由包裹层按当前值写入）
    backgroundImage:
      `linear-gradient(to right, ${tokens.colorBrandForeground1} 0px, ` +
      `${tokens.colorBrandForeground1} var(--cv-fill), ` +
      `${tokens.colorNeutralStroke2} var(--cv-fill))`,
  },
  // 旋钮：固定尺寸的白圆 + 细描边 + 落影（尺寸不随 hover 变）
  thumb: {
    position: 'absolute',
    top: '50%',
    width: `${KNOB_SIZE_PX}px`,
    height: `${KNOB_SIZE_PX}px`,
    transform: 'translate(-50%, -50%)',
    borderRadius: '50%',
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: `0 0 0 1px ${tokens.colorNeutralStroke1}, 0 2px 4px rgba(0, 0, 0, 0.15)`,
    pointerEvents: 'none',
  },
  // 中心着色点：唯一的尺寸动画载体（默认小 → hover 大 → 拖动回落小）
  dot: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    width: `${DOT_SIZE_PX}px`,
    height: `${DOT_SIZE_PX}px`,
    borderRadius: '50%',
    backgroundColor: tokens.colorBrandForeground1,
    transitionProperty: 'width, height',
    transitionDuration: tokens.durationFast,
    transitionTimingFunction: tokens.curveEasyEase,
  },
  // hover 态放大着色点（拖动中由 JS 不挂此态 → 回落基准）
  dotLg: {
    width: `${DOT_HOVER_PX}px`,
    height: `${DOT_HOVER_PX}px`,
  },
  input: {
    position: 'absolute',
    left: '0px',
    top: '0px',
    width: '100%',
    height: '100%',
    opacity: '0',
    margin: '0px',
    cursor: 'pointer',
  },
  tip: {
    position: 'absolute',
    bottom: '24px',
    transform: 'translateX(-50%)',
    padding: '3px 10px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow8,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    opacity: '0',
    zIndex: '1',
  },
});

export interface TooltipSliderProps {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  /** 可访问名（原生 range input 的 aria-label）。 */
  ariaLabel: string;
  className?: string;
  /** 气泡文案格式化；缺省直接显数值。 */
  formatValue?: (value: number) => string;
}

export function TooltipSlider(props: TooltipSliderProps) {
  const styles = useStyles();
  const {
    min,
    max,
    step,
    value,
    onChange,
    ariaLabel,
    className,
    formatValue,
  } = props;
  // 拖动中标记：pointerdown 起挂 window pointerup（mouseup 可能落在条外，
  // 事件不冒泡回 input），到点即收拖动态
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const up = (): void => setDragging(false);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragging]);
  // hover 态由 JS 接（拇指 pointer-events none，:hover 不触发；尺寸三段 =
  // 默认小 / hover 大 / 拖动回落小，与气泡显隐互不干扰）
  const [hovered, setHovered] = useState(false);
  // 拇指圆心横向位置（行程内插 + 半径内缩，按旋钮径算）；填充止点与气泡
  // left 同式复用
  const pct = max > min ? (value - min) / (max - min) : 0;
  const center = `calc(${pct} * (100% - ${KNOB_SIZE_PX}px) + ${KNOB_SIZE_PX / 2}px)`;
  return (
    <div
      className={mergeClasses(styles.root, dragging && styles.dragging, className)}
      style={{ '--cv-fill': center } as CSSProperties}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={styles.track} />
      <div className={styles.thumb} style={{ left: center }}>
        <div
          className={mergeClasses(styles.dot, hovered && !dragging && styles.dotLg)}
        />
      </div>
      {/* 透明原生 input：拖动 / 方向键 / 读屏的全部交互由它承担 */}
      <input
        className={styles.input}
        type="range"
        min={min}
        max={max}
        step={step ?? 1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerDown={() => setDragging(true)}
        aria-label={ariaLabel}
      />
      {/* 对读屏隐藏：值已由 input 的 aria-valuenow 表达，气泡纯属视觉冗余 */}
      <span data-tip aria-hidden className={styles.tip} style={{ left: center }}>
        {formatValue ? formatValue(value) : value}
      </span>
    </div>
  );
}
