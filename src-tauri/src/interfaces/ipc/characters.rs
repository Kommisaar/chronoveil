//! 角色域（FR-006）：角色卡 CRUD（含 avatar / 世界观历法接线 FR-013）及其 wire DTO。

use serde::Serialize;
use specta::Type;
use tauri::State;

use crate::domain::fiction_time;
use crate::domain::models;
use crate::domain::ports::StoragePort;
use crate::state::AppState;

use super::character_inputs::{CharacterInput, UpdateCharacterInput};
use super::error::IpcError;

/// 角色卡摘要（角色页卡片；session_count 为关系侧汇总）。
///
/// TASK-008 起 `persona` / `model_config` 随列表返回：编辑表单点选即载入全量
/// 字段（UI-002），避免为预填再发一次单条查询。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSummary {
    pub id: i64,
    pub name: String,
    /// 头像可空：data URL 或 `~/.chronoveil` 相对路径；null 时前端首字占位。
    pub avatar: Option<String>,
    /// 人设系统提示词（编辑预填）。
    pub persona: String,
    /// 性别（可选展示元数据）。
    pub gender: Option<String>,
    /// 年龄（可选展示元数据，自由文本）。
    pub age: Option<String>,
    /// 出场动画风格（18 种之一，FR-005）。
    pub render_style: String,
    /// 每角色模型覆写 JSON（camelCase 键，`resolve_effective_llm` 消费）；
    /// None = 跟随全局默认。
    pub model_config: Option<String>,
    /// 强调色 #RRGGBB，可空；None = 跟随海报派生色（前端 accentColorOf）。
    pub accent_color: Option<String>,
    /// 角色卡世界观日历 JSON（FR-013；FR-014 起随摘要透传，供开局向导
    /// 「跟随角色卡」项显示历法名）；None = 内置默认历。
    pub calendar_config: Option<String>,
    pub updated_at: i64,
    /// 该角色开启的会话数（在世会话）。
    pub session_count: i64,
}

/// 领域角色卡 → 摘要 DTO（session_count 由调用方按会话计数填充）。
fn character_summary_from(c: models::Character) -> CharacterSummary {
    CharacterSummary {
        id: c.id,
        name: c.name,
        avatar: c.avatar,
        persona: c.persona,
        gender: c.gender,
        age: c.age,
        render_style: c.render_style,
        model_config: c.model_config,
        accent_color: c.accent_color,
        calendar_config: c.calendar_config,
        updated_at: c.updated_at,
        session_count: 0,
    }
}

// ---- 角色 CRUD（FR-006，含 avatar）----

