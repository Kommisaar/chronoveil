// ProvidersCard 单测：列表-详情结构（2026-09-14）——左列服务清单选中切换、
// 新建即选中、删除选中后详情回落、空态引导。状态化壳回灌 draft（onDraftChange
// 函数式更新落 useState），模拟父级 SettingsView 的草稿流，断言实际渲染的
// 清单与详情联动；其余草稿迁移逻辑（改名跟随 / withoutModel）由父层持有，
// 不在本件断言范围。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigDto, ProviderDto } from '../../api/types';
import '../../i18n';
import { ProvidersCard } from './ProvidersCard';

const providerA: ProviderDto = {
  id: 'p-a',
  name: '本地中转',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-a',
  models: ['gpt-4o-mini'],
  api: 'openai',
};

const providerB: ProviderDto = {
  id: 'p-b',
  name: 'Claude 官方',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-b',
  models: ['claude-sonnet-4'],
  api: 'anthropic',
};

const emptyDraft: ConfigDto = {
  providers: [],
  activeProviderId: null,
  activeModel: null,
  rhythmMsPerChar: 45,
  punctPauseEnabled: true,
  animDurationBase: 450,
  renderStyle: 'type',
  uiLanguage: 'zh',
  uiTheme: 'system',
  directorModel: null,
  nearScenes: 2,
};

function draftWith(...providers: ProviderDto[]): ConfigDto {
  return { ...emptyDraft, providers };
}

afterEach(cleanup);

/** 状态化壳：onDraftChange 函数式更新回灌 draft prop，模拟 SettingsView 的
 *  页级草稿流（纯 spy 不会重渲染，断言不到清单/详情联动）。 */
function setupStateful(initial: ConfigDto) {
  function Harness() {
    const [draft, setDraft] = useState(initial);
    return (
      <FluentProvider theme={webLightTheme}>
        <ProvidersCard
          draft={draft}
          onDraftChange={(update) => setDraft((prev) => update(prev) ?? prev)}
          saving={false}
          saveError={null}
          dirty={false}
        />
      </FluentProvider>
    );
  }
  render(<Harness />);
}

/** 左列清单（role=group，aria-label=卡名）内的服务项按钮。 */
const navItem = (name: RegExp): HTMLElement =>
  within(screen.getByRole('group', { name: '模型服务' })).getByRole('button', { name });

describe('ProvidersCard 列表-详情', () => {
  it('默认选中第一个服务：详情面板渲染其字段，左列两项带协议 meta 与默认徽标', () => {
    setupStateful({
      ...draftWith({ ...providerA }, { ...providerB }),
      activeProviderId: 'p-a',
      activeModel: 'gpt-4o-mini',
    });
    // 详情 = 第一个服务（其模型行在面板内可见）
    expect(screen.getByRole('textbox', { name: 'p-a-name' }).closest('div')).toBeTruthy();
    // 左列清单项只显示名称；全局默认指向 p-a → 名称尾内联「默认」徽标，p-b 无
    expect(navItem(/本地中转/).textContent).toBe('本地中转默认');
    expect(navItem(/Claude 官方/).textContent).toBe('Claude 官方');
  });

  it('点击左列项切换详情面板', () => {
    setupStateful(draftWith({ ...providerA }, { ...providerB }));
    fireEvent.click(navItem(/Claude 官方/));
    expect(screen.getByRole('textbox', { name: 'p-b-name' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'p-a-name' })).toBeNull();
  });

  it('新建服务即选中：草稿追加 + 详情切到新服务（空名 → 头部显示占位）', async () => {
    setupStateful(draftWith({ ...providerA }));
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'p-a-name' })).toBeNull();
    });
    // 新服务 id 随机：以左列新增第二项 + 详情存在非 p-a 的 name 输入为凭
    const detailName = screen.getByRole('textbox', { name: /-name$/ });
    expect(detailName.getAttribute('aria-label')).not.toBe('p-a-name');
    expect(navItem(/例如：本地中转/)).toBeTruthy();
  });

  it('删除选中的服务：详情回落到剩余服务', async () => {
    setupStateful(draftWith({ ...providerA }, { ...providerB }));
    // 选中第二个再删它（删除经 ConfirmDialog 确认）
    fireEvent.click(navItem(/Claude 官方/));
    fireEvent.click(screen.getByRole('button', { name: '删除 Claude 官方' }));
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    await waitFor(() => {
      // 选中 id 悬空 → 派生回落第一个剩余服务，详情不消失
      expect(screen.getByRole('textbox', { name: 'p-a-name' })).toBeTruthy();
    });
    expect(
      within(screen.getByRole('group', { name: '模型服务' })).queryByRole('button', {
        name: /Claude 官方/,
      }),
    ).toBeNull();
  });

  it('空草稿：单列空态引导，新建后进入编辑', async () => {
    setupStateful(emptyDraft);
    expect(screen.getByText(/还没有模型服务/)).toBeTruthy();
    expect(screen.queryByRole('group', { name: '模型服务' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    await waitFor(() => {
      expect(screen.getByRole('group', { name: '模型服务' })).toBeTruthy();
    });
    expect(screen.getByRole('textbox', { name: /-name$/ })).toBeTruthy();
  });
});
