// 视口内触发的入场 stagger（方案 2 标准做法，替代全局索引 stagger +
// 封顶）：首屏元素手动判交立即揭示（getBoundingClientRect 不依赖渲
// 染帧钟，帧钟停摆的嵌入预览也能出首屏），折叠线以下的元素由
// IntersectionObserver 接管、滚入视口才播；同批揭示的元素按 60ms 步
// 进给批内小错峰。resetKey 变化（卡片形态 / 入场形态切换导致网格重
// 挂）时重置揭示状态以重播；仅列表增删（如保存新角色）不重置，只有
// 新元素才播。无 IntersectionObserver 的环境（jsdom / SSR）全部立即
// 揭示。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** 批内错峰步长：同批滚入的元素逐个 +60ms（首屏约 10 张 → 0~540ms）。 */
const BATCH_STEP_MS = 60;

/** 触发阈值：元素露出 15% 即开始入场。 */
const THRESHOLD = 0.15;

/** 手动判交：元素与视口相交（IO 之外的初筛，不依赖渲染帧钟）。 */
function inViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  return (
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0
  );
}

export interface RevealOnScroll {
  /** 序号 → 批内延迟 ms；未揭示（尚未滚入视口）的序号缺省。 */
  reveal: Record<number, number>;
  /** callback ref 工厂：observe(index) 挂到对应元素上完成登记。 */
  register: (index: number) => (el: Element | null) => void;
}

/**
 * 视口内触发入场；用法见文件头注释。
 */
export function useRevealOnScroll(count: number, resetKey: string): RevealOnScroll {
  const [reveal, setReveal] = useState<Record<number, number>>({});
  const elementsRef = useRef<Array<Element | null>>([]);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const observedRef = useRef<WeakSet<Element>>(new WeakSet());
  const revealedRef = useRef<WeakSet<Element>>(new WeakSet());
  const prevKeyRef = useRef<string | null>(null);

  // callback ref：只登记元素；观察统一由下方 layout effect 管理——它先于
  // 任何 IO 回调同步执行，避免「先观察、后重置」把初始批次冲掉。
  // 回调按 index 记忆化保持引用稳定：inline 新函数会让 React 先以 null
  // 调旧回调触发 unobserve，而 layout effect 不重跑，元素就此失察。
  const registerFnsRef = useRef<Array<(el: Element | null) => void>>([]);
  const register = useCallback((index: number) => {
    registerFnsRef.current[index] ??= (el: Element | null) => {
      const prev = elementsRef.current[index];
      if (prev && prev !== el) {
        observerRef.current?.unobserve(prev);
        observedRef.current.delete(prev);
      }
      elementsRef.current[index] = el;
    };
    return registerFnsRef.current[index];
  }, []);

  // 同批揭示：按传入序号顺序赋 60ms 步进延迟。
  const assignBatch = useCallback((indices: number[]) => {
    if (indices.length === 0) return;
    setReveal((prev) => {
      const next = { ...prev };
      for (const [i, idx] of indices.entries()) {
        if (next[idx] === undefined) next[idx] = i * BATCH_STEP_MS;
      }
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    const gridChanged = prevKeyRef.current !== resetKey;
    prevKeyRef.current = resetKey;

    if (typeof IntersectionObserver === 'undefined') {
      setReveal(Object.fromEntries(Array.from({ length: count }, (_, i) => [i, 0])));
      return;
    }
    if (gridChanged) {
      setReveal({});
      observedRef.current = new WeakSet();
      revealedRef.current = new WeakSet();
    }
    observerRef.current ??= new IntersectionObserver(
      (entries) => {
        const batch = entries.filter(
          (e) => e.isIntersecting && !revealedRef.current.has(e.target),
        );
        if (batch.length === 0) return;
        const indices = [];
        for (const entry of batch) {
          revealedRef.current.add(entry.target);
          const idx = elementsRef.current.indexOf(entry.target);
          if (idx !== -1) indices.push(idx);
        }
        assignBatch(indices);
      },
      { threshold: THRESHOLD },
    );

    // 首屏手动判交（标准健壮化）：getBoundingClientRect 不依赖渲染帧
    // 钟，嵌入预览等帧钟停摆的环境也能揭示首屏；IO 只接管之后滚入的
    // 元素（滚动必然伴随真实渲染）。
    const immediate: number[] = [];
    for (const [index, el] of elementsRef.current.entries()) {
      if (!el || observedRef.current.has(el)) continue;
      observedRef.current.add(el);
      if (inViewport(el)) immediate.push(index);
      else observerRef.current.observe(el);
    }
    assignBatch(immediate);
  }, [count, resetKey, assignBatch]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { reveal, register };
}
