import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_THINK_TIPS, THINK_PHASE, ThinkChannel, formatThinkDuration } from './think';

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

function mount(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}

describe('秒数分级格式化（FR-003）', () => {
  it('<10s 一位小数；≥10s 取整；≥60s 走 m:ss', () => {
    expect(formatThinkDuration(0)).toBe('0.0s');
    expect(formatThinkDuration(3.456)).toBe('3.5s');
    expect(formatThinkDuration(9.96)).toBe('10.0s');
    expect(formatThinkDuration(10.4)).toBe('10s');
    expect(formatThinkDuration(61.5)).toBe('1:02');
    expect(formatThinkDuration(125.25)).toBe('2:05');
  });
});

describe('ThinkChannel 阶段时序（FR-003，demo 实测参数）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 起手 550ms、每跳 3 字、贴士池原序
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.textContent = '';
    setHidden(false);
  });

  it('起 550（420+rand×260）→ 快滚 → 落定 380 → 收拢 → +520 开演', () => {
    const root = mount();
    const onDone = vi.fn();
    const ch = new ThinkChannel(root, { text: '我思故我在', isCurrent: () => true, onDone });
    ch.start();

    const box = root.querySelector('.think');
    expect(box).not.toBeNull();
    expect(root.querySelector('.tk-label')?.textContent).toBe(DEFAULT_THINK_TIPS[0]);
    expect(root.querySelector('.think-body')?.textContent).toBe('');

    vi.advanceTimersByTime(549); // 尚未起手
    expect(root.querySelector('.think-body')?.textContent).toBe('');

    vi.advanceTimersByTime(1); // 550ms：首跳 3 字
    expect(root.querySelector('.think-body')?.textContent).toBe('我思故');

    vi.advanceTimersByTime(THINK_PHASE.stepIntervalMs); // 574ms：补完 5 字并停滚
    expect(root.querySelector('.think-body')?.textContent).toBe('我思故我在');
    expect(root.querySelector('.tk-time')?.textContent).toBe('0.6s'); // visMs=574ms（含起手段）

    vi.advanceTimersByTime(THINK_PHASE.settlePauseMs - 1);
    expect(box?.classList.contains('done')).toBe(false);
    vi.advanceTimersByTime(1); // 954ms：落定→收拢
    expect(box?.classList.contains('done')).toBe(true);
    expect(box?.classList.contains('collapsed')).toBe(true);
    expect(root.querySelector('.tk-label')?.textContent).toBe('已深度思考');
    expect(root.querySelector('.tk-time')?.textContent).toBe('· 0.6s');

    vi.advanceTimersByTime(THINK_PHASE.beginAfterCollapseMs - 1);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); // 1474ms：开演
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('收拢后胶囊点击展开回看、再点收拢', () => {
    const root = mount();
    const ch = new ThinkChannel(root, { text: '短', isCurrent: () => true, onDone: () => {} });
    ch.start();
    const box = root.querySelector('.think')!;
    vi.advanceTimersByTime(10000); // 走完全程

    const head = box.querySelector('.think-head') as HTMLButtonElement;
    expect(box.classList.contains('collapsed')).toBe(true);
    head.click();
    expect(box.classList.contains('collapsed')).toBe(false); // 展开回看
    head.click();
    expect(box.classList.contains('collapsed')).toBe(true);
  });

  it('未收拢完成时点击不展开', () => {
    const root = mount();
    const ch = new ThinkChannel(root, { text: '短', isCurrent: () => true, onDone: () => {} });
    ch.start();
    const box = root.querySelector('.think')!;
    (box.querySelector('.think-head') as HTMLButtonElement).click();
    expect(box.classList.contains('done')).toBe(false);
    expect(box.classList.contains('collapsed')).toBe(false);
  });

  it('runId 过气后所有回调退场，onDone 不再触发', () => {
    const root = mount();
    const onDone = vi.fn();
    const ch = new ThinkChannel(root, { text: '短', isCurrent: () => false, onDone });
    ch.start();
    vi.advanceTimersByTime(100000);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('cancel 摘除胶囊并停一切计时', () => {
    const root = mount();
    const onDone = vi.fn();
    const ch = new ThinkChannel(root, { text: '短', isCurrent: () => true, onDone });
    ch.start();
    ch.cancel();
    expect(root.querySelector('.think')).toBeNull();
    vi.advanceTimersByTime(100000);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('收拢落闸后迟到的换词回调不改写定格文案', () => {
    const root = mount();
    const ch = new ThinkChannel(root, { text: '字'.repeat(240), isCurrent: () => true, onDone: () => {} });
    ch.start();
    // 快滚 550+240×24/3… 于 ~2470ms 停滚；贴士第二轮换词 2400ms 排期 2700ms 渐入
    const labels: string[] = [];
    for (let t = 0; t < 6000; t += 100) {
      vi.advanceTimersByTime(100);
      labels.push(root.querySelector('.tk-label')?.textContent ?? '');
    }
    expect(labels).not.toContain(DEFAULT_THINK_TIPS[2]); // 第二轮换词永不上屏
    expect(labels.at(-1)).toBe('已深度思考');
  });
});

describe('visMs 只计页面可见时长（FR-003）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.textContent = '';
    setHidden(false);
  });

  it('后台期间快滚不计时，回前台从起算点续记', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 起手 550ms、每跳 3 字，消除随机性
    const root = mount();
    setHidden(true);
    const ch = new ThinkChannel(root, { text: 'x'.repeat(400), isCurrent: () => true, onDone: () => {} });
    ch.start();

    vi.advanceTimersByTime(1000); // 起手+若干跳全部发生在后台 → 计 0
    expect(root.querySelector('.tk-time')?.textContent).toBe('0.0s');

    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange')); // 回前台，重置起算点
    vi.advanceTimersByTime(240); // 10 跳 × 24ms 全部可见
    expect(root.querySelector('.tk-time')?.textContent).toBe('0.2s');

    setHidden(true);
    vi.advanceTimersByTime(240); // 又回到后台：不计时
    expect(root.querySelector('.tk-time')?.textContent).toBe('0.2s');

    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(240);
    expect(root.querySelector('.tk-time')?.textContent).toBe('0.4s'); // 再 9 跳 ×24ms：216+216=432ms 可见
    ch.cancel();
  });

  it('贴士池 12 条乱序轮换，一圈之内不重样', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 洗牌稳定 → 原序轮换，便于断言
    const root = mount();
    const ch = new ThinkChannel(root, { text: 'x'.repeat(6000), isCurrent: () => true, onDone: () => {} });
    ch.start();
    const label = () => root.querySelector('.tk-label')?.textContent ?? '';
    const seen = new Set<string>([label()]);
    let last = label();
    for (let t = 0; t < 18000; t += 150) {
      vi.advanceTimersByTime(150); // 细粒度采样：每次换词（1200ms 一换、300ms 渐出渐入）都不漏
      const cur = label();
      if (cur !== last) {
        seen.add(cur);
        last = cur;
      }
    }
    expect(seen.size).toBe(DEFAULT_THINK_TIPS.length); // 一圈之内不重样
    ch.cancel();
  });
});

