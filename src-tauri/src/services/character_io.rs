//! 角色卡导入/导出（Task-04）：单卡 JSON 的构建 / 解析 / 校验纯函数（禁 tauri / rusqlite / reqwest，ADR-010）。
//!
//! 卡文件格式（version 1，wire camelCase）：
//!
//! ```json
//! {
//!   "format": "chronoveil-character",
//!   "version": 1,
//!   "character": {
//!     "name": "…", "avatar": null, "persona": "…", "gender": null, "age": null,
//!     "renderStyle": "typewriter", "modelConfig": null, "accentColor": null,
//!     "voiceConfig": null
//!   }
//! }
//! ```
//!
//! `character` 对象与命令层 wire 的 `CharacterInput` 同形（create/update 负载形状）；
//! 库侧字段（id / calendar_config / created_at / updated_at / deleted_at）一律不进卡文件。
//! 文件对话框与磁盘读写属 interface 关注点，在 `interfaces::ipc` 命令实现内，本模块不做 IO。
//!
//! 解析不加 `deny_unknown_fields`（向前兼容：新版本应用多出的字段在旧版可忽略），
//! 但 `version` 大于当前支持版本时显式报「版本过新」，避免静默丢字段。

use serde::{Deserialize, Serialize};

use crate::domain::models::Character;

/// 卡文件格式标识（`format` 字段恒定取值）。
pub const FORMAT_TAG: &str = "chronoveil-character";

/// 当前卡文件格式版本。
pub const FORMAT_VERSION: u32 = 1;

/// 卡文件里的 `character` 对象：与命令层 wire 的 `CharacterInput` 同形（camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterCardPayload {
    pub name: String,
    /// None = 不带头像。
    pub avatar: Option<String>,
    pub persona: String,
    pub gender: Option<String>,
    pub age: Option<String>,
    pub render_style: String,
    pub model_config: Option<String>,
    pub accent_color: Option<String>,
    /// TTS 预留缝（CON-003），当前恒 None，仍随卡携带以保持形状对称。
    pub voice_config: Option<String>,
}

impl From<&Character> for CharacterCardPayload {
    /// 领域角色卡 → 卡负载：只取 CharacterInput 同形九字段，库侧字段（id /
    /// calendar_config / 时间戳 / 墓碑）不导出。
    fn from(c: &Character) -> Self {
        Self {
            name: c.name.clone(),
            avatar: c.avatar.clone(),
            persona: c.persona.clone(),
            gender: c.gender.clone(),
            age: c.age.clone(),
            render_style: c.render_style.clone(),
            model_config: c.model_config.clone(),
            accent_color: c.accent_color.clone(),
            voice_config: c.voice_config.clone(),
        }
    }
}

/// 卡文件信封（只序列化；解析走 `Value` 以区分「过新 / 缺失 / 非法」三种版本错误）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterCardFile<'a> {
    pub format: &'static str,
    pub version: u32,
    pub character: &'a CharacterCardPayload,
}

/// 领域角色卡 → 导出 JSON 文本（pretty 缩进，便于手工查看与 diff）。
pub fn build_card_json(character: &Character) -> String {
    let file = CharacterCardFile {
        format: FORMAT_TAG,
        version: FORMAT_VERSION,
        character: &CharacterCardPayload::from(character),
    };
    // 信封只含 String / u32 / 引用，序列化不可能失败；失败即程序错误，panic 合理。
    serde_json::to_string_pretty(&file).expect("角色卡信封序列化不应失败")
}

/// 导出默认文件名：`<角色名>.json`。替换 Windows 文件名非法字符与控制字符为 `_`，
/// 剥掉结尾的空白与点；净化后为空则回落 `character.json`。
pub fn card_file_name(name: &str) -> String {
    const FALLBACK: &str = "character";
    const WINDOWS_FORBIDDEN: [char; 9] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    let sanitized: String = name
        .chars()
        .map(|c| if WINDOWS_FORBIDDEN.contains(&c) || c.is_control() { '_' } else { c })
        .collect();
    // Windows 文件名不能以点 / 空格结尾（会被静默剥掉或引发歧义），统一剥掉。
    let stem = sanitized.trim_end_matches(['.', ' ']);
    if stem.is_empty() {
        format!("{FALLBACK}.json")
    } else {
        format!("{stem}.json")
    }
}

