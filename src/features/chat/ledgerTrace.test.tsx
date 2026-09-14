/**
 * LedgerTraceSection（叙事账本「调用轨迹」段）组件级渲染测试。
 *
 * 覆盖七类判定逻辑（行号锚定当前 ledgerTrace.tsx）：
 * 1. :400 倒序排序 + 同刻 id 降序 tiebreak；
 * 2. :429 时序序号（最旧 1、最新最大）；
 * 3. :403-406 会话汇总口径（失败数只算 error / token 合计只算 ok / null 记 0）；
 * 4. 单行展开互斥（同时只开一行，点开另一行收起前一行）；
 * 5. :396-398 sessionId 切换重置展开行；
 * 6. :224-260 promptJson / toolCallsJson 防御式解析降级（坏数据原文兜底、不抛错）；
 * 7. :315-316 请求段可见性三态与无请求内容时整段省略。
 *
 * 惯例约束：本文件落在 vitest shared 组（isolate:false），RTL 不自动 cleanup，
 * 必须自行 afterEach(cleanup)；断言只看文本与 DOM 结构（aria-expanded），
 * 不做「遍历 document.styleSheets 找 cssRules」类样式扫描——该类断言须登记
 * isolated-styles 组，且 role 分色属 Griffel 视觉层，jsdom 无布局引擎本就
 * 不可观测，颜色维度不在此测试的职责内。
 */
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import '../../i18n';
import { LedgerTraceSection } from './ledgerTrace';
import type { LlmCall } from './streamHub';

/** 夹具基座：id / startedAt 由调用方必填（排序与序号断言的核心维度），其余给中性默认值。 */
function makeCall(overrides: Partial<LlmCall> & Pick<LlmCall, 'id' | 'startedAt'>): LlmCall {
  return {
    sessionId: 1,
    kind: 'dialogue',
    model: 'model-default',
    durationMs: 1500,
    promptJson: '[]',
    responseText: null,
    reasoningText: null,
    toolCallsJson: null,
    promptTokens: null,
    completionTokens: null,
    status: 'ok',
    errorText: null,
    ...overrides,
  };
}

function renderTrace(calls: LlmCall[] | null, sessionId = 1) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <LedgerTraceSection sessionId={sessionId} calls={calls} />
    </FluentProvider>,
  );
}

/** 段内行头按钮按 DOM 顺序取全文（#序号 + kind 徽标 + 模型 + 元信息都在按钮内）。 */
function rowTexts(): string[] {
  const section = screen.getByRole('region', { name: '调用轨迹' });
  return Array.from(section.querySelectorAll('button')).map((b) => b.textContent ?? '');
}

