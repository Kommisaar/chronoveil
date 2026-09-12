//! 会话域（FR-007 / FR-014）：列表 / 创建（多角色阵容 + 开局包）/ 软删，
//! 以及会话日历与阵容的 wire DTO。

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::domain::fiction_time;
use crate::domain::models;
use crate::domain::ports::StoragePort;
use crate::state::AppState;

use super::error::IpcError;

/// 会话角色实例回显行（多角色阵容制 wire，Task-31）：`SessionSummary.instances`
/// 逐行——建会话时逐卡实例化的运行时身份快照（D1），非模板卡。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionInstanceDto {
    pub id: i64,
    /// 设定快照名（建会话时值拷贝自卡，改卡不回写，D1）。
    pub name: String,
    /// 扮演位标记（D2）：全会话恰好 1；侧栏标题 / 统计读它。
    pub is_user: bool,
    /// 模板溯源（D1）：选卡实例化记卡 id；None = 动态造人（D6，本切片不产生）。
    pub character_id: Option<i64>,
    /// 出场动画风格快照（D1）——回显快照值而非模板卡现值，改卡不影响既有会话；
    /// 消费方（聊天渲染参数）读这里，不再回查模板卡。
    pub render_style: String,
}

impl From<models::CharacterInstance> for SessionInstanceDto {
    fn from(i: models::CharacterInstance) -> Self {
        Self {
            id: i.id,
            name: i.name,
            is_user: i.is_user,
            character_id: i.character_id,
            render_style: i.render_style,
        }
    }
}

/// 会话摘要（FR-007：列表按 updated_at 倒序）。
/// 多角色阵容制（wire 重设计，Task-31）：sessions.character_id 已随迁移 0009
/// 移除，阵容 / 扮演位信息改经 `instances` 回显（建会话快照，D1/D2）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: i64,
    pub title: String,
    pub updated_at: i64,
    /// 建成后的阵容回显（在世实例，创建序 = 用户位在前）；本切片无实例增删，
    /// 空数组仅出现在异常数据（正常建会话至少一个用户位）。
    pub instances: Vec<SessionInstanceDto>,
    /// 分叉溯源（时间线分叉 wire，Task-44 契约冻结）：源会话 id；非分叉会话 =
    /// null。侧栏分叉标识经 list_sessions 回显读。取数 = 会话行真值（迁移 0011
    /// 两列，分叉落库见 infra/storage/session_fork.rs）。
    pub forked_from_session_id: Option<i64>,
    /// 分叉锚点场号（含锚点场及其之前的消息 / 状态复制进新会话）；非分叉会话
    /// = null。
    pub fork_anchor_scene_idx: Option<i64>,
}

// ---- 会话（FR-007）+ 开局包（FR-014）----

/// 会话日历 wire DTO（FR-014 开局向导）。**wire camelCase 只管本 DTO**——落库存储
/// JSON 由存储层序列化 domain `CalendarConfig` 得 snake_case 键，前端永不手写。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarConfigDto {
    /// 历法名；None = 无命名皮肤。
    pub name: Option<String>,
    /// 月名序列（day-1 → 月序双射换算）。
    pub months: Vec<String>,
    /// 每月天数（固定天数历）；须 > 0。
    pub days_per_month: u32,
    /// 日名序列，按 (day-1) 对序列长度取模循环。
    pub day_names: Vec<String>,
    /// 节日表：键 = 年内第几天（1 起），值 = 节日名；None = 无节日。
    pub festivals: Option<std::collections::BTreeMap<i64, String>>,
}

impl From<&CalendarConfigDto> for fiction_time::CalendarConfig {
    fn from(dto: &CalendarConfigDto) -> Self {
        fiction_time::CalendarConfig {
            name: dto.name.clone(),
            months: dto.months.clone(),
            days_per_month: dto.days_per_month,
            day_names: dto.day_names.clone(),
            festivals: dto.festivals.clone().unwrap_or_default(),
        }
    }
}

impl From<&fiction_time::CalendarConfig> for CalendarConfigDto {
    fn from(cal: &fiction_time::CalendarConfig) -> Self {
        Self {
            name: cal.name.clone(),
            months: cal.months.clone(),
            days_per_month: cal.days_per_month,
            day_names: cal.day_names.clone(),
            // 空节日表 → None（wire 规范形态：「None = 无节日」，与反向 From 对称）。
            festivals: if cal.festivals.is_empty() { None } else { Some(cal.festivals.clone()) },
        }
    }
}

