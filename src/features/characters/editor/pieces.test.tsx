// 编辑器共享 UI 件冒烟（pieces.tsx / OverrideSection.tsx）：强调色取色器
// （开合/选色回调/跟随海报/选后面板保持打开/点外部关闭）、模型配置两行
// （模型设置级联菜单/温度行跟随自定义）、预览框（ref 绑定与空态提示）、
// 出场字段（风格标签回显/播放回调）。人设 markdown 预览盒已下沉
// components/MarkdownPreviewBox（测试随组件走）。i18n 固定中文，断言 zh 文案。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelSpecDto, ProviderDto } from '../../../api/types';
import '../../../i18n';
import { AccentColorPicker } from './AccentColorPicker';
import { PerformanceField, PreviewBox } from './pieces';
import { OverrideSection } from './OverrideSection';

function renderUi(node: ReactNode) {
  return render(<FluentProvider theme={webLightTheme}>{node}</FluentProvider>);
}

/** 模型元数据夹具：id 之外取缺省（1M 上下文 / 128K 输出 / 仅文本）。 */
const spec = (id: string): ModelSpecDto => ({
  id,
  contextWindow: 1000000,
  maxOutputTokens: 128000,
  inputTypes: ['text'],
  outputTypes: ['text'],
});

const PROVIDERS: ProviderDto[] = [
  { id: 'p1', name: '主服务', baseUrl: 'https://api.test/v1', apiKey: '', models: [spec('m1'), spec('m2')], api: 'openai' },
  { id: 'p2', name: '备用', baseUrl: 'https://api.test/v2', apiKey: '', models: [spec('m3')], api: 'openai' },
];

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

