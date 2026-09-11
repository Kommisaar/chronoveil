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
  /** 会话摘要（FR-007）。 */
  SessionSummary,
  /** 聊天消息（ADR-001 终态落库形态）。 */
  ChatMessage,
  /** 消息角色（data_model：user / assistant）。 */
  MessageRole,
  /** 场景（FR-011 叙事账本读路径；idx 升序的在世边界快照行）。 */
  SceneDto,
  /** 人物状态（FR-012 叙事账本读路径；会话内按 id 升序的在世行）。 */
  CharacterStateDto,
  /** 人物状态 scope（FR-012：state = 随戏状态，relation = 缓演关系）。 */
  CharacterStateScope,
  /** 新建 / 更新角色卡入参（含 avatar；FR-006）。 */
  CharacterInput,
  /** 会话日历 wire DTO（FR-014 开局向导；camelCase 仅 wire，存储 JSON 由 Rust 产出）。 */
  CalendarConfigDto,
  /** 开局包入参（FR-014；null = 降级路径）。 */
  SessionOpeningInput,
  /** 应用配置（config.json wire 形态；FR-009 / ADR-012）。 */
  ConfigDto,
  /** 单套 LLM Provider（FR-009）。 */
  ProviderDto,
  /** 命令错误（可判别结构；IPC 命令统一返回）。 */
  IpcError,
} from './generated/bindings';

/** 界面偏好档位（FR-009；config.json 键 ui_theme / ui_language） */
export type ThemeSetting = 'system' | 'light' | 'dark';
export type LanguageSetting = 'system' | 'zh' | 'en';
