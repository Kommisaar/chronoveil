//! 角色卡单卡导出/导入域（Task-04）：对话框 + 文件读写属 interface 关注点。
//!
//! JSON 构建/解析/校验纯函数在 services::character_card_file；本模块只负责：原生「保存 /
//! 打开文件」对话框（tauri-plugin-dialog 的 Rust 侧 blocking API，不经前端 IPC
//! 权限）、磁盘读写、把服务层错误映射为 IpcError。blocking API 不得在主线程调用
//!（会与事件循环互锁），故两条命令均标 `#[tauri::command(async)]` 交给异步运行时线程。

use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::domain::ports::StoragePort;
use crate::services::character_card_file;
use crate::state::AppState;

use super::character_inputs::CharacterInput;
use super::characters::{create_character_impl, CharacterSummary};
use super::error::IpcError;

/// 卡文件导入错误 → IpcError：全部是「所选文件非法入参」，统一归入 Conflict。
fn map_card_import_error(e: character_card_file::CardImportError) -> IpcError {
    IpcError::Conflict { message: e.to_string() }
}

/// 对话框选出的路径（可能为 file:// URL 形态）→ 常规路径；UNC 前缀（`\\?\`）简化。
fn picked_file_path(picked: tauri_plugin_dialog::FilePath) -> Result<std::path::PathBuf, IpcError> {
    picked
        .simplified()
        .into_path()
        .map_err(|e| IpcError::Conflict { message: format!("无法解析所选文件路径：{e}") })
}

/// 导出数据段（对话框前的纯数据部分，可测）：目标不存在/已软删报 NotFound；
/// 成功返回（默认文件名 `<角色名>.json`，卡 JSON 文本）。
fn export_character_data(app: &AppState, id: i64) -> Result<(String, String), IpcError> {
    let character = app.storage.get_character(id)?;
    Ok((
        character_card_file::card_file_name(&character.name),
        character_card_file::build_card_json(&character),
    ))
}

