//! 场景与人物状态域（FR-011 / FR-012 读路径 + FR-012 手动清除写路径）：叙事账本面板数据地基。

use serde::Serialize;
use specta::Type;
use tauri::State;

use crate::domain::models;
use crate::domain::ports::StoragePort;
use crate::state::AppState;

use super::error::IpcError;

/// 人物状态 scope（FR-012：state = 随戏状态，relation = 缓演关系；wire 小写）。
/// 领域 `models::CharacterStateScope` 的库值同为小写字符串，wire 与存储形态一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CharacterStateScope {
    State,
    Relation,
}

impl From<models::CharacterStateScope> for CharacterStateScope {
    fn from(scope: models::CharacterStateScope) -> Self {
        match scope {
            models::CharacterStateScope::State => CharacterStateScope::State,
            models::CharacterStateScope::Relation => CharacterStateScope::Relation,
        }
    }
}

/// 场景（FR-011 边界快照行）：`list_scenes` 按 idx 升序（叙事顺序）返回。
/// 不含 `session_id`（列表已按会话过滤，调用方已知）与 `deleted_at`
/// （存储层默认滤墓碑，ADR-009）；在世行才会出现在列表里。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SceneDto {
    pub id: i64,
    /// 同会话内单调自增（含墓碑行一并计序），场景顺序即叙事顺序。
    pub idx: i64,
    /// 场景地点，可空。
    pub location: Option<String>,
    /// 叙事层时间原文（自由书写），可空。
    pub time_note: Option<String>,
    /// 记账层：第几天，可空。
    pub fic_day: Option<i64>,
    /// 记账层：时段，可空。
    pub fic_part: Option<String>,
    /// 虚拟日历命名缓存（FR-013，如「白蜡月·晨露日·夜」），可空。
    pub date_label: Option<String>,
    /// 本场一句话（远景压缩单元），可空。
    pub summary: Option<String>,
    /// 桥场加厚回顾（Task-03），可空；渲染回退单行 summary。
    pub recap: Option<String>,
    /// 在场**实例** id 数组（多角色换挂后语义翻转：迁移 0009 前为模板卡 id，写入端
    /// 现按实例记值——开场锚行 seed 与结算裁决 schema 均为实例 id；名字映射由
    /// 消费方经 SessionSummary.instances 回显派生）。
    pub present: Vec<i64>,
}

impl From<models::Scene> for SceneDto {
    fn from(s: models::Scene) -> Self {
        Self {
            id: s.id,
            idx: s.idx,
            location: s.location,
            time_note: s.time_note,
            fic_day: s.fic_day,
            fic_part: s.fic_part,
            date_label: s.date_label,
            summary: s.summary,
            recap: s.recap,
            present: s.present,
        }
    }
}

/// 人物状态（FR-012）：会话内「这个角色实例」的状态 / 关系条目，
/// `list_character_states` 按 id 升序返回全部在世行。不含 `session_id` /
/// `deleted_at`（同 [`SceneDto`]；会话隶属由实例携带，迁移 0009 换挂）。
/// 机械适配：wire 字段 characterId → instanceId（真值换挂），整体语义重设计属
/// Task-31。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CharacterStateDto {
    pub id: i64,
    /// 状态所属的角色实例（运行时身份，非模板卡）。
    pub instance_id: i64,
    pub scope: CharacterStateScope,
    /// 状态键：情绪 / 持有 / 约定 / 对某实例的态度。
    pub key: String,
    /// 叙事语言的值，非数字。
    pub value: String,
    /// 过期三义透传（BR-002：scene_end / event:xxx / manual），可空。
    pub expiry: Option<String>,
    /// 来源场景 id，可空。
    pub source_scene: Option<i64>,
    pub updated_at: i64,
}

impl From<models::CharacterState> for CharacterStateDto {
    fn from(s: models::CharacterState) -> Self {
        Self {
            id: s.id,
            instance_id: s.instance_id,
            scope: CharacterStateScope::from(s.scope),
            key: s.key,
            value: s.value,
            expiry: s.expiry,
            source_scene: s.source_scene,
            updated_at: s.updated_at,
        }
    }
}

// ---- 场景与人物状态（FR-011 / FR-012 读路径：叙事账本面板数据地基）----

