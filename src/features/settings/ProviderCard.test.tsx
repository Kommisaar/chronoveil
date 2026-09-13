// ProviderCard 模型行删除确认（U4）单测：唯一模型 / 全局默认模型的高危行
// 删除须经 ConfirmDialog 拦截（防抖 600ms 自动落盘下，误触会静默丢配置），
// 普通行直接删保持轻快。组件纯展示件，经 props 回调断言意图上报。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
