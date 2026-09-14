// 编辑器共享 UI 件冒烟（pieces.tsx）：强调色取色器（开合/选色回调/跟随海报/
// 选后面板保持打开/点外部关闭）、模型覆写折叠段（开合/遗留模型追加选项/选择
// 回调）、人设 markdown 预览（引擎直插 DOM、空态提示开关）、预览框（ref 绑定
// 与空态提示）、出场字段（风格标签回显/播放回调）。i18n 固定中文，断言 zh 文案。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDto } from '../../../api/types';
import '../../../i18n';
import { AccentColorPicker } from './AccentColorPicker';
import {
  OverrideSection,
  PerformanceField,
  PersonaPreviewBox,
  PreviewBox,
} from './pieces';
import type { ModelOverrideFields } from './useEditorForm';

function renderUi(node: ReactNode) {
  return render(<FluentProvider theme={webLightTheme}>{node}</FluentProvider>);
}

const PROVIDERS: ProviderDto[] = [
  { id: 'p1', name: '主服务', baseUrl: 'https://api.test/v1', apiKey: '', models: ['m1', 'm2'] },
  { id: 'p2', name: '备用', baseUrl: 'https://api.test/v2', apiKey: '', models: ['m3'] },
];

const EMPTY_OVERRIDE: ModelOverrideFields = {
  providerId: '',
  model: '',
  baseUrl: '',
  apiKey: '',
  rest: {},
};

afterEach(cleanup);

