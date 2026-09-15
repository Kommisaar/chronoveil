/**
 * 编辑器对话框 surface 的共享元素进出场形变（FLIP）。
 *
 * 搬移说明：自 src/features/characters/editor/ 逐字搬至 components 跨
 * feature 复用层（features 禁互引），世界卡编辑器将复用，文件同名。
 *
 * 面板本体走 FLIP 行内变换——挂载时把面板钉到触发卡片的矩形
 * （translate+scale），再过渡回位；退场反向缩回卡片。进场形变用弹簧曲线
 * SPRING_CURVE（与卡片入场/悬停同一「弹簧语言」，会过冲一点点再落定），
 * 退场保持减速安静。矩形由父级 getTriggerRect 现测（查不到，如软删后的
 * 卡片，退化为纯淡出）；动态值进不了 Griffel keyframes，所以面板形变是
 * useLayoutEffect 内的行内 style，keyframes 只管背板淡化与 body 内容交叉
 * 淡化（那部分留在对话框组件里）。
 *
 * 动画契约：open=false 表示「退场中」——宿主组件留在挂载树播完出场动画，
 * 计时到点回调 onClosed，父级才真正卸载；因此关闭永远有退场，无论哪条
 * 路径发起。
 */
import { useLayoutEffect, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import {
  ACCELERATE_CURVE,
  MORPH_OUT_MS,
  POP_IN_MS,
  SPRING_CURVE,
} from './motion';

/** 卸载计时 = 退场形变（MORPH_OUT_MS）+ 冲刷余量，到点通知父级卸载。 */
const EXIT_MS = MORPH_OUT_MS + 10;

const morphable = (): boolean =>
  !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export interface SurfaceMorph {
  /** 钉在承载背景/圆角/边框的 surface 盒子上（Fluent 插槽 ref 运行时
      转发的就是它；形变落在外壳上才会「从卡片长出」而非原地淡入）。 */
  surfaceRef: RefObject<HTMLDivElement | null>;
}

export function useSurfaceMorph(props: {
  /** 可见性：false 时播退场形变，EXIT_MS 到点回调 onClosed。 */
  open: boolean;
  /** 退场动画播完（EXIT_MS）后回调；父级据此真正卸载宿主组件。 */
  onClosed: () => void;
  /** 共享元素过渡的触发元素矩形（卡片 / 新建按钮），打开与关闭时现测；
      返回 null（元素已不在，如软删后）则退化为纯淡入淡出。 */
  getTriggerRect?: (() => DOMRect | null) | undefined;
}): SurfaceMorph {
  const { open, onClosed, getTriggerRect } = props;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const getTriggerRectRef = useRef(getTriggerRect);
  getTriggerRectRef.current = getTriggerRect;

  /** FLIP 起点：把面板钉到触发元素矩形再过渡回原位。用「改起点 →
      offsetWidth 冲刷提交 → 改终点」的同步节奏触发 transition，不依赖
      rAF（后台/遮挡标签页 rAF 会被节流，transition 在合成器照常推进）；
      透明度交给 surface 的 keyframes，这里只动 transform。 */
  const runEnter = () => {
    const el = surfaceRef.current;
    if (!el || !morphable()) return;
    el.style.transition = 'none';
    el.style.transform = 'none';
    void el.offsetWidth; // 冲刷①：提交重置态，排除残留 transform 的测量污染
    const rect = el.getBoundingClientRect();
    const tr = getTriggerRectRef.current?.() ?? null;
    if (!tr || rect.width <= 0 || rect.height <= 0) return;
    const dx = tr.left + tr.width / 2 - (rect.left + rect.width / 2);
    const dy = tr.top + tr.height / 2 - (rect.top + rect.height / 2);
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${tr.width / rect.width}, ${tr.height / rect.height})`;
    void el.offsetWidth; // 冲刷②：提交钉住态作为过渡起点
    el.style.transition = `transform ${POP_IN_MS}ms ${SPRING_CURVE}`;
    el.style.transform = 'none';
  };

  useLayoutEffect(runEnter, []);

  // 退场：反向 FLIP 缩回触发元素（surface 同时 keyframes 淡出），EXIT_MS
  // 到点通知父级卸载。cleanup 恢复进场起点——退场中途重开同一目标时复播。
  useEffect(() => {
    if (open) return;
    const el = surfaceRef.current;
    if (el && morphable()) {
      const rect = el.getBoundingClientRect();
      const tr = getTriggerRectRef.current?.() ?? null;
      if (tr && rect.width > 0 && rect.height > 0) {
        const dx = tr.left + tr.width / 2 - (rect.left + rect.width / 2);
        const dy = tr.top + tr.height / 2 - (rect.top + rect.height / 2);
        el.style.transition = `transform ${MORPH_OUT_MS}ms ${ACCELERATE_CURVE}`;
        void el.offsetWidth; // 冲刷：确保新 transition 从当前态起步
        el.style.transform = `translate(${dx}px, ${dy}px) scale(${tr.width / rect.width}, ${tr.height / rect.height})`;
      }
    }
    const timer = window.setTimeout(() => onClosedRef.current(), EXIT_MS);
    return () => {
      window.clearTimeout(timer);
      runEnter();
    };
  }, [open]);

  return { surfaceRef };
}