describe('OverrideSection（模型设置级联行 + 温度行）', () => {
  // 全局默认 = 主服务 / m1（跟随态按钮展示值 + 切自定义的写卡落点）。
  const GLOBAL = {
    globalProviderId: 'p1',
    globalModelId: 'm1',
    globalTemperature: 0.7,
    globalTopP: 1.0,
    globalFrequencyPenalty: 0,
    globalPresencePenalty: 0,
  };

  /** 跟随态基线：模型覆写三扁平字段全空（空串/null = 跟随全局）。 */
  const FOLLOW = {
    modelProviderId: '',
    modelName: '',
    modelTemperature: null,
    modelTopP: null,
    modelFrequencyPenalty: null,
    modelPresencePenalty: null,
    onTopPChange: vi.fn(),
    onFrequencyPenaltyChange: vi.fn(),
    onPresencePenaltyChange: vi.fn(),
  };

  /** 点开模型设置的级联菜单（触发钮 aria-label = 模型设置；仅自定义态可用）。 */
  function openModelMenu() {
    fireEvent.click(screen.getByRole('button', { name: /模型设置/ }));
  }

  /** 切到自定义模式（分段 radio）。 */
  function switchCustom() {
    const group = screen.getByRole('radiogroup', { name: /模型设置/ });
    fireEvent.click(
      [...group.querySelectorAll('[role="radio"]')].find((r) => r.textContent === '自定义')!,
    );
  }

  it('跟随态：级联钮禁用并展示全局默认，分段停在跟随', () => {
    renderUi(
      <OverrideSection
        {...FOLLOW}
        onModelOverrideChange={vi.fn()}
        onTemperatureChange={vi.fn()}
        providers={PROVIDERS}
        {...GLOBAL}
      />,
    );
    const trigger = screen.getByRole('button', { name: /模型设置/ });
    expect(trigger).toHaveProperty('disabled', true);
    expect(trigger.textContent).toContain('主服务 / m1');
    const group = screen.getByRole('radiogroup', { name: /模型设置/ });
    expect(
      group.querySelector('[role="radio"][aria-checked="true"]')?.textContent,
    ).toContain('跟随全局');
  });

  it('切自定义：以当前展示值（全局默认）成对写卡', () => {
    const onModelOverrideChange = vi.fn();
    renderUi(
      <OverrideSection
        {...FOLLOW}
        onModelOverrideChange={onModelOverrideChange}
        onTemperatureChange={vi.fn()}
        providers={PROVIDERS}
        {...GLOBAL}
      />,
    );
    switchCustom();
    expect(onModelOverrideChange).toHaveBeenCalledTimes(1);
    expect(onModelOverrideChange).toHaveBeenCalledWith('p1', 'm1');
  });

  it('自定义态：级联钮启用并显示覆写值；存量模型不在服务列表时追加为额外叶子', () => {
    renderUi(
      <OverrideSection
        modelProviderId="p1"
        modelName="legacy-model"
        modelTemperature={null}
        modelTopP={null}
        modelFrequencyPenalty={null}
        modelPresencePenalty={null}
        onTopPChange={vi.fn()}
        onFrequencyPenaltyChange={vi.fn()}
        onPresencePenaltyChange={vi.fn()}
        onModelOverrideChange={vi.fn()}
        onTemperatureChange={vi.fn()}
        providers={PROVIDERS}
        {...GLOBAL}
      />,
    );
    const trigger = screen.getByRole('button', { name: /模型设置/ });
    expect(trigger).toHaveProperty('disabled', false);
    expect(trigger.textContent).toContain('主服务 / legacy-model');
    openModelMenu();
    fireEvent.click(screen.getByRole('option', { name: '主服务' }));
    const withChildren = screen.getAllByRole('option').map((o) => o.textContent);
    // 二级叶子显裸名（服务名在父行上，前缀冗余）；触发钮才组合「服务 / 叶」
    expect(withChildren).toContain('legacy-model');
    expect(withChildren).toContain('m1');
    expect(withChildren).toContain('m2');
    // 「默认模型」叶子已删（2026-09-15 用户裁定）：覆写必指名具体模型
    expect(withChildren).not.toContain('默认模型');
    // 其它服务的模型不混入主服务的子菜单
    expect(withChildren).not.toContain('m3');
  });

  it('自定义态选叶子：成对上报所选服务与模型', () => {
    const onModelOverrideChange = vi.fn();
    renderUi(
      <OverrideSection
        modelProviderId="p1"
        modelName="m1"
        modelTemperature={null}
        modelTopP={null}
        modelFrequencyPenalty={null}
        modelPresencePenalty={null}
        onTopPChange={vi.fn()}
        onFrequencyPenaltyChange={vi.fn()}
        onPresencePenaltyChange={vi.fn()}
        onModelOverrideChange={onModelOverrideChange}
        onTemperatureChange={vi.fn()}
        providers={PROVIDERS}
        {...GLOBAL}
      />,
    );
    openModelMenu();
    fireEvent.click(screen.getByRole('option', { name: '备用' }));
    fireEvent.click(screen.getByRole('option', { name: 'm3' }));
    expect(onModelOverrideChange).toHaveBeenCalledTimes(1);
    expect(onModelOverrideChange).toHaveBeenCalledWith('p2', 'm3');
  });

  it('切回跟随：上报清空二元组，温度覆写不动（菜单内无跟随叶子）', () => {
    const onModelOverrideChange = vi.fn();
    const onTemperatureChange = vi.fn();
    renderUi(
      <OverrideSection
        modelProviderId="p1"
        modelName="m1"
        modelTemperature={1.2}
        modelTopP={null}
        modelFrequencyPenalty={null}
        modelPresencePenalty={null}
        onTopPChange={vi.fn()}
        onFrequencyPenaltyChange={vi.fn()}
        onPresencePenaltyChange={vi.fn()}
        onModelOverrideChange={onModelOverrideChange}
        onTemperatureChange={onTemperatureChange}
        providers={PROVIDERS}
        {...GLOBAL}
      />,
    );
    openModelMenu();
    // 菜单里没有「跟随全局」叶子：跟随语义由分段托管
    expect(screen.getByRole('option', { name: '主服务' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: '跟随全局' })).toBeNull();
    const group = screen.getByRole('radiogroup', { name: /模型设置/ });
    fireEvent.click(
      [...group.querySelectorAll('[role="radio"]')].find((r) => r.textContent === '跟随全局')!,
    );
    expect(onModelOverrideChange).toHaveBeenCalledWith('', '');
    expect(onTemperatureChange).not.toHaveBeenCalled();
  });

  it('温度行：跟随态滑杆禁用、描述带全局值；切自定义即以当前展示值写卡', () => {
    const onTemperatureChange = vi.fn();
    renderUi(
      <OverrideSection
        {...FOLLOW}
        onModelOverrideChange={vi.fn()}
        onTemperatureChange={onTemperatureChange}
        providers={PROVIDERS}
        {...GLOBAL}
      />,
    );
    const slider = screen.getByRole('slider', { name: '温度' });
    expect(slider).toHaveProperty('disabled', true);
    expect(screen.getByText('跟随全局 · 当前 0.7')).toBeTruthy();
    const group = screen.getByRole('radiogroup', { name: '温度' });
    fireEvent.click(
      [...group.querySelectorAll('[role="radio"]')].find((r) => r.textContent === '自定义')!,
    );
    expect(onTemperatureChange).toHaveBeenCalledTimes(1);
    expect(onTemperatureChange).toHaveBeenCalledWith(0.7);
  });

  it('采样参数三行（2026-09-16）：跟随态滑杆禁用显全局值，切自定义写当前展示值', () => {
    const onTopPChange = vi.fn();
    const onFrequencyPenaltyChange = vi.fn();
    renderUi(
      <OverrideSection
        {...FOLLOW}
        onTopPChange={onTopPChange}
        onFrequencyPenaltyChange={onFrequencyPenaltyChange}
        onModelOverrideChange={vi.fn()}
        onTemperatureChange={vi.fn()}
        providers={PROVIDERS}
        {...GLOBAL}
      />,
    );
    // top_p：跟随态滑杆禁用，描述显全局值（1.00 两位小数档）。
    expect(screen.getByRole('slider', { name: '核采样' })).toHaveProperty('disabled', true);
    expect(screen.getByText('跟随全局 · 当前 1.00')).toBeTruthy();
    const group = screen.getByRole('radiogroup', { name: '核采样' });
    fireEvent.click(
      [...group.querySelectorAll('[role="radio"]')].find((r) => r.textContent === '自定义')!,
    );
    expect(onTopPChange).toHaveBeenCalledTimes(1);
    expect(onTopPChange).toHaveBeenCalledWith(1.0);
    // 频率 / 存在惩罚行渲染且默认跟随（全局 0 的一位小数档，两行同文案）。
    expect(screen.getByRole('slider', { name: '频率惩罚' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('slider', { name: '存在惩罚' })).toHaveProperty('disabled', true);
    expect(screen.getAllByText('跟随全局 · 当前 0.0')).toHaveLength(2);
  });

  it('采样参数自定义态：滑杆启用显覆写值，拖动上报新值', () => {
    const onTopPChange = vi.fn();
    renderUi(
      <OverrideSection
        {...FOLLOW}
        modelTopP={0.9}
        onTopPChange={onTopPChange}
        onModelOverrideChange={vi.fn()}
        onTemperatureChange={vi.fn()}
        providers={PROVIDERS}
        {...GLOBAL}
      />,
    );
    const slider = screen.getByRole('slider', { name: '核采样' });
    expect(slider).toHaveProperty('disabled', false);
    expect(screen.getByText('自定义 · 当前 0.90')).toBeTruthy();
    fireEvent.change(slider, { target: { value: '0.85' } });
    expect(onTopPChange).toHaveBeenCalledWith(0.85);
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
