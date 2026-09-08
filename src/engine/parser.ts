/**
 * markdown-lite 流式解析（FR-004 / ADR-008，TASK-004）。
 * 支持子集：`*斜体*`（动作）、`**加粗**`、空行分段、`---`/`===`/`——` 场景线；
 * 刻意不支持表格/链接/图片（半语法状态必然错乱、外链违背本地化铁律）。
 *
 * 未闭合标记 = 延迟判定（ADR-008，2026-09-07 决策，替代 demo 的完整文本预解析）：
 * 遇 `*`/`**` 先不吐字（尾巴攒着），直到能判定——闭合出现则按样式渲染出队；
 * 段落封存 / 流结束仍未闭合则按字面星号吐出。与 `<think>` 半标签跨包同一哲学。
 *
 * 产出为字符级单元流（{t,a,b} + {para}/{hr}），合并成发射粒度是 take-unit 的事。
 */
import { StreamUnit, textUnit } from './queue';

/** 场景线整块判定（demo tokenize：/^\s*(-{3,}|={3,}|—{2,})\s*$/） */
const SCENE_LINE_RE = /^\s*(-{3,}|={3,}|—{2,})\s*$/;
/** 场景线候选字符集：空白与三种划线（块首只有这些字符时才可能成为场景线） */
const SCENE_LINE_CHARS_RE = /[-=—\s]/;

type ParserMode = 'none' | 'stars' | 'content' | 'divider';

/**
 * 流式 markdown-lite 解析器。
 * push() 喂到达文本、返回当前可出队的单元；sealParagraph() 在段落边界调用；
 * flush() 在流结束时调用（把攒住的尾巴按字面吐出）。
 */
export class StreamParser {
  /** stars：星标候选；content：开标记星串；divider：场景线候选块首 */
  private mode: ParserMode = 'none';
  private hold = '';
  /** content 模式已攒的正文（闭合后按样式出队，封存时按字面出队） */
  private content = '';
  /** content 模式结尾攒到的闭合星数（`**` 需连见 2 颗） */
  private closerStars = 0;
  /** 连续换行计数：≥2 即段落边界（demo split(/\n{2,}/)） */
  private nlRun = 0;
  /** 当前块是否已有实质内容（场景线候选只在块首成立） */
  private blockHasContent = false;

  /** 喂入到达的文本片段（网络包粒度任意），返回可立即出队的单元 */
  push(text: string): StreamUnit[] {
    const out: StreamUnit[] = [];
    for (const ch of text) {
      if (ch === '\n') {
        this.nlRun++;
        continue;
      }
      if (this.nlRun >= 2) {
        out.push(...this.sealParagraph());
      } else if (this.nlRun === 1) {
        // 单个换行是块内普通字符（demo：split(/\n{2,}/) 只切空行）
        this.feedChar('\n', out);
      }
      this.nlRun = 0;
      this.feedChar(ch, out);
    }
    return out;
  }

  /**
   * 段落封存（空行边界）：攒住的尾巴按字面吐出（ADR-008 字面星号路），
   * 然后出队边界单元；若封存的块是纯场景线，先出 {hr} 再出 {para}
   * （与 demo tokenize 的单元序一致：分隔线块 → para 后紧跟 hr）。
   */
  sealParagraph(): StreamUnit[] {
    const out: StreamUnit[] = [];
    let sceneLine = false;
    if (this.mode === 'divider') {
      if (SCENE_LINE_RE.test(this.hold)) sceneLine = true;
      else out.push(...literalUnits(this.hold));
    } else if (this.mode !== 'none') {
      // 未闭合标记走到段落封存：按字面星号吐出（含开标记星与正文）
      out.push(...literalUnits(this.hold + this.content + '*'.repeat(this.closerStars)));
    }
    this.clearMarker();
    this.blockHasContent = false;
    if (sceneLine) out.push({ hr: true });
    out.push({ para: true });
    return out;
  }

  /** 流结束（finish）：封存未决边界，并把最后攒住的尾巴按字面吐出 */
  flush(): StreamUnit[] {
    const out: StreamUnit[] = [];
    if (this.nlRun >= 2) {
      out.push(...this.sealParagraph());
      this.nlRun = 0;
      return out;
    }
    if (this.nlRun === 1) this.feedChar('\n', out);
    this.nlRun = 0;
    if (this.mode === 'divider') {
      // 流末的纯场景线块：只出 {hr}，不再补 {para}（demo 末块行为）
      if (SCENE_LINE_RE.test(this.hold)) out.push({ hr: true });
      else out.push(...literalUnits(this.hold));
    } else if (this.mode !== 'none') {
      out.push(...literalUnits(this.hold + this.content + '*'.repeat(this.closerStars)));
    }
    this.clearMarker();
    this.blockHasContent = false;
    return out;
  }

  reset(): void {
    this.clearMarker();
    this.nlRun = 0;
    this.blockHasContent = false;
  }

  private clearMarker(): void {
    this.mode = 'none';
    this.hold = '';
    this.content = '';
    this.closerStars = 0;
  }

  /** 开标记星数：1=斜体，2=加粗（hold 即开标记星串） */
  private get opener(): number {
    return this.hold.length;
  }

  private feedChar(ch: string, out: StreamUnit[]): void {
    if (this.mode === 'divider') {
      if (SCENE_LINE_CHARS_RE.test(ch)) {
        this.hold += ch;
        return;
      }
      // 模式破坏：候选场景线其实是普通文字，整段按字面吐出
      out.push(...literalUnits(this.hold));
      this.blockHasContent = true;
      this.clearMarker();
    }

    if (this.mode === 'none') {
      if (ch === '*') {
        this.mode = 'stars';
        this.hold = '*';
        this.blockHasContent = true;
        return;
      }
      if (!this.blockHasContent && SCENE_LINE_CHARS_RE.test(ch)) {
        this.mode = 'divider';
        this.hold = ch;
        return;
      }
      out.push(textUnit(ch));
      this.blockHasContent = true;
      return;
    }

    if (this.mode === 'stars') {
      if (ch === '*') {
        if (this.hold.length < 2) {
          this.hold += '*';
          return;
        }
        // 第 3 颗星：首颗按字面（demo 正则对 `***x***` 的切法）
        out.push(textUnit(this.hold.charAt(0)));
        this.hold = '**';
        return;
      }
      // 内容首字符：开标记定型（1=斜体 / 2=加粗），进入攒正文
      this.mode = 'content';
      this.content = ch;
      this.closerStars = 0;
      return;
    }

    // content 模式
    if (ch === '*') {
      if (this.opener === 1) {
        // 斜体：下一颗星即闭合（闭合星消耗）
        this.closeStyled(out);
        return;
      }
      this.closerStars++;
      if (this.closerStars === 2) {
        // 加粗：连见两颗星闭合
        this.closeStyled(out);
      }
      return;
    }
    if (this.closerStars > 0) {
      // 假闭合：攒住的单星归回正文
      this.content += '*';
      this.closerStars = 0;
    }
    this.content += ch;
  }

  /** 闭合：按样式（a=斜体 / b=加粗）出队攒住的正文 */
  private closeStyled(out: StreamUnit[]): void {
    const a = this.opener === 1;
    const b = this.opener >= 2;
    for (const ch of this.content) out.push(textUnit(ch, a, b));
    this.clearMarker();
    this.blockHasContent = true;
  }
}

function literalUnits(s: string): StreamUnit[] {
  return [...s].map((ch) => textUnit(ch));
}
