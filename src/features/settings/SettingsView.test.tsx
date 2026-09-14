// 设置视图交互单测（TASK-009；2026-09-09 起自动保存语义 + 双层级
// provider→models）：jsdom 下 isTauri=false，走 mock 后端（内存 config，
// 跨用例共享 → 每个用例 beforeEach 重置基线）。覆盖：空态引导、providers
// 新建/校验/添加模型即落盘（directorModel 保留）、api_key 掩码切换、激活
// 删除拦截、非激活删除、默认模型二元组切换、删默认模型回落、主题/语言
// 改动即时生效、非法草稿不落盘。
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
  models: ['test-model'],
  ...partial,
});

const seedConfig = (partial: Partial<ConfigDto>): ConfigDto => ({
  ...DEFAULT_CONFIG,
  directorModel: 'director-keep',
  ...partial,
});

// 自动保存防抖 600ms + 落盘延迟；并行负载下留裕量（同 CharactersView 210ms
// 退场契约的加时经验）。
const AUTOSAVE_WAIT = { timeout: 3000 };

/** 原地等待 ms（真实计时器，用于越过防抖窗口做否定断言）。 */
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  it('验收 2/5/6：新建 provider → 加模型前不落盘 → 添加模型后自动落盘，directorModel 原样保留', async () => {
    renderSettings();
    await screen.findByText(/还没有模型服务/);
    fireEvent.click(screen.getAllByRole('button', { name: '新建' })[0]!);

    // 未填齐（无名称）：卡片级校验提示；越过防抖窗口后仍不落盘
    expect(await screen.findByText(/名称为必填/)).toBeTruthy();
    await settle(700);
    expect((await getConfig()).providers).toHaveLength(0);

    fireEvent.change(await screen.findByLabelText(/-name$/), { target: { value: '主服务' } });
    fireEvent.change(screen.getByLabelText(/-baseUrl$/), {
      target: { value: 'https://api.test/v1' },
    });

    // 只有 name/baseUrl、还没有模型 → 草稿仍非法 → 整个 provider 都不落盘
    await settle(700);
    expect((await getConfig()).providers).toHaveLength(0);

    // 添加模型 → 草稿整体合法 → 待自动保存状态 → 落盘
    fireEvent.change(screen.getByLabelText(/-newModel$/), { target: { value: 'gpt-x' } });
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    expect(await screen.findByText('更改将自动保存')).toBeTruthy();

    await waitFor(async () => {
      const saved = await getConfig();
      expect(saved.providers).toHaveLength(1);
      expect(saved.providers[0]!.name).toBe('主服务');
      expect(saved.providers[0]!.models).toEqual(['gpt-x']);
      // 不呈现的字段整份带回（saveConfig 整份覆写不丢字段）
      expect(saved.directorModel).toBe('director-keep');
    }, AUTOSAVE_WAIT);
    // 落盘后待保存状态消失
    await waitFor(() => expect(screen.queryByText('更改将自动保存')).toBeNull(), AUTOSAVE_WAIT);
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

  it('验收 2：非激活 provider 经确认对话框删除，自动落盘', async () => {
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
    // 删除经自动保存落盘
    await waitFor(async () => {
      expect((await getConfig()).providers).toHaveLength(1);
    }, AUTOSAVE_WAIT);
  });

  it('验收 2：模型行「设为默认」切全局默认二元组，自动落盘 active_provider_id + active_model', async () => {
    await saveConfig(
      seedConfig({
        providers: [fullProvider({ models: ['m1'] }), fullProvider({ id: 'p2', name: '备用', models: ['m2'] })],
        activeProviderId: 'p1',
        activeModel: 'm1',
      }),
    );
    renderSettings();
    const radios = await screen.findAllByRole('radio', { name: '设为默认' });
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    expect((radios[1] as HTMLInputElement).checked).toBe(false);
    fireEvent.click(radios[1]!);
    await waitFor(async () => {
      const saved = await getConfig();
      expect(saved.activeProviderId).toBe('p2');
      expect(saved.activeModel).toBe('m2');
    }, AUTOSAVE_WAIT);
  });

  it('验收 2：删除全局默认模型 → 确认对话框拦截（U4），确认后 activeModel 回落置 null 并落盘', async () => {
    await saveConfig(
      seedConfig({
        providers: [fullProvider({ models: ['keep', 'gone'] })],
        activeProviderId: 'p1',
        activeModel: 'gone',
      }),
    );
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: '删除模型 gone' }));
    // U4：全局默认模型是高危行，先弹确认（确认文案指明删除对象）
    expect(await screen.findByText(/确定删除模型「gone」？/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除模型' }));
    await waitFor(async () => {
      const saved = await getConfig();
      expect(saved.providers[0]!.models).toEqual(['keep']);
      expect(saved.activeModel).toBeNull();
    }, AUTOSAVE_WAIT);
  });

  it('验收 4/5：主题/语言三档改动即时生效（ui store），落盘交自动保存', async () => {
    renderSettings();
    await screen.findByText('外观');
    fireEvent.click(screen.getByRole('radio', { name: '暗色' }));
    fireEvent.click(screen.getByRole('radio', { name: 'English' }));
    // 改动即生效（不等落盘）
    await waitFor(() => {
      expect(useUiStore.getState().theme).toBe('dark');
      expect(useUiStore.getState().language).toBe('en');
    });
    // 落盘值与 ui store 一致（'system'|'zh'|'en' / 'system'|'light'|'dark'）
    await waitFor(async () => {
      const saved = await getConfig();
      expect(saved.uiTheme).toBe('dark');
      expect(saved.uiLanguage).toBe('en');
    }, AUTOSAVE_WAIT);
  });

  it('动效基准滑杆：改动自动落盘（2026-09-14 换自绘滑杆，限位内无非法中间态）', async () => {
    const baseline = await getConfig();
    renderSettings();
    const anim = await screen.findByLabelText('动效时长');
    expect((anim as HTMLInputElement).value).toBe(String(baseline.animDurationBase));
    fireEvent.change(anim, { target: { value: '300' } });
    await waitFor(async () => {
      expect((await getConfig()).animDurationBase).toBe(300);
    }, AUTOSAVE_WAIT);
  });

  it('近景场景数：非法输入不落盘并提示，改合法后自动落盘（窗口可选化 1–6）', async () => {
    const baseline = await getConfig();
    renderSettings();
    const input = await screen.findByLabelText('近景场景数');
    expect((input as HTMLInputElement).value).toBe('2');
    // 越域（0 / 7）→ 字段级提示 + 底部汇总各一次，越过防抖窗口后不落盘
    fireEvent.change(input, { target: { value: '7' } });
    expect(await screen.findAllByText(/近景场景数需为 1–6/)).toHaveLength(2);
    await settle(700);
    expect((await getConfig()).nearScenes).toBe(baseline.nearScenes);
    fireEvent.change(screen.getByLabelText('近景场景数'), { target: { value: '0' } });
    expect(await screen.findAllByText(/近景场景数需为 1–6/)).toHaveLength(2);
    await settle(700);
    expect((await getConfig()).nearScenes).toBe(baseline.nearScenes);
    // 边界值 5 合法 → 自动落盘
    fireEvent.change(screen.getByLabelText('近景场景数'), { target: { value: '5' } });
    await waitFor(async () => {
      expect((await getConfig()).nearScenes).toBe(5);
    }, AUTOSAVE_WAIT);
    await waitFor(() => expect(screen.queryByText(/近景场景数需为 1–6/)).toBeNull());
  });
});