fn list_scenes_impl(app: &AppState, session_id: i64) -> Result<Vec<SceneDto>, IpcError> {
    // 先校验会话在世（不存在 / 已软删报 NotFound，与 list_messages_impl 同语义），
    // 再走存储端口；列表默认滤墓碑、按 idx 升序（infra/storage/scenes.rs）。
    app.storage.get_session(session_id)?;
    Ok(app
        .storage
        .list_scenes(session_id)?
        .into_iter()
        .map(SceneDto::from)
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn list_scenes(
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<Vec<SceneDto>, IpcError> {
    list_scenes_impl(&state, session_id)
}

fn list_character_states_impl(
    app: &AppState,
    session_id: i64,
) -> Result<Vec<CharacterStateDto>, IpcError> {
    // 同上：先会话在世校验，再读端口；按 id 升序（infra/storage/character_states.rs）。
    app.storage.get_session(session_id)?;
    Ok(app
        .storage
        .list_character_states(session_id)?
        .into_iter()
        .map(CharacterStateDto::from)
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn list_character_states(
    state: State<'_, AppState>,
    session_id: i64,
) -> Result<Vec<CharacterStateDto>, IpcError> {
    list_character_states_impl(&state, session_id)
}

// ---- 人物状态手动清除（FR-012，Task-09：账本状态行级「清除」入口）----

fn clear_character_state_impl(app: &AppState, state_id: i64) -> Result<(), IpcError> {
    // 软删（ADR-009 墓碑，存储层置 deleted_at）；行不存在 / 已清除 → NotFound
    // （对调用方等价，重放安全）。不做会话在世预检：命令只收状态行 id（UI 只能
    // 经在世会话的面板触达该行），清除已软删会话名下的状态行无观察副作用。
    // 清除语义 = 墓碑即终点：被清除的键不再出现在 list_character_states 读路径
    // 与结算 prompt 的【当前状态集】（读路径滤墓碑），后续结算对其 clear 幂等
    // 跳过（director::build_write 只映射手头在世行）——「结算清算不复活」由
    // list 滤墓碑 + clear 映射在世行两处既有约定共同保证（语义测试见
    // services/director/tests.rs 与本文件 tests）。
    app.storage.soft_delete_character_state(state_id)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn clear_character_state(state: State<'_, AppState>, state_id: i64) -> Result<(), IpcError> {
    clear_character_state_impl(&state, state_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::{NewCharacterState, NewScene, NewSession, RosterPick};
    use crate::interfaces::ipc::sessions::delete_session_impl;
    use crate::interfaces::ipc::test_support::{sample_character, temp_state};

    #[test]
    fn scene_dto_serializes_camel_case_without_session_or_tombstone() {
        let dto = SceneDto::from(models::Scene {
            id: 7,
            session_id: 3,
            idx: 2,
            location: Some("旧都 · 灯市".into()),
            time_note: Some("入夜后一刻".into()),
            fic_day: Some(45),
            fic_part: Some("夜".into()),
            date_label: Some("白蜡月·晨露日·夜（灯节）".into()),
            summary: Some("灯市口的一场相逢".into()),
            recap: None,
            present: vec![1, 5],
            deleted_at: None,
        });
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": 7, "idx": 2,
                "location": "旧都 · 灯市", "timeNote": "入夜后一刻",
                "ficDay": 45, "ficPart": "夜",
                "dateLabel": "白蜡月·晨露日·夜（灯节）",
                "summary": "灯市口的一场相逢", "recap": null,
                "present": [1, 5],
            })
        );
        assert!(json.get("sessionId").is_none(), "列表已按会话过滤，不重复携带 sessionId");
        assert!(json.get("deletedAt").is_none(), "存储层滤墓碑，wire 不带 deletedAt");
    }

    #[test]
    fn character_state_dto_serializes_camel_case_with_scope() {
        let to_json = |scope| {
            serde_json::to_value(CharacterStateDto::from(models::CharacterState {
                id: 9,
                instance_id: 5,
                scope,
                key: "情绪".into(),
                value: "强撑镇定".into(),
                expiry: Some("scene_end".into()),
                source_scene: Some(2),
                updated_at: 84,
                deleted_at: None,
                superseded_at: None,
            }))
            .unwrap()
        };
        let json = to_json(models::CharacterStateScope::State);
        assert_eq!(json["scope"], "state", "scope wire 小写（state | relation）");
        assert_eq!(json["instanceId"], 5, "机械适配：characterId → instanceId 真值换挂");
        assert_eq!(json["sourceScene"], 2);
        assert_eq!(json["expiry"], "scene_end");
        assert_eq!(json["updatedAt"], 84);
        assert!(json.get("sessionId").is_none(), "同 SceneDto：不重复携带 sessionId");

        let relation = to_json(models::CharacterStateScope::Relation);
        assert_eq!(relation["scope"], "relation");
    }

    #[test]
    fn clear_character_state_deletes_and_reports_not_found() {
        let (app, dir) = temp_state("scenes_clear_state");
        let user_card = sample_character(&app, "旅人");
        let llm_card = sample_character(&app, "苏鸢");
        let session = app
            .storage
            .create_session(&NewSession {
                roster: vec![
                    RosterPick { character_id: llm_card.id, is_user: false },
                    RosterPick { character_id: user_card.id, is_user: true },
                ],
                title: String::new(),
                opening: None,
            
            default_render_style: "type".to_string(),
        })
            .unwrap();
        let state = app
            .storage
            .upsert_character_state(&NewCharacterState {
                instance_id: 1,
                scope: models::CharacterStateScope::State,
                key: "情绪".into(),
                value: "强撑镇定".into(),
                expiry: Some("scene_end".into()),
                source_scene: None,
            })
            .unwrap();

        // 手动清除：行立即从读路径消失（账本即时可见语义，Task-09 验收核心之一）。
        assert!(list_character_states_impl(&app, session.id).unwrap().len() == 1);
        clear_character_state_impl(&app, state.id).unwrap();
        assert!(list_character_states_impl(&app, session.id).unwrap().is_empty());

        // 墓碑即终点：重复清除 / 不存在的行一律 NotFound（ADR-009：不存在与已软删
        // 对调用方等价），entity 字段对齐 storage 层 ENTITY 常量（mock 文案对齐基准）。
        for id in [state.id, 999_999] {
            let error = clear_character_state_impl(&app, id).unwrap_err();
            assert!(
                matches!(error, IpcError::NotFound { ref entity, .. } if entity == "character_state"),
                "entity 应为 character_state：{error:?}"
            );
        }
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scene_and_state_list_commands_check_session_and_order() {
        let (app, dir) = temp_state("scenes_states");
        let user_card = sample_character(&app, "旅人");
        let llm_card = sample_character(&app, "苏鸢");
        let session = app
            .storage
            .create_session(&NewSession {
                roster: vec![
                    RosterPick { character_id: llm_card.id, is_user: false },
                    RosterPick { character_id: user_card.id, is_user: true },
                ],
                title: String::new(),
                opening: None,
            
            default_render_style: "type".to_string(),
        })
            .unwrap();

        // 开场锚行无条件存在（FR-014 §7-6）：场景列表按 idx 升序返回在世行；
        // present = 全部实例 id（多角色换挂，roster 两位）。
        let listed = list_scenes_impl(&app, session.id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].idx, 0);
        assert_eq!(listed[0].present, vec![1, 2]);

        // 再落两行（idx 单调自增），列表按叙事顺序返回、字段逐一映射。
        app.storage
            .insert_scene(&NewScene {
                session_id: session.id,
                location: Some("灯市".into()),
                time_note: None,
                fic_day: Some(45),
                fic_part: Some("夜".into()),
                date_label: Some("白蜡月·晨露日·夜（灯节）".into()),
                summary: None,
                recap: None,
                present: vec![1, 2],
            })
            .unwrap();
        app.storage
            .insert_scene(&NewScene {
                session_id: session.id,
                location: None,
                time_note: Some("次日清晨".into()),
                fic_day: Some(46),
                fic_part: Some("清晨".into()),
                date_label: None,
                summary: Some("码头启程".into()),
                recap: None,
                present: Vec::new(),
            })
            .unwrap();
        let listed = list_scenes_impl(&app, session.id).unwrap();
        assert_eq!(listed.iter().map(|s| s.idx).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert_eq!(listed[1].location.as_deref(), Some("灯市"));
        assert_eq!(listed[1].date_label.as_deref(), Some("白蜡月·晨露日·夜（灯节）"));
        assert_eq!(listed[2].summary.as_deref(), Some("码头启程"));
        assert!(listed[2].present.is_empty(), "空在场数组原样透传");

        // 人物状态：空会话返回空数组；upsert 后按 id 升序，scope wire 映射正确。
        assert!(list_character_states_impl(&app, session.id).unwrap().is_empty());
        let first = app
            .storage
            .upsert_character_state(&NewCharacterState {
                instance_id: 1,
                scope: models::CharacterStateScope::State,
                key: "情绪".into(),
                value: "强撑镇定".into(),
                expiry: Some("scene_end".into()),
                source_scene: Some(listed[1].id),
            })
            .unwrap();
        app.storage
            .upsert_character_state(&NewCharacterState {
                instance_id: 1,
                scope: models::CharacterStateScope::Relation,
                key: "对织灯人的态度".into(),
                value: "戒备渐消".into(),
                expiry: None,
                source_scene: None,
            })
            .unwrap();
        let states = list_character_states_impl(&app, session.id).unwrap();
        assert_eq!(states.len(), 2);
        assert_eq!(states[0].id, first.id);
        assert_eq!(states[0].scope, CharacterStateScope::State);
        assert_eq!(states[0].source_scene, Some(listed[1].id));
        assert_eq!(states[1].scope, CharacterStateScope::Relation);

        // 软删状态不进读路径（ADR-009 墓碑过滤属存储层职责，读端不重复实现）。
        app.storage.soft_delete_character_state(states[1].id).unwrap();
        assert_eq!(list_character_states_impl(&app, session.id).unwrap().len(), 1);

        // 不存在 / 已软删会话 → NotFound（与 list_messages_impl 同语义，非空列表）。
        delete_session_impl(&app, session.id).unwrap();
        assert!(matches!(
            list_scenes_impl(&app, session.id),
            Err(IpcError::NotFound { .. })
        ));
        assert!(matches!(
            list_character_states_impl(&app, session.id),
            Err(IpcError::NotFound { .. })
        ));
        assert!(matches!(
            list_scenes_impl(&app, 999_999),
            Err(IpcError::NotFound { .. })
        ));
        assert!(matches!(
            list_character_states_impl(&app, 999_999),
            Err(IpcError::NotFound { .. })
        ));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