/// 导入错误（分层边界：services 不依赖 interfaces 的 `IpcError`，由命令层映射）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CardImportError {
    /// JSON 语法坏 / 顶层不是对象。
    MalformedJson(String),
    /// `format` 字段缺失或不是 `chronoveil-character`（不是本应用的卡文件）。
    BadFormat,
    /// `version` 大于当前支持版本：由更新版本应用导出，拒绝静默降级。
    VersionTooNew { found: u64 },
    /// `version` 缺失 / 非数字 / 为 0 等非法值。
    VersionInvalid,
    /// `character` 字段缺失或形状不对（必填字段缺失、类型不符等）。
    MalformedCard(String),
    /// `name` 为空白。
    EmptyName,
}

impl std::fmt::Display for CardImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CardImportError::MalformedJson(detail) => {
                write!(f, "角色卡文件不是合法 JSON：{detail}")
            }
            CardImportError::BadFormat => {
                write!(f, "不是 ChronoVeil 角色卡文件（format 不匹配）")
            }
            CardImportError::VersionTooNew { found } => {
                write!(f, "角色卡版本过新（v{found}），请先升级应用再导入")
            }
            CardImportError::VersionInvalid => write!(f, "角色卡版本号缺失或非法"),
            CardImportError::MalformedCard(detail) => {
                write!(f, "角色卡 character 字段缺失或形状不对：{detail}")
            }
            CardImportError::EmptyName => write!(f, "角色卡缺少名称"),
        }
    }
}

impl std::error::Error for CardImportError {}

