//! 角色卡 wire 入参契约（FR-006 / FR-013）：create / update 负载 DTO。
//!
//! 入参与 CRUD 命令分驻：本模块只承载前端提交的负载形态（含历法接线语义），
//! 行为（校验 / 落库）在 characters 域的命令实现里。

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::services::character_io;

use super::sessions::CalendarConfigDto;

/// 新建角色卡入参（FR-006）。建卡不带历法——FR-014 开局向导显式指定的历法经
/// `create_session` 回写角色卡（FR-013）；历法编辑走 [`UpdateCharacterInput`]。
#[derive(Debug, Clone, Deserialize, Type)]
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

/// 更新角色卡入参（FR-006 / FR-013）：[`CharacterInput`] 全字段 + 世界观历法。
/// 编辑器整卡提交（Task-17 `buildInput` 返回 `CharacterInput & { calendarConfig }`，
/// 与本结构 wire 同形）；历法域语义：
/// - `Some(dto)`：经 [`fiction_time::validate`] 校验后序列化落库（snake_case 存储
///   JSON，与会话快照同构），编辑器保存历法即此形态；
/// - `None` / wire 缺键：**清除历法**（回退内置默认历）——整卡覆盖语义与 avatar
///   从众（既有可空字段无「不动」形态，`Option` 一层即足够，无需嵌套区分）。
#[derive(Debug, Clone, Deserialize, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCharacterInput {
    pub name: String,
    /// None = 更新时清除头像。
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
    /// 世界观历法（FR-013）；None = 清除。
    pub calendar_config: Option<CalendarConfigDto>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::fiction_time;
    use crate::interfaces::ipc::test_support::{sample_bare_input, sample_calendar_dto, upd_input};

    #[test]
    fn update_character_input_serializes_camel_case() {
        let mut input = upd_input("苏鸢", &sample_bare_input());
        input.avatar = Some("data:image/png;base64,AAA".into());
        input.calendar_config = Some(sample_calendar_dto());
        let json = serde_json::to_value(&input).unwrap();
        assert_eq!(json["name"], "苏鸢");
        assert_eq!(json["renderStyle"], "typewriter", "wire camelCase");
        assert_eq!(json["calendarConfig"]["name"], "星槎历");
        assert_eq!(json["calendarConfig"]["daysPerMonth"], 12);
        assert_eq!(json["calendarConfig"]["festivals"]["2"], "归潮祭",
            "节日表 wire 形态：数字字符串键");
        assert_eq!(json["calendarConfig"]["dayNames"][0], "潮日");

        // 全键反序列化往返；DTO ↔ domain 往返无损（前端保存的领域校验地基）。
        let back: UpdateCharacterInput = serde_json::from_value(json).unwrap();
        assert_eq!(back, input);
        assert!(fiction_time::validate(&fiction_time::CalendarConfig::from(
            back.calendar_config.as_ref().unwrap()
        )));
    }
}
