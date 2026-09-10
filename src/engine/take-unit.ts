/**
 * 发射粒度合并（FR-002，demo takeUnit 搬家，TASK-004）：
 * 结构单元（{para}/{hr}/{item}）原子出队、不可拆分；
 * 文本单元把队首起相同 a/b 标记的相邻字符合并到粒度 n（1/2/4）后整体出队。
 * 2026-09-10 审计发现 7（demo splitChunks L384 对齐）：合并窗口不拆断
 * [A-Za-z0-9] 连续段——边界落在拉丁词中间时把整词并入当前单元（单元可长于
 * 粒度 n），词与词之间仍按粒度合并；样式（a/b）变化处仍断块。
 */
import { isHr, isItem, isPara, isText, StreamUnit, TextUnit, UnitQueue } from './queue';

export type Granularity = 1 | 2 | 4;

/** 拉丁词连续段字符（demo 的非 CJK 非空白整块出场规则收窄到字母数字） */
const WORD_CHAR_RE = /[A-Za-z0-9]/;

export function takeUnit(queue: UnitQueue, granularity: Granularity): StreamUnit | undefined {
  const head = queue.peek();
  if (!head) return undefined;
  if (isPara(head) || isHr(head) || isItem(head)) return queue.dequeue();

  const a = head.a;
  const b = head.b;
  let text = '';
  while (text.length < granularity) {
    const next = queue.peek();
    if (!next || !isText(next) || next.a !== a || next.b !== b) break;
    text += next.t;
    queue.dequeue();
  }
  // 词完整性：合并边界落在 [A-Za-z0-9] 连续段中间（块尾与队首都是词字符）
  // 时继续吞入，直到词尾（样式变化 / 队列尽头照常断块）
  for (;;) {
    const next = queue.peek();
    if (!next || !isText(next) || next.a !== a || next.b !== b) break;
    const last = text.charAt(text.length - 1);
    if (!WORD_CHAR_RE.test(last) || !WORD_CHAR_RE.test(next.t.charAt(0))) break;
    text += next.t;
    queue.dequeue();
  }
  const unit: TextUnit = { t: text, a, b };
  return unit;
}