describe('ThinkChannel 流式模式（TASK-006，FR-003 接通真实 LLM）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 起手 550ms、每跳 3 字
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.textContent = '';
  });

  it('appendText 增量喂入：追平不自动收拢，finish 后走落定→收拢→开演', () => {
    const root = mount();
    const onDone = vi.fn();
    const ch = new ThinkChannel(root, { text: '', streaming: true, isCurrent: () => true, onDone });
    ch.start();

    vi.advanceTimersByTime(600); // 起手完成（首跳空文本）
    expect(root.querySelector('.think')!.classList.contains('done')).toBe(false);

    ch.appendText('夜色渐深');
    vi.advanceTimersByTime(THINK_PHASE.stepIntervalMs * 12);
    expect(root.querySelector('.think-body')?.textContent).toBe('夜色渐深');

    vi.advanceTimersByTime(5000); // 追平悬停：流式模式等显式 finish
    expect(root.querySelector('.think')!.classList.contains('done')).toBe(false);

    ch.appendText('，雨更大了');
    ch.finish();
    vi.advanceTimersByTime(THINK_PHASE.settlePauseMs);
    const box = root.querySelector('.think')!;
    expect(box.classList.contains('done')).toBe(true);
    expect(box.classList.contains('collapsed')).toBe(true);
    expect(root.querySelector('.tk-time')?.textContent).toContain('s');
    vi.advanceTimersByTime(THINK_PHASE.beginAfterCollapseMs);
    expect(onDone).toHaveBeenCalledTimes(1);

    // 收拢后到达的迟到增量：不再驱动任何回调
    ch.appendText('迟到增量');
    vi.advanceTimersByTime(3000);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('未追平即 finish：收拢前把 body 冲平为全文，胶囊展开回看完整 reasoning 而非前缀', () => {
    const root = mount();
    const onDone = vi.fn();
    const full = '夜'.repeat(600); // 追平需 200 跳 ≈ 4.8s，远超下面几百毫秒的推进预算
    const ch = new ThinkChannel(root, { text: '', streaming: true, isCurrent: () => true, onDone });
    ch.start();
    ch.appendText(full);
    vi.advanceTimersByTime(550); // 首跳 3 字
    vi.advanceTimersByTime(THINK_PHASE.stepIntervalMs * 9); // 共 10 跳 30 字，远未追平
    expect(root.querySelector('.think-body')?.textContent?.length).toBe(30);

    ch.finish(); // 快滚停在此刻：尾巴若不冲平将永久丢失
    vi.advanceTimersByTime(THINK_PHASE.settlePauseMs - 1);
    expect(root.querySelector('.think-body')?.textContent).toBe(full); // 落定悬停期全文可见

    vi.advanceTimersByTime(1); // 落定 → 收拢
    const box = root.querySelector('.think')!;
    expect(box.classList.contains('done')).toBe(true);
    expect(box.classList.contains('collapsed')).toBe(true);
    vi.advanceTimersByTime(THINK_PHASE.beginAfterCollapseMs);
    expect(onDone).toHaveBeenCalledTimes(1);

    (box.querySelector('.think-head') as HTMLButtonElement).click(); // 展开回看
    expect(box.classList.contains('collapsed')).toBe(false);
    expect(root.querySelector('.think-body')?.textContent).toBe(full);
    (box.querySelector('.think-head') as HTMLButtonElement).click(); // 再点收拢
    expect(box.classList.contains('collapsed')).toBe(true);
  });

  it('finish 幂等：显式 finish 与快滚追平触发的收拢竞争只走一次（demo 模式）', () => {
    const root = mount();
    const onDone = vi.fn();
    const ch = new ThinkChannel(root, { text: '短', isCurrent: () => true, onDone });
    ch.start();
    ch.finish(); // 与追平收揽竞争
    vi.advanceTimersByTime(10000);
    expect(onDone).toHaveBeenCalledTimes(1);
    ch.appendText('迟到');
    vi.advanceTimersByTime(1000);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
