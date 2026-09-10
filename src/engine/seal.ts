/**
 * 段落封存（FR-004，demo curPara/renderTok 的 paraEl 生命周期搬家，TASK-004）：
 * 混合渲染——已完成段落封存为静态容器，不再受尾部追加影响；
 * 只有尾段接收 token 级流式追加，动画只发生在尾段。
 * 结构单元（{para}/{hr}）出队时触发封存：{para} 固化当前段，{hr} 同时落一条场景线。
 */
export class ParagraphStream {
  private current: HTMLDivElement | null = null;
  private sealedCount = 0;

  constructor(private readonly root: HTMLElement) {}

  /** 尾段容器（惰性创建 .para；kind 给出时带列表类，见 engine.css 悬挂缩进）；
      封存后再次访问会得到全新容器 */
  tail(kind?: 'uli' | 'oli'): HTMLElement {
    if (!this.current) {
      const para = document.createElement('div');
      para.className = kind ? `para ${kind}` : 'para';
      this.root.appendChild(para);
      this.current = para;
    }
    return this.current;
  }

  /** 封存当前段：固化为静态容器，后续追加改投新容器 */
  seal(): void {
    if (this.current) {
      this.sealedCount++;
      this.current = null;
    }
  }

  /** 场景线：独立根级元素（hr.scene），同时封存当前段 */
  sceneLine(): HTMLHRElement {
    this.seal();
    const hr = document.createElement('hr');
    hr.className = 'scene';
    this.root.appendChild(hr);
    return hr;
  }

  reset(): void {
    this.current = null;
    this.sealedCount = 0;
  }

  /** 本回合已封存的段落总数 */
  get sealedParagraphs(): number {
    return this.sealedCount;
  }
}
