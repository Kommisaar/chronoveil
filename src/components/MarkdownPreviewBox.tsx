/**
 * markdown 静态预览盒（2026-09-15 自角色编辑器 pieces.tsx 的 PersonaPreviewBox
 * 下沉 components——设置页全局系统提示词预览成为第二用例）：引擎
 * renderStaticMarkdown 直插 DOM（与聊天同语法语义），文本变化即整容器重渲染。
 * 展示态无边框底色（2026-09-10 用户定稿，随组件搬移），空文本由兄弟节点出
 * 占位提示（showHint=false 供编辑态复用——textarea 已有 placeholder，不重复出
 * 提示）；空态文案由调用方传入（各 feature 的 i18n 域自理）。
 * 引擎容器内的 DOM 不归 React 管，子节点放同一容器会在 reconcile 时打架
 * （与 PreviewBox 同一招）。
 */
import { Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { renderStaticMarkdown } from '../engine';

const useStyles = makeStyles({
  wrap: {
    position: 'relative',
  },
  // 展示态：无边框无底色，markdown 直接落在面板上，与聊天叙事流同观感；
  // 高度随内容自然生长（编辑态 textarea 变高）
  plain: {
    fontSize: tokens.fontSizeBase300,
    lineHeight: '1.8',
    wordBreak: 'break-word',
  },
  // 空文本：给提示文案撑住一块可点击的视觉空间，非空时不占位
  empty: {
    minHeight: '72px',
  },
  // 主题适配：引擎的加粗米白是聊天暗色调硬编码，预览容器内用主题 token 覆写
  // 保证亮色主题可读（动作蓝灰斜体双主题均可读，不动）
  markdown: {
    '& .tok.bold': { color: tokens.colorNeutralForeground1 },
  },
  // 空态提示：左上对齐更像输入占位符
  hint: {
    position: 'absolute',
    top: '0px',
    left: '0px',
    pointerEvents: 'none',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

export function MarkdownPreviewBox(props: { text: string; hint: string; showHint?: boolean }) {
  const { hint, showHint = true } = props;
  const styles = useStyles();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) renderStaticMarkdown(ref.current, props.text);
  }, [props.text]);
  const empty = props.text.trim() === '';
  return (
    <div className={styles.wrap}>
      <div
        ref={ref}
        data-markdown-preview
        className={mergeClasses(
          styles.plain,
          empty && styles.empty,
          styles.markdown,
        )}
        // 场景线挖空底按所在表面行内注入：本组件两个落点（编辑器 DialogSurface /
        // 设置卡）均为 bg1 表面，故静态注入 bg1（engine.css :root 注释）；落到
        // bg2 表面时需调用侧行内覆写。as 断言理由：变量名不在 React
        // CSSProperties 类型内（对齐聊天侧 engineThemeVars 写法）
        style={{ '--cv-scene-line-bg': tokens.colorNeutralBackground1 } as CSSProperties}
      />
      {empty && showHint ? <Text className={styles.hint}>{hint}</Text> : null}
    </div>
  );
}