// 导入域（character_cards）的导入路径复用 create 收尾、导出域测试复用列表读数，
// 故对 ipc 子树可见。
pub(super) fn list_characters_impl(app: &AppState) -> Result<Vec<CharacterSummary>, IpcError> {
    // 会话计数（关系侧）多角色换挂：sessions 不再挂 character_id，改经在世会话的
    // 实例溯源统计（character_id = 模板卡 id 的实例数）。
    let sessions = app.storage.list_sessions()?;
    let mut counts: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    for s in sessions {
        for instance in app.storage.list_instances(s.id)? {
            if let Some(card) = instance.character_id {
                *counts.entry(card).or_insert(0) += 1;
            }
        }
    }
    Ok(app
        .storage
        .list_characters()?
        .into_iter()
        .map(|c| {
            let mut summary = character_summary_from(c);
            summary.session_count = counts.get(&summary.id).copied().unwrap_or(0);
            summary
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn list_characters(state: State<'_, AppState>) -> Result<Vec<CharacterSummary>, IpcError> {
    list_characters_impl(&state)
}

// 卡文件导入（Task-04）经既有 create 路径落库，故对 ipc 子树可见。
pub(super) fn create_character_impl(
    app: &AppState,
    input: CharacterInput,
) -> Result<CharacterSummary, IpcError> {
    let created = app.storage.create_character(&models::NewCharacter {
        name: input.name,
        avatar: input.avatar,
        persona: input.persona,
        gender: input.gender,
        age: input.age,
        render_style: input.render_style,
        model_config: input.model_config,
        accent_color: input.accent_color,
        voice_config: input.voice_config,
    })?;
    Ok(CharacterSummary {
        session_count: 0,
        ..character_summary_from(created)
    })
}

#[tauri::command]
#[specta::specta]
pub fn create_character(
    state: State<'_, AppState>,
    input: CharacterInput,
) -> Result<CharacterSummary, IpcError> {
    create_character_impl(&state, input)
}

fn update_character_impl(
    app: &AppState,
    id: i64,
    input: UpdateCharacterInput,
) -> Result<(), IpcError> {
    // 历法接线（FR-013）：Some → 领域校验（对齐开局包惯例，失败报 Conflict）后序列化
    // 为存储 JSON（domain snake_case 键，与会话快照同构）；None / 缺键 → 清除历法。
    let calendar_config = match &input.calendar_config {
        Some(dto) => {
            let cal = fiction_time::CalendarConfig::from(dto);
            if !fiction_time::validate(&cal) {
                return Err(IpcError::Conflict {
                    message: "角色卡日历需每月天数 > 0 且月名 / 日名至少其一非空".into(),
                });
            }
            Some(serde_json::to_string(&cal).map_err(|e| IpcError::Conflict {
                message: format!("角色卡日历序列化失败：{e}"),
            })?)
        }
        None => None,
    };
    // 整卡覆盖（FR-006：编辑表单全量提交）；目标不存在 / 已软删报 NotFound。
    app.storage.update_character(
        id,
        &models::UpdateCharacter {
            name: input.name,
            avatar: input.avatar,
            persona: input.persona,
            gender: input.gender,
            age: input.age,
            render_style: input.render_style,
            model_config: input.model_config,
            accent_color: input.accent_color,
            voice_config: input.voice_config,
            calendar_config,
        },
    )?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn update_character(
    state: State<'_, AppState>,
    id: i64,
    input: UpdateCharacterInput,
) -> Result<(), IpcError> {
    update_character_impl(&state, id, input)
}

fn delete_character_impl(app: &AppState, id: i64) -> Result<(), IpcError> {
    // 软删（ADR-009）；其会话 / 消息保留墓碑之下，restore 可还原。
    app.storage.soft_delete_character(id)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn delete_character(state: State<'_, AppState>, id: i64) -> Result<(), IpcError> {
    delete_character_impl(&state, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::{NewSession, RosterPick};
    use crate::interfaces::ipc::sessions::CalendarConfigDto;
    use crate::interfaces::ipc::test_support::{
        sample_bare_input, sample_calendar_dto, sample_character, temp_state, upd_input,
    };

    #[test]
    fn character_summary_serializes_camel_case_with_persona_and_model_config() {
        // TASK-008：摘要扩 persona / model_config（编辑预填），wire 保持 camelCase。
        // FR-014：calendarConfig 随摘要透传（开局向导「跟随角色卡」显示历法名）。
        let summary = CharacterSummary {
            id: 5,
            name: "苏鸢".into(),
            avatar: None,
            persona: "雨夜电话亭的守夜人".into(),
            gender: None,
            age: None,
            render_style: "typewriter".into(),
            model_config: Some(r#"{"providerId":"p1","model":"m1"}"#.into()),
            accent_color: Some("#5e2347".into()),
            calendar_config: Some(r#"{"name":"旧都历","days_per_month":30}"#.into()),
            updated_at: 42,
            session_count: 2,
        };
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["persona"], "雨夜电话亭的守夜人");
        assert_eq!(json["modelConfig"], r#"{"providerId":"p1","model":"m1"}"#);
        assert_eq!(json["accentColor"], "#5e2347", "强调色 camelCase wire");
        assert_eq!(json["calendarConfig"], r#"{"name":"旧都历","days_per_month":30}"#,
            "日历 JSON 原样透传（存储 snake_case 由 Rust 产出）");
        assert!(json["avatar"].is_null(), "avatar 可空透传");
        // model_config = None（跟随全局）时 wire 为 null。
        let follower = CharacterSummary { model_config: None, ..summary };
        assert!(serde_json::to_value(&follower).unwrap()["modelConfig"].is_null());
    }

    #[test]
    fn character_crud_with_avatar_and_session_count() {
        let (app, dir) = temp_state("characters");

        let input = CharacterInput {
            name: "苏鸢".into(),
            avatar: Some("data:image/png;base64,AAA".into()),
            persona: "雨夜电话亭的守夜人".into(),
            gender: Some("女".into()),
            age: Some("24".into()),
            render_style: "typewriter".into(),
            model_config: Some(r#"{"providerId":"p1","model":"m1"}"#.into()),
            accent_color: None,
            voice_config: None,
        };
        let created = create_character_impl(&app, input.clone()).unwrap();
        assert_eq!(created.avatar.as_deref(), Some("data:image/png;base64,AAA"));
        assert_eq!(created.session_count, 0);
        // 扩字段（TASK-008）随创建回执 / 列表原样返回，编辑表单据此预填。
        assert_eq!(created.persona, "雨夜电话亭的守夜人");
        assert_eq!(
            created.model_config.as_deref(),
            Some(r#"{"providerId":"p1","model":"m1"}"#)
        );

        // 会话计数汇总（关系侧；多角色换挂后经实例溯源统计——created 卡作两个
        // 会话的 LLM 位，各实例化一次）。
        let user_card = sample_character(&app, "旅人");
        let roster = |llm: i64| {
            vec![
                RosterPick { character_id: user_card.id, is_user: true },
                RosterPick { character_id: llm, is_user: false },
            ]
        };
        app.storage
            .create_session(&NewSession {
                roster: roster(created.id),
                title: String::new(),
                opening: None,
            })
            .unwrap();
        app.storage
            .create_session(&NewSession {
                roster: roster(created.id),
                title: String::new(),
                opening: None,
            })
            .unwrap();
        let other = create_character_impl(
            &app,
            CharacterInput { name: "林深".into(), ..input.clone() },
        )
        .unwrap();
        let listed = list_characters_impl(&app).unwrap();
        let suy = listed.iter().find(|c| c.id == created.id).unwrap();
        assert_eq!(suy.session_count, 2);
        assert_eq!(suy.persona, "雨夜电话亭的守夜人");
        assert_eq!(suy.model_config.as_deref(), Some(r#"{"providerId":"p1","model":"m1"}"#));
        let lin = listed.iter().find(|c| c.id == other.id).unwrap();
        assert_eq!(lin.session_count, 0);

        // 整卡覆盖更新（含清除 avatar；model_config 置回 None = 跟随全局）。
        update_character_impl(
            &app,
            created.id,
            UpdateCharacterInput {
                avatar: None,
                model_config: None,
                ..upd_input("苏鸢（改）", &input)
            },
        )
        .unwrap();
        let after = list_characters_impl(&app).unwrap();
        let updated = after.iter().find(|c| c.id == created.id).unwrap();
        assert_eq!(updated.name, "苏鸢（改）");
        assert!(updated.avatar.is_none(), "avatar 传 None 即清除");
        assert!(updated.model_config.is_none(), "model_config 传 None 即跟随全局");
        assert_eq!(updated.persona, "雨夜电话亭的守夜人");

        // 软删 + NotFound 语义。
        delete_character_impl(&app, other.id).unwrap();
        let listed = list_characters_impl(&app).unwrap();
        assert!(listed.iter().all(|c| c.id != other.id));
        assert!(matches!(
            update_character_impl(&app, other.id, upd_input("苏鸢", &input)),
            Err(IpcError::NotFound { .. })
        ));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_character_persists_calendar_and_feeds_date_label() {
        let (app, dir) = temp_state("char_calendar");
        let created = create_character_impl(
            &app,
            CharacterInput {
                name: "苏鸢".into(),
                ..sample_bare_input()
            },
        )
        .unwrap();
        // 建卡后历法为空（FR-014 向导建卡不带历法，回写走 create_session 链路）。
        assert_eq!(app.storage.get_character(created.id).unwrap().calendar_config, None);

        // 编辑器整卡提交携带历法（Task-17 契约）→ 落库 + 读回一致（含 festivals 往返）。
        let mut input = upd_input("苏鸢", &sample_bare_input());
        input.calendar_config = Some(sample_calendar_dto());
        update_character_impl(&app, created.id, input).unwrap();

        let stored = app.storage.get_character(created.id).unwrap();
        let raw = stored.calendar_config.clone().expect("历法必须落库");
        let cal = fiction_time::parse(Some(raw.as_str()));
        assert_eq!(cal.name.as_deref(), Some("星槎历"));
        assert_eq!(cal.months, vec!["潮生月".to_string(), "风信月".to_string()]);
        assert_eq!(cal.days_per_month, 12);
        assert_eq!(cal.festivals.get(&2).map(String::as_str), Some("归潮祭"),
            "festivals 数字键往返（存储 JSON 键为字符串数字）");
        assert!(raw.contains(r#""festivals":{"2":"归潮祭"}"#),
            "存储 JSON 为 domain snake_case 形态：{raw}");

        // 端到端活链路自证：读回的历法能被 date_label 消费出带月名 / 日名 / 节日的 label
        // （day=2 → 月序 0「潮生月」、日名取模「汐日」、命中年内第 2 天节日）。
        assert_eq!(
            fiction_time::date_label(&cal, 2, "黄昏"),
            "潮生月·汐日·黄昏（归潮祭）"
        );
        // 建会话快照（FR-013）拿到同一份历法——编辑器保存对后续会话生效
        //（多角色裁量：快照取用户位卡，故 created 卡置于用户位）。
        let llm_card = sample_character(&app, "阿烬");
        let session = app
            .storage
            .create_session(&NewSession {
                roster: vec![
                    RosterPick { character_id: created.id, is_user: true },
                    RosterPick { character_id: llm_card.id, is_user: false },
                ],
                title: String::new(),
                opening: None,
            })
            .unwrap();
        assert_eq!(session.calendar_config.as_deref(), Some(raw.as_str()));

        // wire 读回端：get 返回的 JSON 与 CalendarConfigDto 反向转换对称（festivals 非空不塌缩）。
        let redto = CalendarConfigDto::from(&cal);
        assert_eq!(redto.festivals.as_ref().map(|f| f.get(&2).map(String::as_str)),
            Some(Some("归潮祭")));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_character_none_or_missing_key_clears_calendar() {
        let (app, dir) = temp_state("char_calendar_clear");
        let created = create_character_impl(
            &app,
            CharacterInput { name: "苏鸢".into(), ..sample_bare_input() },
        )
        .unwrap();
        let mut with_cal = upd_input("苏鸢", &sample_bare_input());
        with_cal.calendar_config = Some(sample_calendar_dto());
        update_character_impl(&app, created.id, with_cal).unwrap();
        assert!(app.storage.get_character(created.id).unwrap().calendar_config.is_some());

        // calendarConfig: null → 清除（整卡覆盖语义，回退内置默认历）。
        let clear = upd_input("苏鸢", &sample_bare_input());
        assert!(clear.calendar_config.is_none());
        update_character_impl(&app, created.id, clear).unwrap();
        assert_eq!(app.storage.get_character(created.id).unwrap().calendar_config, None);

        // wire 缺键同语义：反序列化得 None（serde Option 缺省），更新后同样清除。
        let missing_key: UpdateCharacterInput = serde_json::from_value(serde_json::json!({
            "name": "苏鸢", "avatar": null, "persona": "守夜人", "gender": null,
            "age": null, "renderStyle": "typewriter", "modelConfig": null,
            "accentColor": null, "voiceConfig": null
        }))
        .unwrap();
        assert!(missing_key.calendar_config.is_none(), "wire 缺 calendarConfig 键 = None = 清除");
        update_character_impl(&app, created.id, missing_key).unwrap();
        assert_eq!(app.storage.get_character(created.id).unwrap().calendar_config, None);
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_character_rejects_invalid_calendar() {
        let (app, dir) = temp_state("char_calendar_invalid");
        let created = create_character_impl(
            &app,
            CharacterInput { name: "苏鸢".into(), ..sample_bare_input() },
        )
        .unwrap();
        let mut bad = upd_input("苏鸢", &sample_bare_input());
        bad.calendar_config = Some(CalendarConfigDto {
            days_per_month: 0, // 非法：每月天数须 > 0
            ..sample_calendar_dto()
        });
        let before = app.storage.get_character(created.id).unwrap().calendar_config.clone();
        assert!(matches!(
            update_character_impl(&app, created.id, bad),
            Err(IpcError::Conflict { .. })
        ));
        // 校验失败不得半写：历法保持原值。
        assert_eq!(app.storage.get_character(created.id).unwrap().calendar_config, before);
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
