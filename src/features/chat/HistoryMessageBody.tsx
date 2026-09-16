/**
 * 历史 assistant 行正文（审计问题 1 接线）：引擎 renderStaticMarkdown 直插 DOM
 * （ADR-011 静态路径，无动画），与流式期完全同语法语义——动作斜体/加粗/
 * 场景线/列表在收尾重拉后不再回退成字面星号。引擎容器内 DOM 不归 React 管
 * （同角色编辑器 PersonaPreviewBox 招式）：正文变化整容器重渲染，不得把 React
 * 子节点放进同一容器（reconcile 会打架）。user 行不走此路径：markdown-lite 是
 * assistant 叙事语法，user 按原文直显。
 */
import { useLayoutEffect, useRef } from 'react';
import { renderStaticMarkdown } from '../../engine';
import { useMessageCardStyles } from './useMessageCardStyles';

export function HistoryMessageBody({ content }: { content: string }) {
  const styles = useMessageCardStyles();
  const ref = useRef<HTMLDivElement | null>(null);
  // useLayoutEffect（Task-16 遗留项）：绘制前同步直插引擎 DOM，消历史行首帧空白
  useLayoutEffect(() => {
    if (ref.current) renderStaticMarkdown(ref.current, content);
  }, [content]);
  // 布局类沿用消息卡正文（字号/行距/pre-wrap/断词）：引擎 .para 继承容器的
  // pre-wrap 与断词，与流式行排版一致
  return <div ref={ref} className={styles.body} />;
}