/// 解析并校验导入文本 → 角色卡负载。
///
/// 校验顺序：JSON 合法 → format 匹配 → version 匹配（>1 报「版本过新」）→
/// character 形状（必填 name 等按 serde 缺失即错，未知字段忽略以向前兼容）→
/// name 非空白。其余字段（renderStyle 取值等）交给 create 既有路径校验。
pub fn parse_card_json(text: &str) -> Result<CharacterCardPayload, CardImportError> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| CardImportError::MalformedJson(e.to_string()))?;
    let obj = value.as_object().ok_or(CardImportError::BadFormat)?;

    if obj.get("format").and_then(serde_json::Value::as_str) != Some(FORMAT_TAG) {
        return Err(CardImportError::BadFormat);
    }
    match obj.get("version").and_then(serde_json::Value::as_u64) {
        Some(v) if v == u64::from(FORMAT_VERSION) => {}
        Some(v) if v > u64::from(FORMAT_VERSION) => {
            return Err(CardImportError::VersionTooNew { found: v });
        }
        _ => return Err(CardImportError::VersionInvalid),
    }
    let payload: CharacterCardPayload =
        serde_json::from_value(obj.get("character").cloned().ok_or_else(|| {
            CardImportError::MalformedCard("缺少 character 字段".to_string())
        })?)
        .map_err(|e| CardImportError::MalformedCard(e.to_string()))?;
    if payload.name.trim().is_empty() {
        return Err(CardImportError::EmptyName);
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_character() -> Character {
        Character {
            id: 7,
            name: "苏鸢".into(),
            avatar: Some("data:image/png;base64,AAA".into()),
            persona: "雨夜电话亭的守夜人".into(),
            gender: Some("女".into()),
            age: Some("24".into()),
            render_style: "typewriter".into(),
            model_config: Some(r#"{"providerId":"p1","model":"m1"}"#.into()),
            accent_color: Some("#5e2347".into()),
            voice_config: None,
            // 库侧字段：不应出现在卡文件里。
            calendar_config: Some(r#"{"year_len":360}"#.into()),
            created_at: 1,
            updated_at: 2,
            deleted_at: None,
        }
    }

    #[test]
    fn build_card_json_has_envelope_and_camel_case_payload_only() {
        let json = build_card_json(&sample_character());
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["format"], FORMAT_TAG);
        assert_eq!(value["version"], 1);
        let c = &value["character"];
        // CharacterInput 同形九字段（camelCase）齐全。
        assert_eq!(c["name"], "苏鸢");
        assert_eq!(c["persona"], "雨夜电话亭的守夜人");
        assert_eq!(c["renderStyle"], "typewriter");
        assert_eq!(c["modelConfig"], r#"{"providerId":"p1","model":"m1"}"#);
        assert_eq!(c["accentColor"], "#5e2347");
        assert_eq!(c["gender"], "女");
        assert_eq!(c["age"], "24");
        assert_eq!(c["avatar"], "data:image/png;base64,AAA");
        assert!(c["voiceConfig"].is_null());
        // 库侧字段不导出（calendar_config / id / 时间戳 / 墓碑）。
        for banned in ["id", "calendarConfig", "render_style", "createdAt", "updatedAt", "deletedAt"] {
            assert!(c.get(banned).is_none(), "卡文件不应含库侧字段 {banned}");
        }
    }

    #[test]
    fn exported_card_roundtrips_through_parse() {
        let character = sample_character();
        let payload = parse_card_json(&build_card_json(&character)).unwrap();
        assert_eq!(payload, CharacterCardPayload::from(&character));
    }

    #[test]
    fn parse_rejects_bad_format_and_malformed_json() {
        assert_eq!(
            parse_card_json(r#"{"format":"other-app","version":1,"character":{}}"#),
            Err(CardImportError::BadFormat)
        );
        // format 缺失同样视为非卡文件。
        assert_eq!(
            parse_card_json(r#"{"version":1,"character":{"name":"x"}}"#),
            Err(CardImportError::BadFormat)
        );
        assert!(matches!(
            parse_card_json("{ not json"),
            Err(CardImportError::MalformedJson(_))
        ));
        // 顶层不是对象（如数组）也归入 BadFormat。
        assert_eq!(parse_card_json("[]"), Err(CardImportError::BadFormat));
    }

    #[test]
    fn parse_rejects_version_too_new_missing_and_invalid() {
        let base = |version: serde_json::Value| {
            format!(
                r#"{{"format":"chronoveil-character","version":{version},"character":{{"name":"苏鸢"}}}}"#
            )
        };
        assert_eq!(
            parse_card_json(&base(serde_json::json!(2))),
            Err(CardImportError::VersionTooNew { found: 2 }),
            "version > 1：版本过新"
        );
        assert!(matches!(
            parse_card_json(&base(serde_json::json!(999))),
            Err(CardImportError::VersionTooNew { found: 999 })
        ));
        assert_eq!(
            parse_card_json(&base(serde_json::json!(0))),
            Err(CardImportError::VersionInvalid)
        );
        assert_eq!(
            parse_card_json(r#"{"format":"chronoveil-character","character":{"name":"x"}}"#),
            Err(CardImportError::VersionInvalid),
            "version 缺失"
        );
        assert_eq!(
            parse_card_json(r#"{"format":"chronoveil-character","version":"1","character":{"name":"x"}}"#),
            Err(CardImportError::VersionInvalid),
            "version 非数字"
        );
    }

    #[test]
    fn parse_rejects_missing_or_empty_name_and_missing_character() {
        // 完整形状 + 空白 name：serde 层已通过，走到 EmptyName 校验。
        assert_eq!(
            parse_card_json(
                r#"{"format":"chronoveil-character","version":1,"character":
                    {"name":"  ","persona":"","renderStyle":"typewriter"}}"#
            ),
            Err(CardImportError::EmptyName),
            "name 纯空白视同缺失"
        );
        assert!(
            matches!(
                parse_card_json(
                    r#"{"format":"chronoveil-character","version":1,"character":{"gender":"女"}}"#
                ),
                Err(CardImportError::MalformedCard(_))
            ),
            "name 缺失：serde 必填字段错误"
        );
        assert!(
            matches!(
                parse_card_json(r#"{"format":"chronoveil-character","version":1}"#),
                Err(CardImportError::MalformedCard(_))
            ),
            "character 字段整体缺失"
        );
    }

    #[test]
    fn parse_tolerates_unknown_fields_for_forward_compat() {
        // 未来版本多出的顶层 / character 字段在旧版应被忽略（不加 deny_unknown_fields）。
        let payload = parse_card_json(
            r#"{
              "format": "chronoveil-character",
              "version": 1,
              "futureTopLevel": {"x": 1},
              "character": {"name": "苏鸢", "persona": "", "renderStyle": "typewriter",
                            "avatar": null, "gender": null, "age": null,
                            "modelConfig": null, "accentColor": null, "voiceConfig": null,
                            "futureField": true}
            }"#,
        )
        .unwrap();
        assert_eq!(payload.name, "苏鸢");
        // name 首尾空白不做裁剪（原样入库，与 create 既有行为一致）。
        let padded = parse_card_json(
            r#"{"format":"chronoveil-character","version":1,
                "character":{"name":" 苏鸢 ","persona":"","renderStyle":"typewriter"}}"#,
        )
        .unwrap();
        assert_eq!(padded.name, " 苏鸢 ");
    }

    #[test]
    fn card_file_name_sanitizes_windows_forbidden_characters() {
        assert_eq!(card_file_name("苏鸢"), "苏鸢.json");
        assert_eq!(card_file_name("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j.json");
        assert_eq!(card_file_name("结尾点."), "结尾点.json", "剥结尾点");
        assert_eq!(card_file_name("结尾空格 .json".trim_end_matches(".json")), "结尾空格.json");
        assert_eq!(card_file_name(""), "character.json", "空名回落");
        assert_eq!(card_file_name("..."), "character.json", "全点回落");
        assert_eq!(card_file_name("\u{0}\u{7}"), "__.json", "控制字符替换");
    }
}