/// 开局包入参（FR-014）：`create_session` 第三参；None = 降级路径——同样无条件
/// seed 默认锚开场行（day=1 / part=夜 / 日历走角色卡快照，§7-6）。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpeningInput {
    /// 显式会话日历；None = 跟随角色卡快照。
    pub calendar: Option<CalendarConfigDto>,
    /// 起始「第 N 天」；None = 1。
    pub fic_day: Option<i64>,
    /// 时段（`fiction_time::PARTS` 六值之一）；None = 「夜」。
    pub fic_part: Option<String>,
    /// 首场景地点原文，可空。
    pub location: Option<String>,
    /// 首场景时间原文，可空。
    pub time_note: Option<String>,
}

/// 开局入参 → 领域 [`models::OpeningSeed`]（FR-014）：入口校验集中在此，非法入参
/// 统一 [`IpcError::Conflict`]——时段六值、起始日 ≥ 1、显式日历需满足命名皮肤
/// 可用性（对齐 `fiction_time::validate`，与 date_label 回退同一判定）。
fn opening_seed_from(input: &SessionOpeningInput) -> Result<models::OpeningSeed, IpcError> {
    if let Some(part) = &input.fic_part {
        if !fiction_time::is_valid_part(part) {
            return Err(IpcError::Conflict {
                message: format!("开局时段「{part}」不在六值内（{:?}）", fiction_time::PARTS),
            });
        }
    }
    if let Some(day) = input.fic_day {
        if day < 1 {
            return Err(IpcError::Conflict { message: format!("开局「第 {day} 天」需 ≥ 1") });
        }
    }
    let calendar = match &input.calendar {
        Some(dto) => {
            let cal = fiction_time::CalendarConfig::from(dto);
            if !fiction_time::validate(&cal) {
                return Err(IpcError::Conflict {
                    message: "开局日历需每月天数 > 0 且月名 / 日名至少其一非空".into(),
                });
            }
            Some(cal)
        }
        None => None,
    };
    Ok(models::OpeningSeed {
        calendar,
        fic_day: input.fic_day,
        fic_part: input.fic_part.clone(),
        location: input.location.clone(),
        time_note: input.time_note.clone(),
    })
}

/// 领域会话 → 摘要 DTO：instances 回显需查实例表（会失败、带 AppState），故不用
/// `From<models::Session>`，所有 SessionSummary 产出统一走本助手（wire 回显单点）；
/// `pub(super)` 因 fork 域（ipc/fork.rs）同为产出方。
pub(super) fn session_summary_with_roster(
    app: &AppState,
    session: models::Session,
) -> Result<SessionSummary, IpcError> {
    let instances = app
        .storage
        .list_instances(session.id)?
        .into_iter()
        .map(SessionInstanceDto::from)
        .collect();
    Ok(SessionSummary {
        id: session.id,
        title: session.title,
        updated_at: session.updated_at,
        instances,
        // 分叉溯源取会话行真值（迁移 0011 两列；非分叉会话行 = NULL → None）。
        forked_from_session_id: session.forked_from_session_id,
        fork_anchor_scene_idx: session.fork_anchor_scene_idx,
    })
}

fn list_sessions_impl(app: &AppState) -> Result<Vec<SessionSummary>, IpcError> {
    app.storage
        .list_sessions()?
        .into_iter()
        .map(|session| session_summary_with_roster(app, session))
        .collect()
}

#[tauri::command]
#[specta::specta]
pub fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionSummary>, IpcError> {
    list_sessions_impl(&state)
}

/// 建会话阵容位 wire 形态（多角色换挂的最小透传 DTO；两步选人 UI 的语义设计属
/// Task-31）。`characterId` = 模板卡 id，`isUser` = 用户扮演位标记。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RosterPickInput {
    pub character_id: i64,
    pub is_user: bool,
}

