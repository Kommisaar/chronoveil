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
    // 风格跟随全局（0014）：读当次 config 的 render_style 作为 NULL 卡的
    // 实例化回落值（快照仍冻结具体值，D1）。
    let default_render_style = app.config.load()?.render_style;
    let session = app.storage.create_session(&models::NewSession {
        roster: roster
            .into_iter()
            .map(|pick| models::RosterPick { character_id: pick.character_id, is_user: pick.is_user })
            .collect(),
        title: title.unwrap_or_default(),
        default_render_style,
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
mod tests;
