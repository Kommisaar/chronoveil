/**
 * 配置域 mock（FR-009 / ADR-012）：从 backend.ts 拆出的分域实现——backend.ts
 * 已届 500 行纪律上限，配置作为独立概念单独成文件；经 backend.ts 原路径再导出，
 * 调用方（api/commands.ts 的 `mock.getConfig` 等）与既有测试 import 均不变。
 * 语义对齐 Rust infra/config.rs：双层级 provider→models、10–160 节奏值域、
 * 1–6 近景窗口（拒绝不钳边）、错误形态 IpcError::Config。
 */

import type { ConfigDto } from '../types';
import { ApiError } from '../errors';

/** 与 Rust `Config::new_with_defaults`（FR-009；双层级 provider→models）一致的默认配置。 */
export const DEFAULT_CONFIG: ConfigDto = {
  providers: [],
  activeProviderId: null,
  activeModel: null,
  rhythmMsPerChar: 45,
  punctPauseEnabled: true,
  animDurationBase: 450,
  uiLanguage: 'zh',
  uiTheme: 'system',
  directorModel: null,
  nearScenes: 2, // ADR-004 默认近景窗口（config.near_scenes 缺键回落值）
};

let config: ConfigDto = { ...DEFAULT_CONFIG };

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
  if (next.nearScenes < 1 || next.nearScenes > 6) {
    throw new ApiError({
      kind: 'config',
      message: `near_scenes = ${next.nearScenes} 越界（允许 1–6）`,
    });
  }
  config = { ...next, providers: cloneProviders(next.providers) };
}
