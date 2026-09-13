// ledgerPanel 面板壳结构守卫：StateBlock 包装容器（stateWrap）的 flex 形态。
// 回归背景（首轮 CAND-01）：StateBlock root 是 height:100% 的页面级垂直居中块，
// Task-07 迁移后与 sticky 头部同列为本面板（height:100% + overflowY:auto 的
// flex 列）的子项——root 参照整面板高，连同头部总高超出，loading / error 态下
// 面板多余滚动且 StateBlock 底部被裁切；修法照抄 useSidebarStyles stateWrap
// 先例（互指见 ledgerPanel stateWrap 注释）。
// 验证方式：jsdom 无布局引擎，getComputedStyle 拿不到 Griffel 产物——沿用
// useGhostIconButtonStyles.test 的样式表扫描思路：渲染面板后从包装容器类名
// 反查 Griffel 注入的真实样式规则，断言 flex 与 min-height 声明在位。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../i18n';
import { LedgerPanel } from './ledgerPanel';

const mocks = vi.hoisted(() => ({
  forkSession: vi.fn(),
  listScenes: vi.fn(),
  listCharacterStates: vi.fn(),
  listLlmCalls: vi.fn(),
  subscribeStream: vi.fn(() => () => {}),
  subscribeTraces: vi.fn(() => () => {}),
}));

vi.mock('../../api/commands', () => ({
  forkSession: mocks.forkSession,
  listScenes: mocks.listScenes,
  listCharacterStates: mocks.listCharacterStates,
  listLlmCalls: mocks.listLlmCalls,
}));

vi.mock('../../api/events', () => ({
  subscribeStream: mocks.subscribeStream,
  subscribeTraces: mocks.subscribeTraces,
}));

function renderPanel() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <LedgerPanel sessionId={3} />
    </FluentProvider>,
  );
}

/** 从元素类名反查文档样式表中的 Griffel 规则（原子类一一对应）。 */
function collectElementRules(el: Element): CSSStyleRule[] {
  const classes = el.className.split(/\s+/).filter(Boolean);
  const rules: CSSStyleRule[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      const style = rule as CSSStyleRule;
      if (style.selectorText !== undefined && classes.some((c) => style.selectorText.startsWith(`.${c}`))) {
        rules.push(style);
      }
    }
  }
  return rules;
}

/** 结构断言本体（两态共用）：包装容器是面板直接 flex 子项，携带 flex:1 + minHeight:0。 */
function expectStateWrapShape(wrap: HTMLElement | null | undefined): void {
  // 直接作面板（aside#ledger-panel）的 flex 子项——中间不得再隔层级
  expect(wrap?.parentElement?.id).toBe('ledger-panel');
  const rules = collectElementRules(wrap as HTMLElement);
  // jsdom 把 flex 简写规范化为 '1 1 0%'，断言吃剩余高的语义本体 flex-grow
  expect(
    rules.some((r) => r.style.flexGrow === '1'),
    '包装容器应有 flex-grow:1（吃掉头部以下剩余高）',
  ).toBe(true);
  expect(
    rules.some((r) => r.style.getPropertyValue('min-height') === '0px'),
    '包装容器应有 minHeight:0（可压缩到实际剩余高，flex 子项 min-height:auto 防溢出前提）',
  ).toBe(true);
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('ledgerPanel StateBlock 包装容器（flex 滚动栏回归守卫）', () => {
  it('加载态：StateBlock 根的直接父容器携带 flex:1 + minHeight:0，不作参照整面板高的子项', () => {
    // 永不 resolve 的拉取：面板停在加载态，StateBlock 同步可见
    mocks.listScenes.mockReturnValue(new Promise(() => {}));
    mocks.listCharacterStates.mockReturnValue(new Promise(() => {}));
    mocks.listLlmCalls.mockReturnValue(new Promise(() => {}));
    renderPanel();
    // 文案（Text span）→ StateBlock root（height:100% 垂直居中块）→ 包装容器
    const wrap = screen.getByText('加载中…').parentElement?.parentElement;
    expect(wrap?.tagName).toBe('DIV');
    expectStateWrapShape(wrap);
  });

  it('错误态：StateBlock（role="alert"）同样经携带 flex:1 + minHeight:0 的容器包装', async () => {
    mocks.listScenes.mockRejectedValue(new Error('db down'));
    mocks.listCharacterStates.mockResolvedValue([]);
    mocks.listLlmCalls.mockResolvedValue([]);
    renderPanel();
    // error 态容器自带 role="alert"，即 StateBlock root，上一层即包装容器
    const wrap = (await screen.findByRole('alert')).parentElement;
    expectStateWrapShape(wrap);
  });
});
