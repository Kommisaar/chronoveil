import { afterEach, describe, expect, it, vi } from 'vitest';
import { TICK_MS } from './clock';
import { createRenderer, type Renderer } from './index';
import { THINK_PHASE } from './think';

function mount(): { container: HTMLDivElement; r: Renderer } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const r = createRenderer(container);
  renderers.push(r);
  return { container, r };
}

const renderers: Renderer[] = [];

afterEach(() => {
  // 停掉一切消费者计时器，避免 tick 在环境拆除后触发
  for (const r of renderers) r.cancel();
  renderers.length = 0;
  document.body.textContent = '';
});

describe('渲染引擎公开 API（CMP-001 / TASK-004）', () => {
  it('创建即绑定容器：data-anim 与 --dur 基准（默认 fade / 450ms）', () => {
    const { container, r } = mount();
    expect(container.dataset.anim).toBe('fade');
    expect(container.style.getPropertyValue('--dur')).toBe('450ms');
    expect(r.runId).toBe(0);
    r.cancel();
  });

  it('enqueue + finish：全部吐出（粒度 2 合并）、单一段落、光标移除', async () => {
    const { container, r } = mount();
    r.beginTurn();
    r.enqueue('你好世界');
    r.finish();
    await vi.waitFor(() => {
      expect([...container.querySelectorAll('.tok')].map((t) => t.textContent)).toEqual(['你好', '世界']);
      expect(container.querySelectorAll('.para')).toHaveLength(1);
      expect(container.querySelector('.stream-cursor')).toBeNull();
    });
    expect(r.pending).toBe(0);
    expect(r.charsEmitted).toBe(4);
  });

  it('空行分段与场景线：已完成段落封存为静态 .para，场景线为 hr.scene', async () => {
    const { container, r } = mount();
    r.beginTurn();
    r.enqueue('前情\n\n---\n\n后语');
    r.finish();
    await vi.waitFor(
      () => {
        expect(container.querySelectorAll('.para')).toHaveLength(2);
        expect(container.querySelector('hr.scene')).not.toBeNull();
      },
      { timeout: 4000 }, // 段落/场景线出队带 260ms+节奏 深呼吸
    );
    const paras = [...container.querySelectorAll('.para')];
    expect(paras[0]?.textContent).toBe('前情');
    expect(paras[1]?.textContent).toBe('后语');
  });

  it('列表（2026-09-10 扩展）：流式渲染产出 uli/oli 段落，项目符随正文吐出', async () => {
    const { container, r } = mount();
    r.beginTurn();
    r.enqueue('- 甲\n- 乙\n\n1. 丙');
    r.finish();
    await vi.waitFor(
      () => {
        // 文本断言一并放进 waitFor：结构单元先行上屏，文本还在节奏队列
        expect(container.querySelectorAll('.para.uli')).toHaveLength(2);
        expect(container.querySelector('.para.oli')?.textContent).toContain('1. 丙');
      },
      { timeout: 4000 },
    );
    const ulis = [...container.querySelectorAll('.para.uli')];
    expect(ulis[0]?.textContent).toContain('• 甲');
  });

  it('未闭合星号：段落封存按字面吐出（ADR-008 字面路）', async () => {
    const { container, r } = mount();
    r.beginTurn();
    r.enqueue('*没闭合');
    r.finish();
    await vi.waitFor(() => expect(container.querySelectorAll('.tok')).toHaveLength(2));
    const toks = [...container.querySelectorAll('.tok')];
    expect(toks.map((t) => t.textContent).join('')).toBe('*没闭合');
    expect(toks.some((t) => t.classList.contains('action'))).toBe(false);
  });

  it('闭合斜体：样式渲染（ADR-008 闭合路，FR-004）', async () => {
    const { container, r } = mount();
    r.beginTurn();
    r.enqueue('*动作*台词');
    r.finish();
    await vi.waitFor(() => expect(container.querySelectorAll('.tok')).toHaveLength(2));
    const toks = [...container.querySelectorAll('.tok')];
    expect(toks.filter((t) => t.classList.contains('action')).map((t) => t.textContent)).toEqual(['动作']);
    expect(toks.filter((t) => !t.classList.contains('action')).map((t) => t.textContent)).toEqual(['台词']);
  });

  it('token 注入随机落点属性并经双 rAF 加 .show（FR-005）', async () => {
    const { container, r } = mount();
    r.beginTurn();
    r.enqueue('字');
    r.finish();
    const tok = await vi.waitFor(() => {
      const el = container.querySelector<HTMLElement>('.tok');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(tok.style.getPropertyValue('--dx').endsWith('em')).toBe(true);
    expect(tok.style.getPropertyValue('--dy').endsWith('em')).toBe(true);
    expect(tok.style.getPropertyValue('--rot').endsWith('deg')).toBe(true);
    await vi.waitFor(() => expect(tok.classList.contains('show')).toBe(true));
  });

  it('中途 setStyle 即时生效且不重播已上屏 token', async () => {
    const { container, r } = mount();
    r.beginTurn();
    r.enqueue('第一');
    r.finish();
    const first = await vi.waitFor(() => {
      const el = container.querySelector<HTMLElement>('.tok');
      expect(el?.classList.contains('show')).toBe(true);
      return el!;
    });
    r.setStyle('rise');
    expect(container.dataset.anim).toBe('rise');
    expect(first.classList.contains('show')).toBe(true); // 未重播：show 未被摘除
  });

  it('decode 风格：乱码轮换最终定格真文（finish 统一收尾）', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const r = createRenderer(container, { style: 'decode' });
    renderers.push(r);
    r.beginTurn();
    r.enqueue('密文');
    r.finish();
    await vi.waitFor(() => {
      const toks = [...container.querySelectorAll<HTMLElement>('.tok')];
      expect(toks).toHaveLength(1); // 粒度 2：'密文' 合并为一个 token
      expect(toks.every((t) => t.classList.contains('settled'))).toBe(true);
      expect(toks.map((t) => t.textContent).join('')).toBe('密文');
    });
  });

  it('粒度 1/2：同样文本分块数不同（FR-002；用 CJK——拉丁词有整词不拆约束）', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const r = createRenderer(container, { granularity: 1, msPerChar: 10 });
    renderers.push(r);
    r.beginTurn();
    r.enqueue('甲乙丙丁');
    r.finish();
    await vi.waitFor(() => {
      expect([...container.querySelectorAll('.tok')].map((t) => t.textContent)).toEqual(['甲', '乙', '丙', '丁']);
    });
    r.cancel();

    const container2 = document.createElement('div');
    document.body.appendChild(container2);
    const r2 = createRenderer(container2, { granularity: 2, msPerChar: 10 });
    renderers.push(r2);
    r2.beginTurn();
    r2.enqueue('甲乙丙丁');
    r2.finish();
    await vi.waitFor(() => {
      expect([...container2.querySelectorAll('.tok')].map((t) => t.textContent)).toEqual(['甲乙', '丙丁']);
    });
  });

  it('拉丁词整词上屏：粒度合并不拆断英文单词（发现 7，demo splitChunks 对齐）', async () => {
    const { container, r } = mount();
    r.beginTurn();
    r.enqueue('hello world');
    r.finish();
    await vi.waitFor(() => {
      expect([...container.querySelectorAll('.tok')].map((t) => t.textContent)).toEqual(['hello', ' world']);
    });
    expect(r.charsEmitted).toBe(10); // 口径不含空白（空格不计）
  });

  it('setRhythm 改节奏，下一拍生效（边界值钳制 10–160）', async () => {
    const { container, r } = mount();
    r.setRhythm(5, true); // 低于下限 → 钳到 10
    r.setRhythm(999, false); // 高于上限 → 钳到 160
    r.beginTurn();
    r.enqueue('好');
    r.finish();
    await vi.waitFor(() => expect(container.querySelectorAll('.tok')).toHaveLength(1));
  });

  it('cancel：停消费、清队列、摘光标', () => {
    const { container, r } = mount();
    r.beginTurn();
    r.enqueue('一大段还没播完的文字');
    expect(r.pending).toBeGreaterThan(0);
    r.cancel();
    expect(r.pending).toBe(0);
    expect(container.querySelector('.stream-cursor')).toBeNull();
  });

  it('finish 回报字数（onFinish）', async () => {
    const onFinish = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const r = createRenderer(container, { onFinish, msPerChar: 10 });
    renderers.push(r);
    r.beginTurn();
    r.enqueue('三字');
    r.finish();
    await vi.waitFor(() => expect(onFinish).toHaveBeenCalledWith({ chars: 2 }));
  });

  it('think：开思考回合建胶囊，cancel 清理', () => {
    const { container, r } = mount();
    r.think('思考内容');
    expect(r.runId).toBe(1);
    expect(container.querySelector('.think')).not.toBeNull();
    expect(container.querySelector('.think-body')?.textContent).toBe('');
    r.cancel();
    expect(container.querySelector('.think')).toBeNull();
  });

  it('beginTurn 换回合：runId 递增、清屏重来', async () => {
    const { container, r } = mount();
    r.beginTurn();
    r.enqueue('旧回合');
    r.beginTurn();
    expect(r.runId).toBe(2); // 每次开新回合 runId 递增（含首回合）
    expect(container.querySelectorAll('.tok')).toHaveLength(0);
    r.enqueue('新');
    r.finish();
    await vi.waitFor(() => expect([...container.querySelectorAll('.tok')].map((t) => t.textContent)).toEqual(['新']));
  });
});

