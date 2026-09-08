/** 与 Rust 侧领域模型对应的前端类型（阶段 3 tauri-specta 接入后由 generated/bindings 取代手写）。 */

export type RenderStyle = string; // 18 种风格之一（FR-005），具体枚举由引擎定义

export interface CharacterSummary {
  id: number;
  name: string;
  avatar: string | null; // 角色头像（data_model avatar 列）；null 时前端首字占位
  renderStyle: RenderStyle;
  greeting: string; // 开场白 markdown-lite（角色卡摘要展示，data_model greeting 列）
  updatedAt: number;
  sessionCount: number; // 关系侧汇总：该角色开启的会话数
}

export interface SessionSummary {
  id: number;
  characterId: number;
  title: string;
  updatedAt: number;
}

export type MessageRole = 'user' | 'assistant';

/** 界面偏好档位（FR-009；config.json 键 ui_theme / ui_language，落盘阶段 6） */
export type ThemeSetting = 'system' | 'light' | 'dark';
export type LanguageSetting = 'system' | 'zh' | 'en';

export interface ChatMessage {
  id: number;
  sessionId: number;
  characterId: number | null; // 谁说的；用户消息为 null（5b）
  role: MessageRole;
  content: string; // 原始 markdown-lite，显示时才解析（BR-005）
  reasoning: string | null; // 思考内容，与正文分离落库（FR-003）
  thinkMs: number | null; // 思考可见时长
  createdAt: number;
  interrupted: boolean; // 终态落库的中断标记（ADR-001）
}
