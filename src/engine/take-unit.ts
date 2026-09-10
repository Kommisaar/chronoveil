/**
 * 发射粒度合并（FR-002，demo takeUnit 搬家，TASK-004）：
 * 结构单元（{para}/{hr}/{item}）原子出队、不可拆分；
 * 文本单元把队首起相同 a/b 标记的相邻字符合并到粒度 n（1/2/4）后整体出队。
 */
import { isHr, isItem, isPara, isText, StreamUnit, TextUnit, UnitQueue } from './queue';

export type Granularity = 1 | 2 | 4;

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
  const unit: TextUnit = { t: text, a, b };
  return unit;
}
