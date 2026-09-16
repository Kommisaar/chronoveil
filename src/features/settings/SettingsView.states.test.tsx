// SettingsView 三态收编断言（A1）：配置载入中出 StateBlock loading（此前
// draft 为 null 整页空白）、载入失败保留红字 role="alert"、载入完成后卡片
// 正常渲染。api 层整体 vi.mock（ADR-010；独立于 SettingsView.test 的共享
// mock 后端，互不影响）。i18n 固定中文。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigDto } from '../../api/types';
import '../../i18n';
import { SettingsView } from './SettingsView';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('../../api/commands', () => ({ ...mocks }));

const CONFIG: ConfigDto = {
  providers: [],
  activeProviderId: null,
  activeModel: null,
  rhythmMsPerChar: 60,
  renderStyle: 'type',
  punctPauseEnabled: true,
  animDurationBase: 300,
  uiLanguage: 'system',
  uiTheme: 'system',
  directorModel: null,
  nearScenes: 2,
  systemPrompt: '',
  temperature: 0.7,
  topP: 1.0,
  frequencyPenalty: 0.0,
  presencePenalty: 0.0,
};

function renderSettings() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <SettingsView />
    </FluentProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('SettingsView 三态（A1 收编）', () => {
  it('配置载入中：StateBlock loading 占位，表单卡不渲染（不再整页空白）', async () => {
    mocks.getConfig.mockReturnValue(new Promise(() => {}));
    renderSettings();
    expect(await screen.findByText('加载中…')).toBeTruthy();
    expect(screen.queryByText('外观')).toBeNull();
    expect(screen.queryByText('模型服务')).toBeNull();
  });

  it('载入失败：红字 role="alert" 展示原因，无 loading 占位', async () => {
    mocks.getConfig.mockRejectedValue(new Error('config unreadable'));
    renderSettings();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('配置载入失败');
    expect(alert.textContent).toContain('config unreadable');
    expect(screen.queryByText('加载中…')).toBeNull();
  });

  it('载入完成：loading 占位消失，分节卡片渲染', async () => {
    mocks.getConfig.mockResolvedValue(CONFIG);
    renderSettings();
    expect(await screen.findByText('外观')).toBeTruthy();
    expect(screen.queryByText('加载中…')).toBeNull();
  });
});