describe('AccentColorPicker（Office 风格取色器）', () => {
  it('收起态：触发钮存在且未展开，色块显示基础色（跟随海报派生）', () => {
    renderUi(<AccentColorPicker accentColor={null} baseColor="#6b46b8" onChange={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: '强调色' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('跟随海报')).toBeNull();
    const chip = trigger.querySelector('span');
    expect(chip?.style.backgroundColor).toBe('rgb(107, 70, 184)'); // #6b46b8
  });

  it('展开后可选「跟随海报」回调 null，选色后面板保持打开（连续试色定稿）', () => {
    const onChange = vi.fn();
    renderUi(<AccentColorPicker accentColor={null} baseColor="#6b46b8" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '强调色' }));
    expect(screen.getByRole('button', { name: '强调色' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('主题颜色')).toBeTruthy();
    expect(screen.getByText('标准颜色')).toBeTruthy();

    fireEvent.click(screen.getByText('跟随海报'));
    expect(onChange).toHaveBeenCalledWith(null);
    // 面板保持打开，可继续换色
    expect(screen.getByText('主题颜色')).toBeTruthy();

    // 标准色行色块（aria-label = 色值）
    fireEvent.click(screen.getByRole('button', { name: '#c00000' }));
    expect(onChange).toHaveBeenCalledWith('#c00000');
    expect(screen.getByText('主题颜色')).toBeTruthy();
  });

  it('点外部即关（pointerdown 捕获）', () => {
    renderUi(<AccentColorPicker accentColor={null} baseColor="#6b46b8" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '强调色' }));
    expect(screen.getByText('跟随海报')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByText('跟随海报')).toBeNull();
    expect(screen.getByRole('button', { name: '强调色' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('已有强调色：色块显示显式色，对应色块标记选中态', () => {
    renderUi(<AccentColorPicker accentColor="#c00000" baseColor="#6b46b8" onChange={vi.fn()} />);
    const chip = screen.getByRole('button', { name: '强调色' }).querySelector('span');
    expect(chip?.style.backgroundColor).toBe('rgb(192, 0, 0)');
    fireEvent.click(screen.getByRole('button', { name: '强调色' }));
    expect(
      screen.getByRole('button', { name: '#c00000' }).getAttribute('aria-pressed'),
    ).toBe('true');
    // 未选中的色块不带选中标记
    expect(
      screen.getByRole('button', { name: '#ff0000' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });
});

describe('OverrideSection（模型覆写折叠段）', () => {
  it('收起态：字段不渲染，点标题触发开合回调', () => {
    const onToggle = vi.fn();
    renderUi(
      <OverrideSection
        open={false}
        onToggle={onToggle}
        override={EMPTY_OVERRIDE}
        onOverrideChange={vi.fn()}
        providers={PROVIDERS}
      />,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    const toggle = screen.getByRole('button', { name: /模型覆写/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('展开态：服务/模型下拉齐全，空覆写显示「跟随全局」', () => {
    renderUi(
      <OverrideSection
        open
        onToggle={vi.fn()}
        override={EMPTY_OVERRIDE}
        onOverrideChange={vi.fn()}
        providers={PROVIDERS}
      />,
    );
    const combos = screen.getAllByRole('combobox');
    expect(combos).toHaveLength(2);
    expect(combos[0]!.textContent).toContain('跟随全局');
    expect(combos[1]!.textContent).toContain('跟随全局');
  });

  it('存量覆写的模型不在所选服务列表：追加为额外选项（不显示成跟随全局）', () => {
    renderUi(
      <OverrideSection
        open
        onToggle={vi.fn()}
        override={{ ...EMPTY_OVERRIDE, providerId: 'p1', model: 'legacy-model' }}
        onOverrideChange={vi.fn()}
        providers={PROVIDERS}
      />,
    );
    const combos = screen.getAllByRole('combobox');
    expect(combos[0]!.textContent).toContain('主服务');
    expect(combos[1]!.textContent).toContain('legacy-model');
    fireEvent.click(combos[1]!);
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('跟随全局');
    expect(options).toContain('legacy-model');
    expect(options).toContain('m1');
    expect(options).toContain('m2');
    // 其它服务的模型不混入
    expect(options).not.toContain('m3');
  });

  it('选服务：onOverrideChange 收到函数式更新，应用后写入 providerId', () => {
    const onOverrideChange = vi.fn();
    renderUi(
      <OverrideSection
        open
        onToggle={vi.fn()}
        override={EMPTY_OVERRIDE}
        onOverrideChange={onOverrideChange}
        providers={PROVIDERS}
      />,
    );
    fireEvent.click(screen.getAllByRole('combobox')[0]!);
    fireEvent.click(screen.getByRole('option', { name: /备用/ }));
    expect(onOverrideChange).toHaveBeenCalledTimes(1);
    const updater = onOverrideChange.mock.calls[0]![0] as (
      current: ModelOverrideFields,
    ) => ModelOverrideFields;
    expect(updater(EMPTY_OVERRIDE).providerId).toBe('p2');
  });
});

describe('PersonaPreviewBox（人设展示态）', () => {
  it('markdown 直插 DOM：加粗产出 tok.bold，正文上屏', () => {
    renderUi(<PersonaPreviewBox text="**加粗**冷句" />);
    const box = document.querySelector('[data-persona-preview]');
    expect(box).toBeTruthy();
    expect(box!.querySelector('.tok.bold')?.textContent).toBe('加粗');
    expect(box!.textContent).toContain('冷句');
  });

  it('场景线挖空底按所在表面注入：容器行内 --cv-scene-line-bg = 主题 bg1（展示态落在 DialogSurface）', () => {
    renderUi(<PersonaPreviewBox text={'前情\n\n---\n\n后续'} />);
    const box = document.querySelector<HTMLElement>('[data-persona-preview]')!;
    // 注入的是 Fluent 主题变量引用（tokens.* 即 var(...)，FluentProvider 按主题
    // 解析，同聊天侧 engineThemeVars）：指向 bg1 而非 bg2 才是与所在表面同色
    expect(box.style.getPropertyValue('--cv-scene-line-bg')).toBe(
      'var(--colorNeutralBackground1)',
    );
    // 两表面在主题里确为异色（引用指错表面即出异色矩形，此断言保证上述契约有效）
    expect(webLightTheme.colorNeutralBackground1).not.toBe(
      webLightTheme.colorNeutralBackground2,
    );
    // 含 --- 的人设渲染不回归：静态渲染与聊天同语法语义，场景线仍产出 hr.scene
    expect(box.querySelectorAll('hr.scene')).toHaveLength(1);
    expect(box.textContent).not.toContain('---');
  });

  it('文本变化即整容器重渲染', () => {
    const { rerender } = renderUi(<PersonaPreviewBox text="第一版" />);
    expect(document.querySelector('[data-persona-preview]')!.textContent).toContain('第一版');
    rerender(
      <FluentProvider theme={webLightTheme}>
        <PersonaPreviewBox text="第二版" />
      </FluentProvider>,
    );
    const box = document.querySelector('[data-persona-preview]')!;
    expect(box.textContent).toContain('第二版');
    expect(box.textContent).not.toContain('第一版');
  });

  it('空文本默认出占位提示；showHint=false 不出（编辑态 textarea 已有 placeholder）', () => {
    const { rerender } = renderUi(<PersonaPreviewBox text="   " />);
    expect(screen.getByText('这个角色是谁？说话习惯、背景、底线……')).toBeTruthy();
    rerender(
      <FluentProvider theme={webLightTheme}>
        <PersonaPreviewBox text="" showHint={false} />
      </FluentProvider>,
    );
    expect(screen.queryByText('这个角色是谁？说话习惯、背景、底线……')).toBeNull();
  });
});

describe('PreviewBox（预览动画容器）', () => {
  it('挂载即回传容器节点；未播过出空态提示，播过后隐藏', () => {
    const previewRef = vi.fn();
    const { rerender } = renderUi(<PreviewBox previewRef={previewRef} previewed={false} />);
    expect(previewRef).toHaveBeenCalledTimes(1);
    expect(previewRef.mock.calls[0]![0]).toBeInstanceOf(HTMLDivElement);
    expect(screen.getByText('点击「预览动画」，在这里试播样例文本')).toBeTruthy();
    rerender(
      <FluentProvider theme={webLightTheme}>
        <PreviewBox previewRef={previewRef} previewed />
      </FluentProvider>,
    );
    expect(screen.queryByText('点击「预览动画」，在这里试播样例文本')).toBeNull();
  });

  it('场景线挖空底按框表面注入：容器行内 --cv-scene-line-bg = 主题 bg2（preview 框显式 bg2 底）', () => {
    // 实现签名给出 mock.calls 元素类型；回调闭包赋值不参与 TS 控制流分析，
    // 走 mock.calls 取节点避免 never 收窄
    const previewRef = vi.fn((_node: HTMLDivElement | null) => {});
    renderUi(<PreviewBox previewRef={previewRef} previewed={false} />);
    const node = previewRef.mock.calls[0]![0];
    expect(node).toBeInstanceOf(HTMLDivElement);
    // 主题变量引用（同上），指向 preview 框显式声明的 bg2 表面
    expect(node?.style.getPropertyValue('--cv-scene-line-bg')).toBe(
      'var(--colorNeutralBackground2)',
    );
  });
});

describe('PerformanceField（出场演出字段）', () => {
  it('合法风格回显中文标签；点「预览动画」上报 onPlay', () => {
    const onPlay = vi.fn();
    renderUi(
      <PerformanceField
        renderStyle="ink"
        globalStyle="type"
        onStyleChange={vi.fn()}
        onPlay={onPlay}
        previewRef={vi.fn()}
        previewed={false}
      />,
    );
    // 2026-09-14 风格下拉换自绘复刻件 DropdownPushButton：触发钮是普通
    // button（aria-label 动画样式），不再是 Fluent combobox
    expect(screen.getByRole('button', { name: '动画样式' }).textContent).toContain('墨晕沉淀');
    fireEvent.click(screen.getByRole('button', { name: '预览动画' }));
    expect(onPlay).toHaveBeenCalledTimes(1);
    // 内嵌预览框空态提示在位
    expect(screen.getByText('点击「预览动画」，在这里试播样例文本')).toBeTruthy();
  });

  it('表外遗留风格串：下拉原样回显原始串（不猜别名）', () => {
    renderUi(
      <PerformanceField
        renderStyle="typewriter"
        globalStyle="type"
        onStyleChange={vi.fn()}
        onPlay={vi.fn()}
        previewRef={vi.fn()}
        previewed={false}
      />,
    );
    expect(screen.getByRole('button', { name: '动画样式' }).textContent).toContain('typewriter');
  });
});
