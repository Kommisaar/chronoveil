/**
 * 静态 markdown-lite 渲染（ADR-011「引擎直插 DOM」的同步路径）：整段文本
 * 一次解析、同步上屏——无队列、无动画、无光标，供角色编辑器的人设预览等
 * 非流式场景复用与流式完全相同的语法语义（StreamParser：未闭合标记按字面
 * 吐出、空行分段、场景线）。
 *
 * 产出 DOM 与流式渲染同构（.para / span.tok[.action][.bold] / hr.scene），
 * 样式沿用 engine.css；容器不带 data-anim，token 无出场动画直接可见。
 * 同样式连续字符合并进单个 span：静态场景无需逐字单元，长文本不膨胀节点数。
 */
import { StreamParser } from './parser';
import { ParagraphStream } from './seal';
import { isHr, isItem, isPara } from './queue';

export function renderStaticMarkdown(root: HTMLElement, text: string): void {
  root.textContent = '';
  if (!text) return;
  const sealer = new ParagraphStream(root);
  const parser = new StreamParser();
  const units = [...parser.push(text), ...parser.flush()];

  let span: HTMLSpanElement | null = null;
  let spanA = false;
  let spanB = false;
  let buf = '';
  const flushSpan = (): void => {
    if (span) span.textContent = buf;
    span = null;
    buf = '';
  };

  for (const u of units) {
    if (isItem(u)) {
      flushSpan();
      sealer.seal();
      sealer.tail(u.ordered ? 'oli' : 'uli');
      continue;
    }
    if (isPara(u) || isHr(u)) {
      flushSpan();
      if (isPara(u)) sealer.seal();
      else sealer.sceneLine();
      continue;
    }
    const parent = sealer.tail();
    if (!span || spanA !== u.a || spanB !== u.b || span.parentElement !== parent) {
      flushSpan();
      span = document.createElement('span');
      span.className = 'tok' + (u.a ? ' action' : '') + (u.b ? ' bold' : '');
      spanA = u.a;
      spanB = u.b;
      parent.appendChild(span);
    }
    buf += u.t;
  }
  flushSpan();
  sealer.reset();
}
