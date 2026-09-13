//! 角色卡 wire 入参契约（FR-006）：create / update 共用负载 DTO。
//!
//! 入参与 CRUD 命令分驻：本模块只承载前端提交的负载形态，行为（校验 / 落库）
//! 在 characters 域的命令实现里。

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::services::character_io;

/// 动效时长可覆写范围（ms）。与 TS 引擎常量互指（同一约束两端）：
/// `src/engine/anims/index.ts` 的 `DUR_MIN_MS` / `DUR_MAX_MS`（默认 450 = 模板值）。
pub const ANIM_DURATION_MIN_MS: i64 = 150;
pub const ANIM_DURATION_MAX_MS: i64 = 1200;
/// 打字节奏可覆写范围（ms/字）。与 TS 引擎常量互指（同一约束两端）：
/// `src/engine/index.ts` 的 `RHYTHM_MIN_MS` / `RHYTHM_MAX_MS`（默认 45）。
pub const ANIM_RHYTHM_MIN_MS: i64 = 10;
pub const ANIM_RHYTHM_MAX_MS: i64 = 160;

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
    /// 演出参数覆写（2026-09-13）：None = 跟随全局设置；范围越界经
    /// [`CharacterInput::validate`] 快速失败。
    pub anim_duration_ms: Option<i64>,
    pub anim_rhythm_ms: Option<i64>,
    pub anim_punct_pause: Option<bool>,
    /// TTS 预留缝（CON-003），前端恒传 null。
    // 一次性系统槽位：仅 create / import（卡文件导入复用 create 路径）写入；
    // update 路径忽略此字段、保留库中原值（见 characters::update_character_impl），
    // 传任意值均无效。此口径用普通注释承载——`///` 文档会被 tauri-specta 原样
    // 发射进 src/api/generated/bindings.ts，扩写会造成生成物非零 diff。
    pub voice_config: Option<String>,
}

impl CharacterInput {
    /// 演出参数范围校验（越界报 Conflict，不静默钳制——对齐 config.validate
    /// 快速失败风格；前端控件域与引擎钳制同源，正常路径到不了这里）。
    pub fn validate(&self) -> Result<(), String> {
        if let Some(ms) = self.anim_duration_ms {
            if !(ANIM_DURATION_MIN_MS..=ANIM_DURATION_MAX_MS).contains(&ms) {
                return Err(format!(
                    "动效时长 {ms} 越界（{ANIM_DURATION_MIN_MS}–{ANIM_DURATION_MAX_MS} ms）"
                ));
            }
        }
        if let Some(ms) = self.anim_rhythm_ms {
            if !(ANIM_RHYTHM_MIN_MS..=ANIM_RHYTHM_MAX_MS).contains(&ms) {
                return Err(format!(
                    "打字节奏 {ms} 越界（{ANIM_RHYTHM_MIN_MS}–{ANIM_RHYTHM_MAX_MS} ms/字）"
                ));
            }
        }
        Ok(())
    }
}

impl From<character_io::CharacterCardPayload> for CharacterInput {
    /// 卡文件负载（Task-04 导入）→ create 负载：同形十二字段直移，不复用旧 id。
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
            anim_duration_ms: p.anim_duration_ms,
            anim_rhythm_ms: p.anim_rhythm_ms,
            anim_punct_pause: p.anim_punct_pause,
            voice_config: p.voice_config,
        }
    }
}
