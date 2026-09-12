/**
 * 与 Rust 侧领域模型对应的前端类型（ADR-010 类型同源）。
 *
 * 实体/命令负载类型统一从 `./generated/bindings.ts` 再导出——该文件由 tauri-specta
 * 从 Rust DTO（src-tauri/src/interfaces/ipc.rs）生成，勿手改；此处只保留：
 * - 稳定的类型出口（调用方 import 路径不随生成细节变动）；
 * - 纯 UI 层枚举（ThemeSetting / LanguageSetting，FR-009）。
 */

export type {
  /** 角色卡摘要（角色页卡片，FR-006）。 */
  CharacterSummary,
  /** 消息角色（data_model：user / assistant）。 */
  MessageRole,
  /** 场景（FR-011 叙事账本读路径；idx 升序的在世边界快照行）。 */
  SceneDto,
  /** 人物状态（FR-012 叙事账本读路径；会话内按 id 升序的在世行）。 */
  CharacterStateDto,
  /** 人物状态 scope（FR-012：state = 随戏状态，relation = 缓演关系）。 */
  CharacterStateScope,
  /** 新建角色卡入参（含 avatar；FR-006）。 */
  CharacterInput,
  /** 更新角色卡入参（CharacterInput + 历法整卡覆盖，None/缺键 = 清除；FR-006 / FR-013）。 */
  UpdateCharacterInput,
  /** 会话日历 wire DTO（FR-014 开局向导；camelCase 仅 wire，存储 JSON 由 Rust 产出）。 */
  CalendarConfigDto,
  /** 开局包入参（FR-014；null = 降级路径）。 */
  SessionOpeningInput,
  /** 应用配置（config.json wire 形态；FR-009 / ADR-012）。 */
  ConfigDto,
  /** 单套 LLM Provider（FR-009）。 */
  ProviderDto,
  /** LLM 调用轨迹（透明化功能；promptJson / toolCallsJson 以 string 透传，前端 parse）。 */
  LlmCallDto,
  /** LLM 调用类别（透明化功能：dialogue / explorer / director / draft）。 */
  LlmCallKindDto,
  /** LLM 调用终态（透明化功能：ok / error）。 */
  LlmCallStatusDto,
  /** 命令错误（可判别结构；IPC 命令统一返回）。 */
  IpcError,
} from './generated/bindings';

// ==================================================================
// 多角色第 1 步契约 stub（冻结契约先行，Rust 侧由 Task-30 并行落地）。
//
// 【移除条件：Task-30 合入 master 且 bindings.ts 再生成含阵容制形态后，本段
// 整体删除，SessionSummary / ChatMessage 恢复从 ./generated/bindings 再导出，
// 并以 bindings 实际字段名/可空性逐项对齐（形态以后端为准）。】
//
// 与旧 wire 的差异（冻结契约）：
// - create_session 入参从「characterId + opening」改为阵容制 SessionRosterMember[]；
// - SessionSummary.characterId 删除（D2 的 is_user 取代），新增 instances 回显；
// - ChatMessage.characterId（命令层推导假值）→ instanceId（实例真值）。
// ==================================================================

/** 阵容成员（create_session 入参；D2）：characterId = 模板卡 id，isUser 恰好一处 true。 */
export interface SessionRosterMember {
  characterId: number;
  isUser: boolean;
}

/** 会话角色实例回显（D1 模板/实例分离：建成后的 roster）。 */
export interface SessionInstanceDto {
  id: number;
  /** 设定快照名（建会话时值拷贝自卡；改卡不回写，D1）。 */
  name: string;
  /** 扮演位标记，全会话恰好 1（D2）；侧栏 / 统计读它。 */
  isUser: boolean;
  /** 模板溯源（选卡实例化记卡 id；D6 动态人物为 null）。 */
  characterId: number | null;
}

/** 会话摘要（FR-007；instances 回显形态以后端为准，rebase 对齐）。 */
export type SessionSummary = {
  id: number;
  title: string;
  updatedAt: number;
  /** 建成后的 roster 回显；缺省按空阵容处理（回退文案兜底）。 */
  instances?: SessionInstanceDto[];
};

/**
 * 聊天消息（ADR-001 终态落库形态；instanceId = 说话实例真值——user 条为用户
 * 扮演位实例，assistant 条为生成位实例；stub 以非空真值声明，rebase 对齐）。
 */
export type ChatMessage = Omit<import('./generated/bindings').ChatMessage, 'characterId'> & {
  instanceId: number;
};

/** 界面偏好档位（FR-009；config.json 键 ui_theme / ui_language） */
export type ThemeSetting = 'system' | 'light' | 'dark';
export type LanguageSetting = 'system' | 'zh' | 'en';
