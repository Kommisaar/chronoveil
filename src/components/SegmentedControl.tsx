/**
 * 分段选择器（2026-09-14 复刻 qfluentwidgets SegmentedWidget，替换「标点微停」
 * 三态下拉）：灰底圆角轨道 + 等宽分段；选中段白底描边浮起，轨道底部一枚
 * 品牌色短指示条。移动动画走仓库共享的选中指示条语言 indicatorMotion.
 * moveIndicator（WAAPI 位移 + 中途纵向拉长，INDICATOR_MOVE_MS，可中断续走，
 * 减弱动态/初次定位直接就位）；段底色与文字随选中交叉淡化（no-preference
 * 门控补间）。语义取 radiogroup/radio（单选段），jsdom 无布局，滑动分支
 * 由浏览器实测验证（同 DropdownPushButton 复刻件口径）。
 */
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useLayoutEffect, useRef } from 'react';
import { moveIndicator } from './indicatorMotion';

/** 底部指示条宽（定位计算的单一事实源）。 */
const BAR_WIDTH_PX = 20;

const useStyles = makeStyles({
  track: {
    position: 'relative',
    display: 'flex',
    width: '100%',
    padding: '4px',
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  segment: {
    flex: '1',
    height: '32px',
    border: '1px solid transparent',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase300,
    cursor: 'pointer',
    // 段文案禁换行：等宽分段下长标签（如四字「跟随全局」）换行会撑破 32px 段高
    whiteSpace: 'nowrap',
    // 选中态切换的底/描边/前景交叉淡化收进 no-preference 媒体块（同
    // useCardLiftStyles 门控惯例）：减弱动态瞬时切换，只去补间不去反馈
    '@media (prefers-reduced-motion: no-preference)': {
      transitionProperty: 'background-color, border-color, color',
      transitionDuration: tokens.durationFast,
      transitionTimingFunction: tokens.curveEasyEase,
    },
  },
  // 未选中段的悬停/按压反馈（2026-09-15 用户定稿对齐 subtle 按钮语言：
  // hover 背景提亮一档、active 再深一档，原 hover 只提文字）。只挂未选
  // 中段——选中段的白底描边浮起不被 hover 冲掉
  segmentIdle: {
    ':hover': {
      color: tokens.colorNeutralForeground1,
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
    ':active': { backgroundColor: tokens.colorSubtleBackgroundPressed },
  },
  segmentSelected: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground1,
    boxShadow: tokens.shadow2,
  },
  bar: {
    position: 'absolute',
    bottom: '6px',
    left: '0px',
    width: `${BAR_WIDTH_PX}px`,
    height: '3px',
    borderRadius: '2px',
    backgroundColor: tokens.colorBrandForeground1,
    pointerEvents: 'none',
  },
});

export interface SegmentedOption {
  value: string;
  label: string;
}

export interface SegmentedControlProps {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  /** 可访问名（radiogroup 名）。 */
  ariaLabel: string;
  className?: string;
}

export function SegmentedControl(props: SegmentedControlProps) {
  const styles = useStyles();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLSpanElement | null>(null);

  // 指示条滑到选中段中心（段等宽，取段的 offsetLeft + 半段偏中）；options
  // 每次父渲染都是新数组身份，effect 每渲染重跑无害——moveIndicator 对同
  // 目标直接返回，不打断在飞的动画
  useLayoutEffect(() => {
    const track = trackRef.current;
    const bar = barRef.current;
    if (!track || !bar) return;
    const segments = track.querySelectorAll<HTMLElement>('[role="radio"]');
    const index = props.options.findIndex((o) => o.value === props.value);
    const seg = segments[index];
    if (!seg) return;
    moveIndicator(bar, { x: seg.offsetLeft + (seg.offsetWidth - BAR_WIDTH_PX) / 2, y: 0 });
  });

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={props.ariaLabel}
      className={mergeClasses(styles.track, props.className)}
    >
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          className={mergeClasses(
            styles.segment,
            o.value === props.value ? styles.segmentSelected : styles.segmentIdle,
          )}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
      <span ref={barRef} data-indicator-bar aria-hidden className={styles.bar} />
    </div>
  );
}
