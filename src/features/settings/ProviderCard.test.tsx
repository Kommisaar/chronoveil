// ProviderCard 单测：① 模型行删除确认（U4）——唯一模型 / 全局默认模型的高危行
// 删除须经 ConfirmDialog 拦截（防抖 600ms 自动落盘下，误触会静默丢配置），
// 普通行直接删保持轻快；② 兼容方式（三协议）——下拉三档全显、选择上报对应
// api 值且不重置其他字段、Base URL 占位示例随协议自适应。组件纯展示件，经
// props 回调断言意图上报；占位随协议切换用状态化壳回灌 provider prop 模拟父级
// draft 回流（协议切换不清配置的契约由整对象相等断言覆盖）。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDto } from '../../api/types';
import '../../i18n';
import { ProviderCard } from './ProviderCard';

const baseProvider: ProviderDto = {
  id: 'p1',
  name: '本地中转',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  models: ['keep', 'gone'],
  api: 'openai',
};

type Setup = Partial<Parameters<typeof ProviderCard>[0]>;

function setup(overrides: Setup = {}) {
  const onRemoveModel = vi.fn();
  const onChange = vi.fn();
  render(
    <FluentProvider theme={webLightTheme}>
      <ProviderCard
        provider={baseProvider}
        isActiveProvider={false}
        activeModel={null}
        onChange={onChange}
        onActivateModel={() => {}}
        onRemoveModel={onRemoveModel}
        onDelete={() => {}}
        {...overrides}
      />
    </FluentProvider>,
  );
  return { onRemoveModel, onChange };
}

const rowDeleteButton = (model: string): HTMLElement =>
  screen.getByRole('button', { name: `删除模型 ${model}` });

afterEach(cleanup);

/** 状态化壳：onChange 回灌 provider prop，模拟父级 draft 流，断言切协议后
 *  占位示例等派生 UI 的实际变化（纯 spy 不会重渲染组件）。 */
function setupStateful(initial: ProviderDto = baseProvider) {
  const onChange = vi.fn();
  function Harness() {
    const [provider, setProvider] = useState(initial);
    return (
      <FluentProvider theme={webLightTheme}>
        <ProviderCard
          provider={provider}
          isActiveProvider={false}
          activeModel={null}
          onChange={(next) => {
            onChange(next);
            setProvider(next);
          }}
          onActivateModel={() => {}}
          onRemoveModel={() => {}}
          onDelete={() => {}}
        />
      </FluentProvider>
    );
  }
  render(<Harness />);
  return { onChange };
}

const protocolTrigger = (): HTMLElement =>
  screen.getByRole('button', { name: 'p1-protocol' });

describe('ProviderCard 模型行删除确认（U4）', () => {
  it('唯一模型行删除弹确认：取消不落 draft（onRemoveModel 不触发），确认后才删', async () => {
    const { onRemoveModel } = setup({
      provider: { ...baseProvider, models: ['only-model'] },
    });
    fireEvent.click(rowDeleteButton('only-model'));
    // 确认文案指明删除对象与立即生效语义
    expect(await screen.findByText(/确定删除模型「only-model」？/)).toBeTruthy();

    // 取消：意图不上报，draft 无改动（onRemoveModel 未触发）
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByText(/确定删除模型「only-model」？/)).toBeNull(),
    );
    expect(onRemoveModel).not.toHaveBeenCalled();

    // 确认：删除落地
    fireEvent.click(rowDeleteButton('only-model'));
    fireEvent.click(await screen.findByRole('button', { name: '删除模型' }));
    expect(onRemoveModel).toHaveBeenCalledWith(0);
  });

  it('全局默认模型行删除弹确认，确认后上报删除', async () => {
    const { onRemoveModel } = setup({ isActiveProvider: true, activeModel: 'gone' });
    fireEvent.click(rowDeleteButton('gone'));
    expect(await screen.findByText(/确定删除模型「gone」？/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除模型' }));
    expect(onRemoveModel).toHaveBeenCalledWith(1);
  });

  it('普通行（非唯一、非全局默认）直接删除，不弹确认保持轻快', () => {
    const { onRemoveModel } = setup({ isActiveProvider: true, activeModel: 'gone' });
    fireEvent.click(rowDeleteButton('keep'));
    expect(onRemoveModel).toHaveBeenCalledWith(0);
    expect(screen.queryByText(/确定删除模型/)).toBeNull();
  });
});

describe('ProviderCard 兼容方式（三协议选择）', () => {
  it('触发钮显示当前协议文案；打开三档全显；选择上报对应 api 值且不重置其他字段', () => {
    const { onChange } = setup();
    expect(protocolTrigger().textContent).toContain('OpenAI 兼容');

    fireEvent.click(protocolTrigger());
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'OpenAI 兼容',
      'Anthropic',
      'OpenAI Responses',
    ]);

    fireEvent.click(screen.getByRole('option', { name: 'Anthropic' }));
    // 整对象相等 = 只改 api，baseUrl / apiKey / models 原样保留（切协议不动已填配置）
    expect(onChange).toHaveBeenCalledWith({ ...baseProvider, api: 'anthropic' });
  });

  it('Base URL 占位示例随协议自适应：openai 默认不变，切档后换成对应示例', () => {
    const { onChange } = setupStateful();
    // 默认 openai：占位与历史行为一致
    expect(screen.getByPlaceholderText('https://api.example.com/v1')).toBeTruthy();

    fireEvent.click(protocolTrigger());
    fireEvent.click(screen.getByRole('option', { name: 'Anthropic' }));
    expect(onChange).toHaveBeenCalledWith({ ...baseProvider, api: 'anthropic' });
    expect(screen.getByPlaceholderText('https://api.anthropic.com')).toBeTruthy();

    // 连切 OpenAI Responses：占位换成 /v1 示例（退场动效未卸载时再开即重置为 open）
    fireEvent.click(protocolTrigger());
    fireEvent.click(screen.getByRole('option', { name: 'OpenAI Responses' }));
    expect(screen.getByPlaceholderText('https://api.openai.com/v1')).toBeTruthy();
  });
});