/** 行头按钮定位：夹具内模型名唯一，经最近 button 归位（行头是唯一含模型的按钮）。 */
function rowButton(model: string): HTMLButtonElement {
  const button = screen.getByText(model).closest('button');
  if (!(button instanceof HTMLButtonElement)) throw new Error(`行头按钮未找到：${model}`);
  return button;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('LedgerTraceSection 排序：startedAt 倒序 + 同刻 id 降序 tiebreak', () => {
  it('不同刻按 startedAt 倒序；同刻行按 id 降序（后落库在上）', () => {
    // 同刻对 (id:7, id:9) 在输入里刻意按 id 升序给——JS sort 稳定，若 tiebreak
    // 「|| b.id - a.id」被删，同刻组保持输入序（id7 在上），本断言即红
    renderTrace([
      makeCall({ id: 7, startedAt: 5000, model: 'tie-id-7' }),
      makeCall({ id: 9, startedAt: 5000, model: 'tie-id-9' }),
      makeCall({ id: 2, startedAt: 9000, model: 'newer-ts-2' }),
    ]);
    const rows = rowTexts();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('newer-ts-2');
    expect(rows[1]).toContain('tie-id-9');
    expect(rows[2]).toContain('tie-id-7');
  });
});

describe('LedgerTraceSection 时序序号：最旧 1、最新最大', () => {
  it('序号与排序后位置锚定：最新行 #3、中行 #2、最旧行 #1', () => {
    // 输入顺序刻意打乱：序号只能来自排序后的位置，而非夹具数组下标
    renderTrace([
      makeCall({ id: 2, startedAt: 3000, model: 'mid-ts' }),
      makeCall({ id: 1, startedAt: 1000, model: 'oldest-ts' }),
      makeCall({ id: 3, startedAt: 6000, model: 'newest-ts' }),
    ]);
    const rows = rowTexts();
    expect(rows[0]).toContain('#3');
    expect(rows[0]).toContain('newest-ts');
    expect(rows[1]).toContain('#2');
    expect(rows[1]).toContain('mid-ts');
    expect(rows[2]).toContain('#1');
    expect(rows[2]).toContain('oldest-ts');
  });
});

describe('LedgerTraceSection 会话汇总口径', () => {
  it('失败数只统计 error；token 合计只统计 ok 且 null 记 0', () => {
    // error 行携带 500/700 的 token 诱饵：若合计误把 error 行算进去，会变成
    // ↑ 600 / ↓ 730；ok 行 null token 钉住「null 行不贡献、不出 NaN 文案」
    // （断言钉输出语义）。?? 0 对 null 运行时冗余（JS 算术 null 归 0，
    // number|null 过 tsc 才需要它），真正防的是 undefined 混入（NaN 唯一来源）
    renderTrace([
      makeCall({ id: 1, startedAt: 3000, promptTokens: 100, completionTokens: 30 }),
      makeCall({ id: 2, startedAt: 2000, promptTokens: null, completionTokens: null }),
      makeCall({
        id: 3,
        startedAt: 1000,
        status: 'error',
        promptTokens: 500,
        completionTokens: 700,
        errorText: 'boom',
      }),
    ]);
    expect(screen.getByText('3 次调用（1 失败） · ↑ 100 tok · ↓ 30 tok')).not.toBeNull();
  });

  it('无失败记录时不追加失败后缀', () => {
    renderTrace([
      makeCall({ id: 1, startedAt: 2000, promptTokens: 40, completionTokens: 20 }),
      makeCall({ id: 2, startedAt: 1000, promptTokens: null, completionTokens: null }),
    ]);
    expect(screen.getByText('2 次调用 · ↑ 40 tok · ↓ 20 tok')).not.toBeNull();
  });

  it('calls 为 null（拉取未落定）不出汇总，渲染空态文案', () => {
    renderTrace(null);
    expect(screen.queryByText(/次调用/)).toBeNull();
    expect(screen.getByText('本会话还没有调用记录')).not.toBeNull();
  });
});

describe('LedgerTraceSection 单行展开互斥', () => {
  it('初始全收起；点开一行显示其详情；点另一行时前一行收起', () => {
    renderTrace([
      makeCall({ id: 1, startedAt: 1000, model: 'model-a', responseText: 'resp-alpha' }),
      makeCall({ id: 2, startedAt: 2000, model: 'model-b', responseText: 'resp-beta' }),
    ]);
    expect(screen.queryByText('resp-alpha')).toBeNull();
    expect(screen.queryByText('resp-beta')).toBeNull();
    expect(rowButton('model-a').getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(rowButton('model-a'));
    expect(screen.getByText('resp-alpha')).not.toBeNull();
    expect(screen.queryByText('resp-beta')).toBeNull();
    expect(rowButton('model-a').getAttribute('aria-expanded')).toBe('true');
    expect(rowButton('model-b').getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(rowButton('model-b'));
    expect(screen.getByText('resp-beta')).not.toBeNull();
    expect(screen.queryByText('resp-alpha')).toBeNull();
    expect(rowButton('model-a').getAttribute('aria-expanded')).toBe('false');
    expect(rowButton('model-b').getAttribute('aria-expanded')).toBe('true');
  });

  it('再次点击已展开行将其收起（toggle 语义）', () => {
    renderTrace([
      makeCall({ id: 1, startedAt: 1000, model: 'model-a', responseText: 'resp-alpha' }),
    ]);
    fireEvent.click(rowButton('model-a'));
    expect(screen.getByText('resp-alpha')).not.toBeNull();
    fireEvent.click(rowButton('model-a'));
    expect(screen.queryByText('resp-alpha')).toBeNull();
    expect(rowButton('model-a').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('LedgerTraceSection sessionId 切换重置展开行', () => {
  it('展开态跨会话无意义：切换 sessionId 后展开行收起', () => {
    // 两会话共用同一 calls 夹具：排除数据变化干扰，收起只能来自 sessionId 重置
    const calls = [
      makeCall({ id: 1, startedAt: 1000, model: 'model-a', responseText: 'resp-alpha' }),
    ];
    const { rerender } = renderTrace(calls, 1);
    fireEvent.click(rowButton('model-a'));
    expect(screen.getByText('resp-alpha')).not.toBeNull();

    rerender(
      <FluentProvider theme={webLightTheme}>
        <LedgerTraceSection sessionId={2} calls={calls} />
      </FluentProvider>,
    );
    expect(screen.queryByText('resp-alpha')).toBeNull();
    expect(rowButton('model-a').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('LedgerTraceSection 防御式解析降级', () => {
  it('promptJson 语法坏（非 JSON）：降级显示原文，不抛错', () => {
    renderTrace([
      makeCall({ id: 1, startedAt: 1000, model: 'model-a', promptJson: 'not-json-at-all' }),
    ]);
    fireEvent.click(rowButton('model-a'));
    expect(screen.getByText('请求消息')).not.toBeNull();
    expect(screen.getByText('not-json-at-all')).not.toBeNull();
  });

  it('promptJson 合法 JSON 但非数组（对象）：降级原文', () => {
    renderTrace([
      makeCall({
        id: 1,
        startedAt: 1000,
        model: 'model-a',
        promptJson: '{"role":"user","content":"hi"}',
      }),
    ]);
    fireEvent.click(rowButton('model-a'));
    expect(screen.getByText('{"role":"user","content":"hi"}')).not.toBeNull();
  });

  it('promptJson 数组元素缺字段（缺 content）：降级原文', () => {
    renderTrace([
      makeCall({ id: 1, startedAt: 1000, model: 'model-a', promptJson: '[{"role":"user"}]' }),
    ]);
    fireEvent.click(rowButton('model-a'));
    expect(screen.getByText('[{"role":"user"}]')).not.toBeNull();
  });

  it('promptJson 数组元素非对象（裸数值）：降级原文', () => {
    renderTrace([makeCall({ id: 1, startedAt: 1000, model: 'model-a', promptJson: '[42]' })]);
    fireEvent.click(rowButton('model-a'));
    expect(screen.getByText('[42]')).not.toBeNull();
  });

  it('toolCallsJson 语法坏（非 JSON）：工具调用段降级原文', () => {
    renderTrace([
      makeCall({ id: 1, startedAt: 1000, model: 'model-a', toolCallsJson: 'broken[' }),
    ]);
    fireEvent.click(rowButton('model-a'));
    expect(screen.getByText('工具调用')).not.toBeNull();
    expect(screen.getByText('broken[')).not.toBeNull();
  });

  it('toolCallsJson 元素缺 arguments 字段：降级原文', () => {
    renderTrace([
      makeCall({ id: 1, startedAt: 1000, model: 'model-a', toolCallsJson: '[{"name":"f"}]' }),
    ]);
    fireEvent.click(rowButton('model-a'));
    expect(screen.getByText('[{"name":"f"}]')).not.toBeNull();
  });
});

describe('LedgerTraceSection 请求段可见性三态与工具调用段省略', () => {
  it('解析成功：渲染 role 标签与内容的列表形态，原文形态不出现', () => {
    const promptJson = JSON.stringify([
      { role: 'system', content: 'sys-prompt-text' },
      { role: 'user', content: 'user-prompt-text' },
    ]);
    renderTrace([makeCall({ id: 1, startedAt: 1000, model: 'model-a', promptJson })]);
    fireEvent.click(rowButton('model-a'));
    expect(screen.getByText('请求消息')).not.toBeNull();
    expect(screen.getByText('system')).not.toBeNull();
    expect(screen.getByText('sys-prompt-text')).not.toBeNull();
    expect(screen.getByText('user-prompt-text')).not.toBeNull();
    // 列表形态意味着不再走原文兜底：整段 JSON 原文不得作为文本出现
    expect(screen.queryByText(promptJson)).toBeNull();
  });

  it('空数组请求：整段省略（空标签块是噪音）', () => {
    renderTrace([makeCall({ id: 1, startedAt: 1000, model: 'model-a', promptJson: '[]' })]);
    fireEvent.click(rowButton('model-a'));
    expect(screen.queryByText('请求消息')).toBeNull();
  });

  it('空串请求：解析失败但原文为空，同样整段省略', () => {
    renderTrace([makeCall({ id: 1, startedAt: 1000, model: 'model-a', promptJson: '' })]);
    fireEvent.click(rowButton('model-a'));
    expect(screen.queryByText('请求消息')).toBeNull();
  });

  it('toolCallsJson 为 null：工具调用段整段省略', () => {
    renderTrace([makeCall({ id: 1, startedAt: 1000, model: 'model-a', toolCallsJson: null })]);
    fireEvent.click(rowButton('model-a'));
    expect(screen.queryByText('工具调用')).toBeNull();
  });

  it('toolCallsJson 有效：渲染每个工具的 name 与 arguments 原文', () => {
    renderTrace([
      makeCall({
        id: 1,
        startedAt: 1000,
        model: 'model-a',
        toolCallsJson: '[{"name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}]',
      }),
    ]);
    fireEvent.click(rowButton('model-a'));
    expect(screen.getByText('工具调用')).not.toBeNull();
    expect(screen.getByText('lookup')).not.toBeNull();
    expect(screen.getByText('{"q":"x"}')).not.toBeNull();
  });
});
