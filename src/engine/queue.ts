/**
 * 单元队列（CMP-001 / FR-002）：生产者只管入队，消费侧按信用节拍取出。
 * 四种单元：{t,a,b} 文本字符（t 为单字符，合并交给 take-unit）、{para} 段落封存、
 * {hr} 场景线、{item} 列表项（2026-09-10 扩展）；结构单元在队列中原子流动。
 * 从 docs/streaming-animations.html 搬家（TASK-004）。
 */

/** 文本单元：t 为单个字符；a=斜体/动作（`*…*`），b=加粗（`**…**`） */
export interface TextUnit {
  t: string;
  a: boolean;
  b: boolean;
}

/** 段落封存单元（原子） */
export interface ParaUnit {
  para: true;
}

/** 场景线单元（原子） */
export interface HrUnit {
  hr: true;
}

/** 列表项单元（原子，2026-09-10 语法扩展）：开启一个列表项段落。
    ordered=false 无序（渲染方补 `• ` 项目符文本）；true 有序（序号是
    正文文本的一部分，由解析器按原文吐出，不做重排）。 */
export interface ItemUnit {
  item: true;
  ordered: boolean;
}

export type StreamUnit = TextUnit | ParaUnit | HrUnit | ItemUnit;

export function textUnit(t: string, a = false, b = false): TextUnit {
  return { t, a, b };
}

export const isText = (u: StreamUnit): u is TextUnit => 't' in u;
export const isPara = (u: StreamUnit): u is ParaUnit => 'para' in u;
export const isHr = (u: StreamUnit): u is HrUnit => 'hr' in u;
export const isItem = (u: StreamUnit): u is ItemUnit => 'item' in u;

/** 字符级 FIFO 队列：enqueue 只在生产者侧调用，dequeue/peek 只在消费者侧调用 */
export class UnitQueue {
  private items: StreamUnit[] = [];

  enqueue(unit: StreamUnit | StreamUnit[]): void {
    if (Array.isArray(unit)) this.items.push(...unit);
    else this.items.push(unit);
  }

  dequeue(): StreamUnit | undefined {
    return this.items.shift();
  }

  peek(): StreamUnit | undefined {
    return this.items[0];
  }

  get length(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }
}
