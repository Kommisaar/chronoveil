//! 角色卡 wire 入参契约（FR-006）：create / update 共用负载 DTO。
//!
//! 入参与 CRUD 命令分驻：本模块只承载前端提交的负载形态，行为（校验 / 落库）
//! 在 characters 域的命令实现里。

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::services::character_io;

/// 新建 / 更新角色卡入参（FR-006）：整卡覆盖语义，create 与 update 共用同一负载。
/// 历法不属角色卡（2026-09-13 产品裁剪）——会话历法在建会话时经开局包
/// （SessionOpeningInput）显式指定或取内置默认历。
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CharacterInput {
    pub name: String,
    /// None = 不带头像 / 更新时清除头像。
    pub avatar: Option<String>,
    pub persona: String,
    /// 性别 / 年龄（可选展示元数据，自由文本；None = 未设置）。
    pub gender: Option<String>,
    pub age: Option<String>,
    pub render_style: String,
    pub model_config: Option<String>,
    /// 强调色 #RRGGBB，可空；None = 跟随海报派生色。
    pub accent_color: Option<String>,
    /// TTS 预留缝（CON-003），前端恒传 null。
    pub voice_config: Option<String>,
}

impl From<character_io::CharacterCardPayload> for CharacterInput {
    /// 卡文件负载（Task-04 导入）→ create 负载：同形九字段直移，不复用旧 id。
    fn from(p: character_io::CharacterCardPayload) -> Self {
        Self {
            name: p.name,
            avatar: p.avatar,
            persona: p.persona,
            gender: p.gender,
            age: p.age,
            render_style: p.render_style,
            model_config: p.model_config,
            accent_color: p.accent_color,
            voice_config: p.voice_config,
        }
    }
}