describe('流式思考与积压回放（TASK-006 / FR-003 / ADR-007）', () => {
  afterEach(() => {
    for (const r of renderers) r.cancel();
    renderers.length = 0;
    document.body.textContent = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('thinkStreaming + appendThink + finishThinking：增量思考快滚、显式收拢后自动开演正文', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 起手 550ms、每跳 3 字
    const { container, r } = mount();

    r.thinkStreaming();
    expect(r.runId).toBe(1);
    vi.advanceTimersByTime(600); // 起手完成
    expect(container.querySelector('.think')).not.toBeNull();
    expect(container.querySelector('.think-body')?.textContent).toBe('');

    r.appendThink('第一段思考');
    vi.advanceTimersByTime(THINK_PHASE.stepIntervalMs * 12);
    expect(container.querySelector('.think-body')?.textContent).toBe('第一段思考');

    // 追平后悬停：流式模式不自动收拢，等正文到达的显式 finishThinking
    vi.advanceTimersByTime(5000);
    expect(container.querySelector('.think')?.classList.contains('done')).toBe(false);

    r.appendThink('，第二段');
    r.finishThinking();
    vi.advanceTimersByTime(THINK_PHASE.settlePauseMs);
    expect(container.querySelector('.think.done')).not.toBeNull();
    vi.advanceTimersByTime(THINK_PHASE.beginAfterCollapseMs);
    expect(container.querySelector('.think.done.collapsed')).not.toBeNull();

    // 正文开演：增量 token 走队列，finish 后收尾
    r.enqueue('正文');
    r.finish();
    vi.advanceTimersByTime(TICK_MS * 8);
    expect([...container.querySelectorAll('.tok')].map((t) => t.textContent)).toEqual(['正文']);
    expect(container.querySelector('.stream-cursor')).toBeNull();
  });

  it('replayInstant：积压正文立即上屏（不经节奏队列），后续 enqueue 正常续播', async () => {
    const { container, r } = mount();
    r.beginTurn();
    r.replayInstant('积压的段落\n\n立即上屏');
    // 同步渲染：不等待 16ms tick
    expect(container.querySelectorAll('.para')).toHaveLength(2);
    const replayed = [...container.querySelectorAll('.tok')].map((t) => t.textContent).join('');
    expect(replayed).toBe('积压的段落立即上屏');

    r.enqueue('新');
    r.finish();
    await vi.waitFor(() => {
      const all = [...container.querySelectorAll('.tok')].map((t) => t.textContent).join('');
      expect(all).toBe('积压的段落立即上屏新');
    });
  });

  it('replayInstant 空串与分段封存：不炸、推进 sealer', () => {
    const { container, r } = mount();
    r.beginTurn();
    r.replayInstant('');
    expect(container.querySelectorAll('.tok')).toHaveLength(0);
    r.replayInstant('一\n\n二');
    expect(container.querySelectorAll('.para')).toHaveLength(2);
    r.cancel();
  });
});

describe('回合控制与口径补遗（TASK-06）', () => {
  afterEach(() => {
    // 顶部 afterEach 已停消费者；此处还原 fake timers（若本 describe 内启用）
    vi.useRealTimers();
  });

  function mountWith(options: Parameters<typeof createRenderer>[1]): {
    container: HTMLDivElement;
    r: Renderer;
  } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const r = createRenderer(container, options);
    renderers.push(r);
    return { container, r };
  }

  it('finish 兜底开演：未 beginTurn 直接 enqueue+finish 也完整播完并回报', async () => {
    const onFinish = vi.fn();
    const { container, r } = mountWith({ onFinish, msPerChar: 10 });
    r.enqueue('兜底');
    expect(container.querySelectorAll('.tok')).toHaveLength(0); // 无消费者：未开演不上屏
    r.finish(); // 队列非空、无思考、正文未开演 → 兜底 beginBody 排空
    await vi.waitFor(() => {
      expect([...container.querySelectorAll('.tok')].map((t) => t.textContent)).toEqual(['兜底']);
      expect(container.querySelector('.stream-cursor')).toBeNull();
    });
    expect(onFinish).toHaveBeenCalledWith({ chars: 2 });
  });

  it('finish 落在思考中：胶囊走完落定+收拢动画再收尾，不瞬时拆除（发现 4）', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    const onFinish = vi.fn();
    const { container, r } = mountWith({ onFinish });
    r.thinkStreaming();
    expect(container.querySelector('.think')).not.toBeNull();

    r.finish(); // 队列空但思考通道活跃 → 不立即收尾，先等胶囊收拢
    expect(onFinish).not.toHaveBeenCalled();
    expect(container.querySelector('.think')).not.toBeNull(); // 胶囊未被 cancel 摘除

    vi.advanceTimersByTime(THINK_PHASE.settlePauseMs);
    expect(container.querySelector('.think.done.collapsed')).not.toBeNull(); // 收拢而非拆除
    vi.advanceTimersByTime(THINK_PHASE.beginAfterCollapseMs + TICK_MS * 2);
    expect(onFinish).toHaveBeenCalledTimes(1); // onDone → beginBody → tick 排空即收尾
    expect(container.querySelector('.think.done.collapsed')).not.toBeNull(); // 胶囊保留可回看
  });

  it('finish 落在思考中且正文已入队：收拢后开演、排空再收尾（发现 4）', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    const onFinish = vi.fn();
    const { container, r } = mountWith({ onFinish });
    r.thinkStreaming();
    r.enqueue('正文');
    r.finish();
    // 消费者未启动（正文未开演）：收拢完成前排空队列不漏字、不同步收尾
    expect(container.querySelectorAll('.tok')).toHaveLength(0);
    expect(onFinish).not.toHaveBeenCalled();

    vi.advanceTimersByTime(THINK_PHASE.settlePauseMs + THINK_PHASE.beginAfterCollapseMs + TICK_MS * 8);
    expect([...container.querySelectorAll('.tok')].map((t) => t.textContent)).toEqual(['正文']);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.stream-cursor')).toBeNull();
  });

  it('cancel 后 pending 清零，onFinish 不再触发', async () => {
    const onFinish = vi.fn();
    const { container, r } = mountWith({ onFinish, msPerChar: 10 });
    r.beginTurn();
    r.enqueue('一大段还没播完的文字');
    r.cancel();
    expect(r.pending).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 80)); // 留出若干真实 tick 窗口
    expect(onFinish).not.toHaveBeenCalled();
    expect(container.querySelectorAll('.tok')).toHaveLength(0);
  });

  it('onFinish 的 chars 口径不含空白：空格与换行不计', async () => {
    const onFinish = vi.fn();
    const { r } = mountWith({ onFinish, msPerChar: 10 });
    r.beginTurn();
    r.enqueue('甲 乙\n丙');
    r.finish();
    // 粒度 2 合并为「甲 」「乙\n」「丙」，trim 后逐 token 计数 → 3
    await vi.waitFor(() => expect(onFinish).toHaveBeenCalledWith({ chars: 3 }));
  });

  it('setGranularity 中途调整，下一拍生效', async () => {
    const { container, r } = mount();
    r.beginTurn();
    r.enqueue('甲乙丙丁'); // 默认粒度 2
    r.setGranularity(1); // 入队后、首拍前调整 → 本回合剩余发射全部逐字
    r.finish();
    await vi.waitFor(() => {
      expect([...container.querySelectorAll('.tok')].map((t) => t.textContent)).toEqual(['甲', '乙', '丙', '丁']);
    });
  });

  it('setRhythm 关标点微停，下一拍生效：中段停顿消失、提前收尾', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    const onFinish = vi.fn();
    const { container, r } = mountWith({ onFinish });
    r.beginTurn();
    r.enqueue('甲。乙。丙');
    r.finish();

    vi.advanceTimersByTime(240); // 15 拍：句末微停（150+节奏×0.8）压信用，仅出「甲。」
    expect(container.querySelectorAll('.tok')).toHaveLength(1);
    expect(container.querySelector('.stream-cursor')).not.toBeNull(); // 回合未收尾

    r.setRhythm(45, false); // 关微停，下一拍生效
    vi.advanceTimersByTime(192); // 共 t=432：关停路径应在 t≈352 播完（微停未关则 t≈544）
    expect(container.querySelectorAll('.tok')).toHaveLength(3); // 「甲。」「乙。」「丙」
    expect(container.querySelector('.stream-cursor')).toBeNull();
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith({ chars: 5 });
  });

  it('dots 风格：开演插入三点加载态，首个 token 上屏后移除', async () => {
    const { container, r } = mountWith({ style: 'dots' });
    r.beginTurn();
    expect(container.querySelectorAll('.dots .dot')).toHaveLength(3);
    r.enqueue('字');
    r.finish();
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.tok')).toHaveLength(1);
      expect(container.querySelector('.dots')).toBeNull();
    });
  });

  it('setDuration 范围外钳制写入 --dur（150 下界 / NaN 兜底默认）', () => {
    const { container, r } = mountWith({});
    r.setDuration(50);
    expect(container.style.getPropertyValue('--dur')).toBe('150ms');
    r.setDuration(Number.NaN);
    expect(container.style.getPropertyValue('--dur')).toBe('450ms');
  });

  it('cursor:false：全程不挂光标', async () => {
    const { container, r } = mountWith({ cursor: false, msPerChar: 10 });
    r.beginTurn();
    r.enqueue('无光标');
    r.finish();
    await vi.waitFor(() => expect(container.querySelectorAll('.tok')).toHaveLength(2));
    expect(container.querySelector('.stream-cursor')).toBeNull();
  });

  it('setCursorEnabled(false)：运行中即时摘除光标', async () => {
    const { container, r } = mountWith({ msPerChar: 10 });
    r.beginTurn();
    r.enqueue('光标开关');
    r.setCursorEnabled(false);
    r.finish();
    await vi.waitFor(() => expect(container.querySelectorAll('.tok')).toHaveLength(2));
    expect(container.querySelector('.stream-cursor')).toBeNull();
  });

  it('enqueueUnit：外部预解析单元直入队列，结构单元原子上屏', async () => {
    const { container, r } = mountWith({ msPerChar: 10 });
    r.beginTurn();
    r.enqueueUnit({ hr: true });
    r.enqueueUnit({ t: '直', a: false, b: false });
    r.finish();
    // hr 出队带 260ms+节奏深呼吸，「直」随后上屏：两断言同 waitFor
    await vi.waitFor(() => {
      expect(container.querySelector('hr.scene')).not.toBeNull();
      expect([...container.querySelectorAll('.tok')].map((t) => t.textContent)).toEqual(['直']);
    });
  });
});
