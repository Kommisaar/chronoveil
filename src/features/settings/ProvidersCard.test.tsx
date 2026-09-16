// ProvidersCard 单测：清单-详情结构（2026-09-14 参考稿重排）——左列清单选中
// 切换、新增走缓冲表单（确认前不触碰草稿，确认后入草稿并选中）、删除选中后
// 详情回落、无服务直接给新增表单。状态化壳回灌 draft（onDraftChange 函数式
// 更新落 useState），模拟父级 SettingsView 的草稿流，断言实际渲染的清单与
// 详情联动；其余草稿迁移逻辑（改名跟随 / withoutModel）由父层持有，不在本件
// 断言范围。
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigDto, ModelSpecDto, ProviderDto } from '../../api/types';
import '../../i18n';
import { ProvidersCard } from './ProvidersCard';

/** 模型元数据夹具：id 之外取缺省（1M 上下文 / 128K 输出 / 仅文本）。 */
const spec = (id: string): ModelSpecDto => ({
  id,
  contextWindow: 1000000,
  maxOutputTokens: 128000,
  inputTypes: ['text'],
  outputTypes: ['text'],
});

const providerA: ProviderDto = {
  id: 'p-a',
  name: '本地中转',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-a',
  models: [spec('gpt-4o-mini')],
  api: 'openai',
};

const providerB: ProviderDto = {
  id: 'p-b',
  name: 'Claude 官方',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-b',
  models: [spec('claude-sonnet-4')],
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
  systemPrompt: '',
  temperature: 0.7,
  topP: 1.0,
  frequencyPenalty: 0.0,
  presencePenalty: 0.0,
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
          saveError={null}
        />
      </FluentProvider>
    );
  }
  render(<Harness />);
}

/** 左列清单（role=group，aria-label=卡名）内的服务项按钮。 */
const navItem = (name: RegExp): HTMLElement =>
  within(screen.getByRole('group', { name: '模型服务' })).getByRole('button', { name });

/** 底部确认主钮（与左列「添加供应商」入口同名：取清单 group 之外那颗）。 */
const confirmAddButton = (): HTMLButtonElement =>
  screen
    .getAllByRole('button', { name: '添加供应商' })
    .find((b) => !screen.getByRole('group', { name: '模型服务' }).contains(b))! as HTMLButtonElement;

describe('ProvidersCard 清单-详情', () => {
  it('默认选中第一个服务：右栏详情为其编辑面板，左列两项齐全', () => {
    setupStateful(draftWith({ ...providerA }, { ...providerB }));
    // 详情 = 第一个服务（其删除钮以服务名成对出现在详情头）
    expect(screen.getByRole('button', { name: '删除 本地中转' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '删除 Claude 官方' })).toBeNull();
    expect(navItem(/本地中转/)).toBeTruthy();
    expect(navItem(/Claude 官方/)).toBeTruthy();
  });

  it('点击左列项切换详情面板', () => {
    setupStateful(draftWith({ ...providerA }, { ...providerB }));
    fireEvent.click(navItem(/Claude 官方/));
    expect(screen.getByRole('button', { name: '删除 Claude 官方' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '删除 本地中转' })).toBeNull();
  });

  it('新增走缓冲表单：确认前不追加草稿，确认后入草稿并选中', async () => {
    setupStateful(draftWith({ ...providerA }));
    fireEvent.click(navItem(/添加供应商/));
    // 右栏切到新增表单（详情面板被替换）
    expect(await screen.findByText(/添加模型供应商/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '删除 本地中转' })).toBeNull();

    // 未填齐：确认主钮禁用（缓冲态不触草稿）
    expect(confirmAddButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('add-name'), { target: { value: '新服务' } });
    fireEvent.change(screen.getByLabelText('add-baseUrl'), {
      target: { value: 'https://api.new.com/v1' },
    });
    // 添加模型走 ModelDialog（2026-09-14 模型元数据化）：填 ID 保存后行内才出现
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'm1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByLabelText('add-model-0')).toBeTruthy();
    expect(confirmAddButton().disabled).toBe(false);

    fireEvent.click(confirmAddButton());
    // 确认后：草稿追加 + 右栏切到新服务详情
    expect(await screen.findByRole('button', { name: '删除 新服务' })).toBeTruthy();
    expect(navItem(/新服务/)).toBeTruthy();
  });

  it('删除选中的服务：详情回落到剩余服务', async () => {
    setupStateful(draftWith({ ...providerA }, { ...providerB }));
    // 选中第二个再删它（删除经 ConfirmDialog 确认）
    fireEvent.click(navItem(/Claude 官方/));
    fireEvent.click(screen.getByRole('button', { name: '删除 Claude 官方' }));
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    await waitFor(() => {
      // 选中 id 悬空 → 派生回落第一个剩余服务，详情不消失
      expect(screen.getByRole('button', { name: '删除 本地中转' })).toBeTruthy();
    });
    expect(
      within(screen.getByRole('group', { name: '模型服务' })).queryByRole('button', {
        name: /Claude 官方/,
      }),
    ).toBeNull();
  });

  it('无服务：布局不分叉，清单只剩添加入口，右栏即新增表单', async () => {
    setupStateful(emptyDraft);
    expect(await screen.findByText(/添加模型供应商/)).toBeTruthy();
    // 清单列恒在：只有「添加供应商」一项（呈选中态）
    expect(within(screen.getByRole('group', { name: '模型服务' })).getByRole('button', {
      name: '添加供应商',
    })).toBeTruthy();

    // 填齐确认 → 草稿出现第一套服务并选中
    fireEvent.change(screen.getByLabelText('add-name'), { target: { value: '首个服务' } });
    fireEvent.change(screen.getByLabelText('add-baseUrl'), {
      target: { value: 'https://api.first.com/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'm1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.click(confirmAddButton());
    expect(await screen.findByRole('button', { name: '删除 首个服务' })).toBeTruthy();
    expect(navItem(/首个服务/)).toBeTruthy();
  });

  it('行内「编辑模型」：对话框预填该行元数据，保存后原位替换同一行', async () => {
    setupStateful(draftWith({ ...providerA }));
    fireEvent.click(navItem(/添加供应商/));
    expect(await screen.findByText(/添加模型供应商/)).toBeTruthy();

    // 先经新增对话框造一行模型 m1
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'm1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect((screen.getByLabelText('add-model-0') as HTMLInputElement).value).toBe('m1');

    // 行内编辑钮（aria-label = 编辑模型 + 模型名）→ 对话框以该行为 initial 打开
    fireEvent.click(screen.getByRole('button', { name: '编辑模型 m1' }));
    expect(screen.getByText('编辑模型')).toBeTruthy();
    expect((screen.getByLabelText('模型 ID') as HTMLInputElement).value).toBe('m1');
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'm1-renamed' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    // 原位替换：仍只有第 0 行，不追加新行
    expect((screen.getByLabelText('add-model-0') as HTMLInputElement).value).toBe('m1-renamed');
    expect(screen.queryByLabelText('add-model-1')).toBeNull();
  });
});
