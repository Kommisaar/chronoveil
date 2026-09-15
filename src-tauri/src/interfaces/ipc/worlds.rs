//! 世界域（2026-09-15 世界卡定稿）：世界卡 CRUD 及其 wire DTO。
//!
//! 历法 wire ↔ 存储两种形态的换算收口在本文件：wire = `CalendarConfigDto`
//!（camelCase，复用 sessions 域定义）；存储 = Rust serde 序列化 domain
//! `CalendarConfig` 得 snake_case JSON 文本（与 sessions 域同一约束——前端
//! 永不手写存储 JSON）。

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::domain::fiction_time;
use crate::domain::models;
use crate::domain::ports::StoragePort;
use crate::state::AppState;

use super::error::IpcError;
use super::sessions::CalendarConfigDto;

/// 世界卡摘要（世界页卡片 + 编辑表单全量预填，口径同 CharacterSummary——列表
/// 即编辑数据源，避免预填再发单条查询）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorldSummary {
    pub id: i64,
    pub name: String,
    /// 世界观正文（markdown-lite，同人设）；空白 = 装配省略。
    pub worldbook: String,
    /// 历法预设（wire DTO）；None = 内置默认历。
    pub calendar: Option<CalendarConfigDto>,
    pub updated_at: i64,
}

/// 领域世界卡 → 摘要 DTO。存储 JSON → wire 历法：坏 JSON 降级 None（默认历）——
/// 与 `fiction_time::parse` 的降级哲学同源（皮肤坏了退默认，不阻塞主流程；
/// 编辑器以 None 回显，保存即自愈为默认历）。
fn world_summary_from(w: models::World) -> WorldSummary {
    let calendar = w.calendar_config.as_deref().and_then(|json| {
        serde_json::from_str::<fiction_time::CalendarConfig>(json)
            .ok()
            .map(|cal| CalendarConfigDto::from(&cal))
    });
    WorldSummary {
        id: w.id,
        name: w.name,
        worldbook: w.worldbook,
        calendar,
        updated_at: w.updated_at,
    }
}

/// 世界卡写侧入参（创建与整卡更新共用形态，对齐 WorldInput ↔ NewWorld 字段面）。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorldInput {
    pub name: String,
    pub worldbook: String,
    /// None = 内置默认历。
    pub calendar: Option<CalendarConfigDto>,
}

impl WorldInput {
    /// 入口校验：名称非空白（同 CharacterInput）；显式历法需满足命名皮肤
    /// 可用性（对齐 `fiction_time::validate`，与开局日历判定同口径）。
    fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("名称不能为空白".to_string());
        }
        if let Some(dto) = &self.calendar {
            let cal = fiction_time::CalendarConfig::from(dto);
            if !fiction_time::validate(&cal) {
                return Err("历法需每月天数 > 0 且月名 / 日名至少其一非空".to_string());
            }
        }
        Ok(())
    }

    /// 校验 + wire 历法 → 存储 JSON 文本（domain 序列化产 snake_case 键）。
    fn into_new_world(self) -> Result<models::NewWorld, IpcError> {
        self.validate().map_err(|message| IpcError::Conflict { message })?;
        let calendar_config = match &self.calendar {
            Some(dto) => Some(
                serde_json::to_string(&fiction_time::CalendarConfig::from(dto)).map_err(
                    |e| IpcError::Storage {
                        message: format!("世界历法序列化失败：{e}"),
                    },
                )?,
            ),
            None => None,
        };
        Ok(models::NewWorld {
            name: self.name,
            worldbook: self.worldbook,
            calendar_config,
        })
    }
}

// ---- 世界卡 CRUD ----

fn list_worlds_impl(app: &AppState) -> Result<Vec<WorldSummary>, IpcError> {
    Ok(app
        .storage
        .list_worlds()?
        .into_iter()
        .map(world_summary_from)
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn list_worlds(state: State<'_, AppState>) -> Result<Vec<WorldSummary>, IpcError> {
    list_worlds_impl(&state)
}

// 相邻域（sessions）的历法流经测试复用 create 收尾，故对 ipc 子树可见
//（同 characters::create_character_impl 惯例）。
pub(super) fn create_world_impl(app: &AppState, input: WorldInput) -> Result<WorldSummary, IpcError> {
    let created = app.storage.create_world(&input.into_new_world()?)?;
    Ok(world_summary_from(created))
}

#[tauri::command]
#[specta::specta]
pub fn create_world(state: State<'_, AppState>, input: WorldInput) -> Result<WorldSummary, IpcError> {
    create_world_impl(&state, input)
}

fn update_world_impl(
    app: &AppState,
    id: i64,
    input: WorldInput,
) -> Result<(), IpcError> {
    let new = input.into_new_world()?;
    app.storage.update_world(
        id,
        &models::UpdateWorld {
            name: new.name,
            worldbook: new.worldbook,
            calendar_config: new.calendar_config,
        },
    )?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn update_world(
    state: State<'_, AppState>,
    id: i64,
    input: WorldInput,
) -> Result<(), IpcError> {
    update_world_impl(&state, id, input)
}

fn delete_world_impl(app: &AppState, id: i64) -> Result<(), IpcError> {
    // 软删（ADR-009）；已实例化的会话世界不受影响（快照冻结，D1）。
    app.storage.soft_delete_world(id)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn delete_world(state: State<'_, AppState>, id: i64) -> Result<(), IpcError> {
    delete_world_impl(&state, id)
}

#[cfg(test)]
mod tests;
