/**
 * markdown-lite 流式解析（FR-004 / ADR-008，TASK-004）。
 * 支持子集：`*斜体*`（动作）、`**加粗**`、空行分段、`---`/`===`/`——` 场景线；
 * 2026-09-10 扩展扁平列表：`- ` 无序（吐 `• ` 项目符文本）、`数字. ` 有序
 * （序号按原文保留，不重排），不嵌套；标记只在行首成立（流首 / 单换行后 /
 * 空行分段后）。
 * 刻意不支持表格/链接/图片（半语法状态必然错乱、外链违背本地化铁律）。
 *
 * 未闭合标记 = 延迟判定（ADR-008，2026-09-07 决策，替代 demo 的完整文本预解析）：
 * 遇 `*`/`**` 先不吐字（尾巴攒着），直到能判定——闭合出现则按样式渲染出队；
 * 段落封存 / 流结束仍未闭合则按字面星号吐出。与 `<think>` 半标签跨包同一哲学。
 * 列表标记候选同哲学：`-`/数字先攒着，见到空格才定型为列表项；候选失败
 * （`-x`、`1.5`）按字面吐出，`-`/`=`/`—` 开头的候选失败移交场景线判定。
 * 无序候选更进一层（2026-09-10 审计发现 5，demo 对齐）：`- ` 之后仍不立即定型
 * （`- - -` 这类「短横+空格」开头的行是潜在场景线形态，demo 按普通文本处理），
 * 攒进待决 hold，等下一个非空白字符裁决——是 `-`/`=` 则候选失败按字面吐出，
 * 否则补发 {item} + 项目符。
 *
 * 产出为字符级单元流（{t,a,b} + {para}/{hr}/{item}），合并成发射粒度是 take-unit 的事。
 */
import { StreamUnit, textUnit } from './queue';

/** 场景线整块判定（demo tokenize：/^\s*(-{3,}|={3,}|—{2,})\s*$/） */
const SCENE_LINE_RE = /^\s*(-{3,}|={3,}|—{2,})\s*$/;
/** 场景线候选字符集：空白与三种划线（块首只有这些字符时才可能成为场景线） */
const SCENE_LINE_CHARS_RE = /[-=—\s]/;
/** 无序列表项目符（解析时随正文吐出，悬挂缩进样式见 engine.css） */
const LIST_BULLET = '• ';

type ParserMode = 'none' | 'stars' | 'content' | 'divider' | 'listdash' | 'listdot';

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
  /** 下一个非换行字符是否处于行首（流首 / 单换行后 / 空行分段后）——列表标记只在行首成立 */
  private lineStart = true;
  /** listdash 待决（发现 5）：`- ` 已攒、未见裁决字符（hold = '- ' + 后续空白） */
  private dashHeld = false;

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
        this.lineStart = true;
      } else if (this.nlRun === 1) {
        // 单个换行是块内普通字符（demo：split(/\n{2,}/) 只切空行）
        this.feedChar('\n', out);
        this.lineStart = true;
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
      // 未闭合标记走到段落封存：按字面吐出（星号候选含开标记星与正文，
      // 列表候选只剩 hold 里的 '-' / 数字串）
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
    this.lineStart = true;
  }

  private clearMarker(): void {
    this.mode = 'none';
    this.hold = '';
    this.content = '';
    this.closerStars = 0;
    this.dashHeld = false;
  }

  /** 开标记星数：1=斜体，2=加粗（hold 即开标记星串） */
  private get opener(): number {
    return this.hold.length;
  }

  private feedChar(ch: string, out: StreamUnit[]): void {
    // 行首语义只在进入本函数前成立（push 在单换行/空行后置位）；任何字符
    // 一经消费即离开行首——先取快照再清，本调用内仍可判列表候选
    const atLineStart = this.lineStart;
    this.lineStart = false;
    if (this.mode === 'listdash' || this.mode === 'listdot') {
      if (this.feedListCandidate(ch, out)) return;
      // 候选失败：已攒字符按字面吐出（或移交场景线吸收），ch 交回常规路径
    }

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
      // 行首列表标记候选（'- ' / '数字. '）：先于场景线判定（'-' 同为
      // 场景线候选字符，候选失败会移交回去）
      if (atLineStart && ch === '-') {
        this.mode = 'listdash';
        this.hold = '-';
        this.blockHasContent = true;
        return;
      }
      if (atLineStart && ch >= '0' && ch <= '9') {
        this.mode = 'listdot';
        this.hold = ch;
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

  /** 列表标记候选（'- ' / '数字. '，2026-09-10 扩展）：消费返回 true；
      失败时归还已攒字符——场景线字符集内的移交 divider 继续判定，否则按
      字面吐出（`-x`、`1.5` 与未扩展前逐字一致）——并返回 false 交回常规路径。
      无序候选遇空格进待决 hold（发现 5），由下一个非空白字符裁决。 */
  private feedListCandidate(ch: string, out: StreamUnit[]): boolean {
    if (this.mode === 'listdash') {
      if (this.dashHeld) {
        // 待决中：空白继续攒（裁决只看第一个非空白字符）
        if (/\s/.test(ch)) {
          this.hold += ch;
          return true;
        }
        const held = this.hold;
        this.clearMarker();
        if (ch === '-' || ch === '=') {
          // 潜在场景线形态（`- - -`、`- ===` 等）：候选失败，攒住的字面移交
          // divider 继续判定（divider 在封存/流末/被破坏时按字面吐出，与 demo
          // 的纯文本语义一致，也保住「块尾仍可吸收后续划线字符」的既有行为）
          this.mode = 'divider';
          this.hold = held;
          this.feedChar(ch, out);
          return true;
        }
        // 正常列表项定型：补发 {item} + 项目符；hold 前两字符是标记本体
        // （`- `，即刻定型版同样吞掉首空格），余量空白按正文吐出。
        // ch 交回常规路径（可能是 `*` 开标记、正文等）。
        out.push({ item: true, ordered: false });
        out.push(...literalUnits(LIST_BULLET + held.slice(2)));
        this.feedChar(ch, out);
        return true;
      }
      if (ch === ' ') {
        // 首个空格不立即定型（发现 5）：`- ` 可能是 `- - -` 场景线形态的
        // 前缀，进待决 hold 等下一个非空白字符裁决
        this.hold += ch;
        this.dashHeld = true;
        return true;
      }
      const dash = this.hold; // '-'
      this.clearMarker();
      if (SCENE_LINE_CHARS_RE.test(ch)) {
        // '--'、'-—' 等仍是场景线候选：移交 divider 吸收当前字符
        this.mode = 'divider';
        this.hold = dash;
        this.feedChar(ch, out);
        return true;
      }
      out.push(...literalUnits(dash));
      return false;
    }
    // listdot：数字串 + 至多一个 '.'，空格定型；序号文本按原文保留
    if (ch >= '0' && ch <= '9') {
      this.hold += ch;
      return true;
    }
    if (ch === '.' && !this.hold.includes('.')) {
      this.hold += ch;
      return true;
    }
    const marker = this.hold;
    this.clearMarker();
    if (ch === ' ' && marker.endsWith('.')) {
      out.push({ item: true, ordered: true });
      out.push(...literalUnits(`${marker} `));
      return true;
    }
    out.push(...literalUnits(marker));
    return false;
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