fn create_session_impl(
    app: &AppState,
    roster: Vec<RosterPickInput>,
    title: Option<String>,
    opening: Option<&SessionOpeningInput>,
) -> Result<SessionSummary, IpcError> {
    // 阵容逐卡 NotFound 由存储层实例化路径上报（比外键冲突更精确，ADR-009 语义）。
    let opening = opening.map(opening_seed_from).transpose()?;
    let session = app.storage.create_session(&models::NewSession {
        roster: roster
            .into_iter()
            .map(|pick| models::RosterPick { character_id: pick.character_id, is_user: pick.is_user })
            .collect(),
        title: title.unwrap_or_default(),
        opening,
    })?;
    session_summary_with_roster(app, session)
}

#[tauri::command]
#[specta::specta]
pub fn create_session(
    state: State<'_, AppState>,
    roster: Vec<RosterPickInput>,
    title: Option<String>,
    opening: Option<SessionOpeningInput>,
) -> Result<SessionSummary, IpcError> {
    create_session_impl(&state, roster, title, opening.as_ref())
}

// 软删等价不可见的 NotFound 语义被相邻域（叙事账本 / 轨迹）测试复用为夹具收尾，
// 故对 ipc 子树可见。
pub(super) fn delete_session_impl(app: &AppState, session_id: i64) -> Result<(), IpcError> {
    // 软删（ADR-009）：置墓碑；不存在 / 已软删报 NotFound。
    app.storage.soft_delete_session(session_id)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn delete_session(state: State<'_, AppState>, session_id: i64) -> Result<(), IpcError> {
    delete_session_impl(&state, session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interfaces::ipc::test_support::{sample_character, temp_state};

    // ---- wire 契约（camelCase 对应 types.ts；验收 2/4 的测试兜底）----

    #[test]
    fn session_summary_serializes_camel_case() {
        // 语义（多角色阵容制，Task-31）：sessions.character_id 移除，阵容/扮演位
        // 经 instances 回显（wire camelCase：isUser / characterId / renderStyle）。
        let json = serde_json::to_value(SessionSummary {
            id: 3,
            title: "雨夜来电".into(),
            updated_at: 1234,
            instances: vec![SessionInstanceDto {
                id: 1,
                name: "旅人".into(),
                is_user: true,
                character_id: Some(9),
                render_style: "type".into(),
            }],
            forked_from_session_id: None,
            fork_anchor_scene_idx: None,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": 3,
                "title": "雨夜来电",
                "updatedAt": 1234,
                "instances": [
                    { "id": 1, "name": "旅人", "isUser": true, "characterId": 9, "renderStyle": "type" }
                ],
                // 分叉溯源（Task-44）：非分叉会话两字段 wire null；分叉取值契约见 fork.rs 测试
                "forkedFromSessionId": null,
                "forkAnchorSceneIdx": null
            })
        );
    }

    #[test]
    fn session_commands_cover_list_create_softdelete() {
        let (app, dir) = temp_state("sessions");
        let llm_card = sample_character(&app, "苏鸢");
        let user_card = sample_character(&app, "旅人");
        let roster = |user: i64, llm: i64| {
            vec![
                RosterPickInput { character_id: user, is_user: true },
                RosterPickInput { character_id: llm, is_user: false },
            ]
        };

        let created = create_session_impl(&app, roster(user_card.id, llm_card.id), None, None).unwrap();
        assert_eq!(created.title, "", "缺省标题为空串（首条用户消息后回填属 TASK-006）");

        create_session_impl(&app, roster(user_card.id, llm_card.id), Some("旧书店".into()), None)
            .unwrap();
        let listed = list_sessions_impl(&app).unwrap();
        assert_eq!(listed.len(), 2);

        delete_session_impl(&app, created.id).unwrap();
        assert!(list_sessions_impl(&app).unwrap().len() == 1, "软删后列表不再可见");
        // 重复删除同一目标：已软删等价不可见 → NotFound。
        assert!(matches!(
            delete_session_impl(&app, created.id),
            Err(IpcError::NotFound { .. })
        ));
        // 阵容引用不存在的卡 → NotFound（实例化路径的逐卡语义，而非裸外键冲突）。
        assert!(matches!(
            create_session_impl(&app, roster(user_card.id, 999_999), None, None),
            Err(IpcError::NotFound { .. })
        ));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 阵容回显（多角色阵容制 wire，Task-31）：create / list 的 SessionSummary.instances
    /// 携带建会话快照（D1/D2）——快照名值拷贝、is_user 恰好一、模板溯源、renderStyle
    /// 快照；顺序 = 创建序（用户位在前）。改卡不回写既有会话的快照（D1 经 wire 可验）。
    #[test]
    fn session_summary_echoes_roster_instances() {
        let (app, dir) = temp_state("roster_echo");
        let llm_card = sample_character(&app, "苏鸢");
        let user_card = sample_character(&app, "旅人");
        let roster = vec![
            RosterPickInput { character_id: user_card.id, is_user: true },
            RosterPickInput { character_id: llm_card.id, is_user: false },
        ];

        let created =
            create_session_impl(&app, roster, Some("雨夜来电".into()), None).unwrap();
        // 回显 = 建会话入参的实例化快照；示例卡 render_style 均为缺省 "type"（models::NewCharacter）。
        assert_eq!(created.title, "雨夜来电", "title 保留在 wire（缺省空串由首条用户消息回填）");
        let echo: Vec<(&str, bool, Option<i64>, &str)> = created
            .instances
            .iter()
            .map(|i| (i.name.as_str(), i.is_user, i.character_id, i.render_style.as_str()))
            .collect();
        assert_eq!(
            echo,
            vec![
                ("旅人", true, Some(user_card.id), "type"),
                ("苏鸢", false, Some(llm_card.id), "type"),
            ],
            "instances 按创建序（用户位在前），快照字段齐全"
        );
        assert_eq!(created.instances[0].id, 1, "实例 id 为全局自增 PK，跨会话不重复");

        // list_sessions 同样回显（列表消费方〈侧栏 / 聊天说话人映射〉不依赖 create 返回值）。
        let listed = list_sessions_impl(&app).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].instances.len(), 2);

        // D1 快照语义：改卡不回写既有会话——renderStyle / 名字保持建会话时的值拷贝。
        app.storage.update_character(
            llm_card.id,
            &models::UpdateCharacter {
                name: "苏鸢·改".into(),
                avatar: llm_card.avatar.clone(),
                persona: llm_card.persona.clone(),
                gender: llm_card.gender.clone(),
                age: llm_card.age.clone(),
                render_style: "ink".into(),
                model_config: llm_card.model_config.clone(),
                accent_color: llm_card.accent_color.clone(),
                voice_config: None,
                calendar_config: None,
            },
        ).unwrap();
        let after = list_sessions_impl(&app).unwrap();
        let llm_instance = &after[0].instances[1];
        assert_eq!(llm_instance.name, "苏鸢", "实例名 = 建会话快照，改卡不回写");
        assert_eq!(llm_instance.render_style, "type", "renderStyle = 建会话快照，改卡不回写");
        assert_eq!(llm_instance.character_id, Some(llm_card.id), "模板溯源不变");

        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 分叉溯源真值回填（Task-45 接线）：list 路径（session_summary_with_roster）
    /// 从会话行取分叉两列真值——分叉会话回显源会话 id 与锚点场号，非分叉会话
    /// （建会话路径）保持 null。
    #[test]
    fn session_summary_carries_fork_fields_from_row() {
        let (app, dir) = temp_state("fork_fields");
        let user_card = sample_character(&app, "旅人");
        let llm_card = sample_character(&app, "苏鸢");
        let source = app
            .storage
            .create_session(&models::NewSession {
                roster: vec![
                    models::RosterPick { character_id: user_card.id, is_user: true },
                    models::RosterPick { character_id: llm_card.id, is_user: false },
                ],
                title: "雨夜来电".into(),
                opening: None,
            })
            .unwrap();
        let forked = app.storage.fork_session(source.id, 0, "雨夜来电（分叉）").unwrap();

        let listed = list_sessions_impl(&app).unwrap();
        let fork_row = listed.iter().find(|s| s.id == forked.id).unwrap();
        assert_eq!(fork_row.forked_from_session_id, Some(source.id), "list 回显源会话 id");
        assert_eq!(fork_row.fork_anchor_scene_idx, Some(0), "list 回显锚点场号");
        let source_row = listed.iter().find(|s| s.id == source.id).unwrap();
        assert_eq!(source_row.forked_from_session_id, None, "非分叉会话保持 null");
        assert_eq!(source_row.fork_anchor_scene_idx, None, "非分叉会话保持 null");
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_session_with_opening_seeds_calendar_and_anchor() {
        let (app, dir) = temp_state("opening");
        let llm_card = sample_character(&app, "苏鸢");
        let user_card = sample_character(&app, "旅人");
        let roster = vec![
            RosterPickInput { character_id: user_card.id, is_user: true },
            RosterPickInput { character_id: llm_card.id, is_user: false },
        ];

        let opening = SessionOpeningInput {
            calendar: Some(CalendarConfigDto {
                name: Some("旧都历".into()),
                months: vec!["霜月".into(), "白蜡月".into()],
                days_per_month: 30,
                day_names: vec!["晨露日".into(), "萤火日".into()],
                festivals: Some(std::collections::BTreeMap::from([(45, "灯节".into())])),
            }),
            fic_day: Some(45),
            fic_part: Some("夜".into()),
            location: Some("旧都 · 灯市".into()),
            time_note: None,
        };
        let created = create_session_impl(&app, roster.clone(), None, Some(&opening)).unwrap();

        // 会话日历 = 显式指定的 snake_case 存储 JSON（wire camelCase 不入库）。
        let stored = app.storage.get_session(created.id).unwrap().calendar_config.unwrap();
        assert!(stored.contains("days_per_month"), "存储 JSON 为 snake_case：{stored}");
        assert!(!stored.contains("daysPerMonth"), "存储 JSON 不得混入 wire 键：{stored}");
        // 开场锚行：idx=0、锚位与派生 date_label、在场 = 会话角色。
        let scene = app.storage.latest_scene(created.id).unwrap().unwrap();
        assert_eq!(scene.idx, 0);
        assert_eq!(scene.fic_day, Some(45));
        assert_eq!(scene.fic_part.as_deref(), Some("夜"));
        assert_eq!(scene.date_label.as_deref(), Some("白蜡月·晨露日·夜（灯节）"));
        assert_eq!(scene.location.as_deref(), Some("旧都 · 灯市"));
        // 在场 = 全部阵容实例（roster 输入序 = 实例创建序，多角色换挂语义）。
        assert_eq!(scene.present, vec![1, 2]);

        // 降级路径（opening = None）：默认锚行（day=1 / part=夜）无条件存在。
        let degraded = create_session_impl(&app, roster, None, None).unwrap();
        let scene = app.storage.latest_scene(degraded.id).unwrap().unwrap();
        assert_eq!((scene.idx, scene.fic_day, scene.fic_part.as_deref()), (0, Some(1), Some("夜")));
        assert_eq!(scene.date_label.as_deref(), Some("第1日·夜"), "角色无日历 → 数字形式");
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// FR-014：开局入参校验（Conflict）——时段六值、起始日 ≥ 1、显式日历皮肤可用性。
    #[test]
    fn create_session_rejects_invalid_opening() {
        let (app, dir) = temp_state("opening_invalid");
        let llm_card = sample_character(&app, "苏鸢");
        let user_card = sample_character(&app, "旅人");
        let roster = vec![
            RosterPickInput { character_id: user_card.id, is_user: true },
            RosterPickInput { character_id: llm_card.id, is_user: false },
        ];

        let mut opening = SessionOpeningInput {
            calendar: None,
            fic_day: None,
            fic_part: None,
            location: None,
            time_note: None,
        };
        // 时段不在六值内 → Conflict。
        let bad_part = SessionOpeningInput { fic_part: Some("半夜三更".into()), ..opening.clone() };
        assert!(matches!(
            create_session_impl(&app, roster.clone(), None, Some(&bad_part)),
            Err(IpcError::Conflict { .. })
        ));
        // 起始日 < 1 → Conflict。
        let bad_day = SessionOpeningInput { fic_day: Some(0), ..opening.clone() };
        assert!(matches!(
            create_session_impl(&app, roster.clone(), None, Some(&bad_day)),
            Err(IpcError::Conflict { .. })
        ));
        // 显式日历缺月长基准（days_per_month = 0）→ Conflict（对齐 has_skin）。
        opening.calendar = Some(CalendarConfigDto {
            name: Some("坏历".into()),
            months: vec!["霜月".into()],
            days_per_month: 0,
            day_names: Vec::new(),
            festivals: None,
        });
        assert!(matches!(
            create_session_impl(&app, roster, None, Some(&opening)),
            Err(IpcError::Conflict { .. })
        ));
        // 校验失败零落库（连降级锚行也没有）。
        assert!(list_sessions_impl(&app).unwrap().is_empty());
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