#[tauri::command(async)]
#[specta::specta]
pub fn export_character(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<String>, IpcError> {
    let (file_name, json) = export_character_data(&state, id)?;
    // 「保存文件」对话框：默认文件名 <角色名>.json，JSON 过滤；取消返回 None。
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name(file_name)
        .blocking_save_file();
    let Some(path) = picked.map(picked_file_path).transpose()? else {
        return Ok(None);
    };
    std::fs::write(&path, json)
        .map_err(|e| IpcError::Storage { message: format!("写入角色卡文件失败：{e}") })?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// 导入数据段（对话框后的纯数据部分，可测）：解析校验（services::character_card_file）
/// 后经既有 create_character 路径建新卡——不复用旧 id、允许重名，直接落库。
fn import_character_data(app: &AppState, text: &str) -> Result<CharacterSummary, IpcError> {
    let payload = character_card_file::parse_card_json(text).map_err(map_card_import_error)?;
    create_character_impl(app, CharacterInput::from(payload))
}

#[tauri::command(async)]
#[specta::specta]
pub fn import_character(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<CharacterSummary>, IpcError> {
    // 「打开文件」对话框：JSON 过滤；取消返回 None。
    let picked = app.dialog().file().add_filter("JSON", &["json"]).blocking_pick_file();
    let Some(path) = picked.map(picked_file_path).transpose()? else {
        return Ok(None);
    };
    let text = std::fs::read_to_string(&path)
        .map_err(|e| IpcError::Storage { message: format!("读取角色卡文件失败：{e}") })?;
    Ok(Some(import_character_data(&state, &text)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interfaces::ipc::characters::list_characters_impl;
    use crate::interfaces::ipc::test_support::temp_state;

    #[test]
    fn export_character_data_yields_default_name_and_card_json() {
        let (app, dir) = temp_state("export");
        let created = create_character_impl(
            &app,
            CharacterInput {
                name: "苏鸢".into(),
                avatar: None,
                persona: "雨夜电话亭的守夜人".into(),
                gender: Some("女".into()),
                age: None,
                render_style: Some("typewriter".into()),
                model_config: None,
                accent_color: None,
                anim_duration_ms: None,
                anim_rhythm_ms: None,
                anim_punct_pause: None,
                voice_config: None,
            },
        )
        .unwrap();

        let (file_name, json) = export_character_data(&app, created.id).unwrap();
        assert_eq!(file_name, "苏鸢.json", "默认文件名 = <角色名>.json");
        let value: serde_json::Value = serde_json::from_str(&json).expect("导出段是合法 JSON 文本");
        assert_eq!(value["format"], "chronoveil-character");
        assert_eq!(value["version"], 1);
        assert_eq!(value["character"]["name"], "苏鸢");

        // 目标不存在 / 已软删 → NotFound。
        assert!(matches!(
            export_character_data(&app, 999_999),
            Err(IpcError::NotFound { .. })
        ));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_character_creates_new_card_through_create_path() {
        let (app, dir) = temp_state("import");
        let text = r#"{
          "format": "chronoveil-character",
          "version": 1,
          "character": {
            "name": "苏鸢", "avatar": null, "persona": "雨夜电话亭的守夜人",
            "gender": "女", "age": "24", "renderStyle": "typewriter",
            "modelConfig": null, "accentColor": null, "voiceConfig": null
          }
        }"#;
        let imported = import_character_data(&app, text).unwrap();
        assert_eq!(imported.name, "苏鸢");
        assert_eq!(imported.persona, "雨夜电话亭的守夜人");
        assert_eq!(imported.render_style.as_deref(), Some("typewriter"));
        assert_eq!(imported.session_count, 0);

        // 走 create 既有路径：新 id、允许重名（不与既有卡合并）。
        let again = import_character_data(&app, text).unwrap();
        assert_ne!(imported.id, again.id);
        let listed = list_characters_impl(&app).unwrap();
        assert_eq!(listed.len(), 2);

        // 校验失败 → Conflict（携带服务层的人类可读信息），且不落库。
        for bad in [
            r#"{"format":"other","version":1,"character":{"name":"x"}}"#,
            r#"{"format":"chronoveil-character","version":2,"character":{"name":"x"}}"#,
            r#"{"format":"chronoveil-character","version":1,"character":{"name":"  "}}"#,
            "{ not json",
        ] {
            match import_character_data(&app, bad) {
                Err(IpcError::Conflict { message }) => assert!(!message.is_empty()),
                other => panic!("坏卡文件应报 Conflict，实际 {other:?}"),
            }
        }
        assert_eq!(list_characters_impl(&app).unwrap().len(), 2, "校验失败零落库");
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_import_roundtrip_preserves_card_fields() {
        let (app, dir) = temp_state("roundtrip");
        let created = create_character_impl(
            &app,
            CharacterInput {
                name: "林深".into(),
                avatar: Some("data:image/png;base64,AAA".into()),
                persona: "旧书店老板".into(),
                gender: None,
                age: Some("31".into()),
                render_style: Some("ink".into()),
                model_config: Some(r#"{"providerId":"p1","model":"m1"}"#.into()),
                accent_color: Some("#123456".into()),
                anim_duration_ms: Some(600),
                anim_rhythm_ms: Some(80),
                anim_punct_pause: Some(false),
                voice_config: None,
            },
        )
        .unwrap();

        let (_, json) = export_character_data(&app, created.id).unwrap();
        let imported = import_character_data(&app, &json).unwrap();
        // 卡内十二字段逐一保真；id / updated_at / session_count 属新卡事实，不保真。
        assert_eq!(imported.name, "林深");
        assert_eq!(imported.avatar.as_deref(), Some("data:image/png;base64,AAA"));
        assert_eq!(imported.persona, "旧书店老板");
        assert_eq!(imported.age.as_deref(), Some("31"));
        assert_eq!(imported.render_style.as_deref(), Some("ink"));
        assert_eq!(imported.model_config.as_deref(), Some(r#"{"providerId":"p1","model":"m1"}"#));
        assert_eq!(imported.accent_color.as_deref(), Some("#123456"));
        // 演出参数（0013）随卡保真
        assert_eq!(imported.anim_duration_ms, Some(600));
        assert_eq!(imported.anim_rhythm_ms, Some(80));
        assert_eq!(imported.anim_punct_pause, Some(false));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
