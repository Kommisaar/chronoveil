/**
 * 配置域 mock（FR-009 / ADR-012）：从 backend.ts 拆出的分域实现——backend.ts
 * 已届 500 行纪律上限，配置作为独立概念单独成文件；经 backend.ts 原路径再导出，
 * 调用方（api/commands.ts 的 `mock.getConfig` 等）与既有测试 import 均不变。
 * 语义对齐 Rust infra/config.rs：双层级 provider→models、10–160 节奏值域、
 * 1–6 近景窗口（拒绝不钳边）、错误形态 IpcError::Config。
 */

import type { ConfigDto, ProviderDto } from '../types';
import { ApiError } from '../errors';

/** 与 Rust `Config::new_with_defaults`（FR-009；双层级 provider→models）一致的默认配置。 */
export const DEFAULT_CONFIG: ConfigDto = {
  providers: [],
  activeProviderId: null,
  activeModel: null,
  rhythmMsPerChar: 45,
  punctPauseEnabled: true,
  animDurationBase: 450,
  // 全局出场动画风格（2026-09-14）：与 Rust Config::new_with_defaults 同源
  // （DEFAULT_RENDER_STYLE，engine/anims 单一事实源）。
  renderStyle: 'type',
  uiLanguage: 'zh',
  uiTheme: 'system',
  directorModel: null,
  nearScenes: 2, // ADR-004 默认近景窗口（config.near_scenes 缺键回落值）
  // 全局系统提示词（2026-09-15）：空白 = 不注入（与 infra/config.rs serde
  // 缺省空串同源）；自由文本不校验。
  systemPrompt: '',
  // 采样温度默认 0.7（与 infra/config.rs DEFAULT_TEMPERATURE 同源，TS 侧单一
  // 事实源在 features/settings/preferences.ts 的 TEMPERATURE_MIN/MAX 互指注释）。
  temperature: 0.7,
};

/**
 * 浏览器 dev 的预置供应商（仅 mock 内存初值）：mock 态不落盘、页面刷新即清空，
 * 每次都要手填新增表单太磨人（2026-09-14 用户要求），故开箱给一套可直接用的
 * 供应商 + 默认模型。刻意不并入 DEFAULT_CONFIG——它保持 Rust 全默认语义（导出
 * 被测试当作对齐基线）。桌面壳（tauri dev）走真实 IPC，不经此文件。
 */
const SEED_PROVIDER: ProviderDto = {
  id: 'mock-deepseek',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  api: 'openai',
  models: [
    {
      id: 'deepseek-chat',
      contextWindow: 128000,
      maxOutputTokens: 8192,
      inputTypes: ['text'],
      outputTypes: ['text'],
    },
    {
      id: 'deepseek-reasoner',
      contextWindow: 128000,
      maxOutputTokens: 8192,
      inputTypes: ['text'],
      outputTypes: ['text'],
    },
  ],
};

// 初始态 = 全默认 + 种子供应商（active 二元组一并指向种子，默认模型行开箱即有值）。
let config: ConfigDto = {
  ...DEFAULT_CONFIG,
  providers: [{ ...SEED_PROVIDER, models: [...SEED_PROVIDER.models] }],
  activeProviderId: SEED_PROVIDER.id,
  activeModel: 'deepseek-chat',
};

/** providers 逐项浅拷 + models 数组拷贝：调用方改返回值/草稿不污染内存基线。 */
function cloneProviders(providers: ConfigDto['providers']): ConfigDto['providers'] {
  return providers.map((p) => ({ ...p, models: [...p.models] }));
}

export async function getConfig(): Promise<ConfigDto> {
  return { ...config, providers: cloneProviders(config.providers) };
}

export async function saveConfig(next: ConfigDto): Promise<void> {
  // 值域对齐 infra/config.rs validate（FR-009：10–160），错误形态对齐 IpcError::Config。
  if (next.rhythmMsPerChar < 10 || next.rhythmMsPerChar > 160) {
    throw new ApiError({
      kind: 'config',
      message: `rhythm_ms_per_char = ${next.rhythmMsPerChar} 越界（允许 10–160）`,
    });
  }
  // 近景场景数（近景窗口可选化）：对齐 infra/config.rs validate（1–6，拒绝不钳边）。
  // 下方条件字面 1/6 与报错文案「允许 1–6」同源：前端单一事实源为
  // features/settings/preferences.ts 的 NEAR_SCENES_MIN/MAX（api 层依赖方向
  // 不可反向 import features，按「跨文件常量互指」纪律注释互指）。
  if (next.nearScenes < 1 || next.nearScenes > 6) {
    throw new ApiError({
      kind: 'config',
      message: `near_scenes = ${next.nearScenes} 越界（允许 1–6）`,
    });
  }
  config = { ...next, providers: cloneProviders(next.providers) };
}
