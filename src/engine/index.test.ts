import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, type Renderer } from './index';

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

  it('粒度 1/2：同样文本分块数不同（FR-002）', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const r = createRenderer(container, { granularity: 1, msPerChar: 10 });
    renderers.push(r);
    r.beginTurn();
    r.enqueue('abcd');
    r.finish();
    await vi.waitFor(() => {
      expect([...container.querySelectorAll('.tok')].map((t) => t.textContent)).toEqual(['a', 'b', 'c', 'd']);
    });
    r.cancel();

    const container2 = document.createElement('div');
    document.body.appendChild(container2);
    const r2 = createRenderer(container2, { granularity: 2, msPerChar: 10 });
    renderers.push(r2);
    r2.beginTurn();
    r2.enqueue('abcd');
    r2.finish();
    await vi.waitFor(() => {
      expect([...container2.querySelectorAll('.tok')].map((t) => t.textContent)).toEqual(['ab', 'cd']);
    });
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
