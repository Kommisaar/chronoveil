// 设置视图交互单测（TASK-009）：jsdom 下 isTauri=false，走 mock 后端
// （内存 config，跨用例共享 → 每个用例 beforeEach 重置基线）。
// 覆盖：空态引导、providers 新建/校验/保存落盘（directorModel 保留）、
// api_key 掩码切换、激活删除拦截、非激活删除、保存后主题/语言即时生效。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfig, saveConfig } from '../../api/commands';
import { DEFAULT_CONFIG } from '../../api/mock/backend';
import type { ConfigDto, ProviderDto } from '../../api/types';
import { useUiStore } from '../../stores/ui';
import { SettingsView } from './SettingsView';
import '../../i18n';

function renderSettings() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <SettingsView />
    </FluentProvider>,
  );
}

const fullProvider = (partial: Partial<ProviderDto>): ProviderDto => ({
  id: 'p1',
  name: '本地中转',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  ...partial,
});

const seedConfig = (partial: Partial<ConfigDto>): ConfigDto => ({
  ...DEFAULT_CONFIG,
  directorModel: 'director-keep',
  ...partial,
});

const saveButton = () => screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;

describe('SettingsView（TASK-009）', () => {
  beforeEach(async () => {
    await saveConfig(seedConfig({}));
  });
  afterEach(cleanup);

  it('验收 7：无 provider 时表单区引导新建', async () => {
    renderSettings();
    expect(await screen.findByText(/还没有模型服务/)).toBeTruthy();
    // 空态内也有新建入口
    expect(screen.getAllByRole('button', { name: '新建' }).length).toBeGreaterThan(0);
  });

  it('验收 2/5/6：新建 provider → 校验禁保存 → 填齐后保存落盘，directorModel 原样保留', async () => {
    renderSettings();
    await screen.findByText(/还没有模型服务/);
    fireEvent.click(screen.getAllByRole('button', { name: '新建' })[0]!);

    // 未填齐：卡片级校验提示 + 保存禁用
    expect(await screen.findByText(/名称为必填/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(await screen.findByLabelText(/-name$/), { target: { value: '主服务' } });
    fireEvent.change(screen.getByLabelText(/-baseUrl$/), {
      target: { value: 'https://api.test/v1' },
    });
    fireEvent.change(screen.getByLabelText(/-model$/), { target: { value: 'gpt-x' } });

    // 脏状态标记
    expect(await screen.findByText('未保存')).toBeTruthy();
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());

    await waitFor(async () => {
      const saved = await getConfig();
      expect(saved.providers).toHaveLength(1);
      expect(saved.providers[0]!.name).toBe('主服务');
      expect(saved.providers[0]!.model).toBe('gpt-x');
      // 不呈现的字段整份带回（saveConfig 整份覆写不丢字段）
      expect(saved.directorModel).toBe('director-keep');
    });
    // 保存后脏标记消失
    await waitFor(() => expect(screen.queryByText('未保存')).toBeNull());
  });

  it('验收 2：api_key 默认掩码，可见性切换', async () => {
    await saveConfig(seedConfig({ providers: [fullProvider({})] }));
    renderSettings();
    const keyInput = (await screen.findByLabelText(/-apiKey$/)) as HTMLInputElement;
    expect(keyInput.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: '显示 API Key' }));
    expect((screen.getByLabelText(/-apiKey$/) as HTMLInputElement).type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: '隐藏 API Key' }));
    expect((screen.getByLabelText(/-apiKey$/) as HTMLInputElement).type).toBe('password');
  });

  it('验收 2：删除激活中的 provider 被拦截，要求先转移激活', async () => {
    await saveConfig(
      seedConfig({ providers: [fullProvider({})], activeProviderId: 'p1' }),
    );
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: '删除 本地中转' }));
    expect(await screen.findByText(/请先把「设为默认」转移到其他服务/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: '删除' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('验收 2：非激活 provider 经确认对话框删除（草稿级，保存后落盘）', async () => {
    await saveConfig(
      seedConfig({
        providers: [fullProvider({}), fullProvider({ id: 'p2', name: '备用' })],
        activeProviderId: 'p1',
      }),
    );
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: '删除 备用' }));
    const confirm = await screen.findByRole('button', { name: '删除' });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getAllByLabelText(/-name$/)).toHaveLength(1));
    // 草稿级删除：未保存前落盘值不变
    const onDisk = await getConfig();
    expect(onDisk.providers).toHaveLength(2);
  });

  it('验收 2：激活单选切换，保存后 active_provider_id 落盘', async () => {
    await saveConfig(
      seedConfig({
        providers: [fullProvider({}), fullProvider({ id: 'p2', name: '备用' })],
        activeProviderId: 'p1',
      }),
    );
    renderSettings();
    const radios = await screen.findAllByRole('radio', { name: '设为默认' });
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    expect((radios[1] as HTMLInputElement).checked).toBe(false);
    fireEvent.click(radios[1]!);
    fireEvent.click(saveButton());
    await waitFor(async () => {
      expect((await getConfig()).activeProviderId).toBe('p2');
    });
  });

  it('验收 4/5：主题/语言三档入草稿，保存成功后即时生效（ui store）', async () => {
    renderSettings();
    await screen.findByText('外观');
    fireEvent.click(screen.getByRole('radio', { name: '暗色' }));
    fireEvent.click(screen.getByRole('radio', { name: 'English' }));
    fireEvent.click(saveButton());
    await waitFor(() => {
      expect(useUiStore.getState().theme).toBe('dark');
      expect(useUiStore.getState().language).toBe('en');
    });
    // 落盘值与 ui store 一致（'system'|'zh'|'en' / 'system'|'light'|'dark'）
    const saved = await getConfig();
    expect(saved.uiTheme).toBe('dark');
    expect(saved.uiLanguage).toBe('en');
  });

  it('验收 3：动效基准数字输入非法时禁保存并提示', async () => {
    renderSettings();
    const anim = await screen.findByLabelText('动效基准（ms）');
    fireEvent.change(anim, { target: { value: '12.5' } });
    // 字段级提示与底部汇总行各出现一次
    expect(await screen.findAllByText(/动效基准需为非负整数/)).toHaveLength(2);
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('动效基准（ms）'), { target: { value: '300' } });
    await waitFor(() => expect(saveButton().disabled).toBe(false));
  });
});
