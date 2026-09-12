//! 会话分叉域（时间线分叉，多角色第 3 步 / Task-44 契约冻结 stub）。
//!
//! **契约冻结**（Task-44，Rust 侧真实实现由 Task-43 并行落地，两侧以本节为准）：
//! - 命令名 `fork_session`（wire camelCase `forkSession`），入参 `sessionId` /
//!   `anchorSceneIdx` / `title`（平铺 invoke 参数，非包裹对象）；
//! - 返回新建会话摘要（SessionSummary，含 `forkedFromSessionId` /
//!   `forkAnchorSceneIdx` 两回显字段）；语义 = 从源会话锚点场分叉新会话（含锚点场
//!   及其之前的消息 / 状态），前端成功后走 `refreshSessions` 单点重拉；
//! - 错误：锚点场号不存在 → `NotFound { entity: "scene" }`（id 位携带场号 idx，
//!   非行主键）；源会话不存在 / 已删 → `NotFound { entity: "session" }`。
//!
//! **stub 边界与移除条件**：本文件当前只承载 wire 签名与入参校验，分叉本体返回
//! `Unavailable`（「分叉服务尚未接线」）；源会话在世校验已是真实路径（Task-43
//! 语义不变，可保留）。Task-43 合入后把 `fork_session_impl` 的错误桩换成分叉
//! 服务调用，届时删除本头注的 stub 段落。

use tauri::State;

use crate::domain::ports::StoragePort;
use crate::state::AppState;

use super::error::IpcError;
use super::sessions::SessionSummary;

// ---- 会话分叉（时间线分叉 wire，Task-44 契约冻结）----

/// 分叉命令（时间线分叉，Task-44）：`session_id` = 源会话；`anchor_scene_idx` =
/// 锚点场号（同会话内单调叙事序，SceneDto.idx 同源）；`title` = 新会话标题
/// （UI 默认「原标题（分叉）」，后端不截断回填——与 create_session 的缺省标题
/// 路径不同，分叉标题恒显式传入）。
#[tauri::command]
#[specta::specta]
pub fn fork_session(
    state: State<'_, AppState>,
    session_id: i64,
    anchor_scene_idx: i64,
    title: String,
) -> Result<SessionSummary, IpcError> {
    fork_session_impl(&state, session_id, anchor_scene_idx, &title)
}

fn fork_session_impl(
    app: &AppState,
    session_id: i64,
    anchor_scene_idx: i64,
    title: &str,
) -> Result<SessionSummary, IpcError> {
    // 源会话在世校验（真实路径）：不存在 / 已软删报 NotFound（ADR-009 等价语义），
    // 与 list_messages_impl 等读路径同判定；分叉结果概要也走同源回显。
    app.storage.get_session(session_id)?;
    // 锚点场号存在性校验位（Task-43 接线点）：真实实现需按场表校验 idx 落在源
    // 会话场界内，NotFound { entity: "scene" }；stub 阶段不查场表，统一落未接线
    // 错误（见下）。
    let _ = anchor_scene_idx;
    let _ = title;
    Err(IpcError::Unavailable {
        message: "分叉服务尚未接线（Task-43 落地时间线分叉服务）".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models;
    use crate::domain::ports::StoragePort;
    use crate::interfaces::ipc::test_support::{sample_character, temp_state};

    use crate::interfaces::ipc::sessions::SessionInstanceDto;

    /// 在世源会话夹具：单卡双人阵容（用户位 + LLM 位）建会话。
    fn seed_session(app: &AppState, title: &str) -> models::Session {
        let card = sample_character(app, "苏鸢");
        app.storage
            .create_session(&models::NewSession {
                roster: vec![
                    models::RosterPick { character_id: card.id, is_user: true },
                    models::RosterPick { character_id: card.id, is_user: false },
                ],
                title: title.into(),
                opening: None,
            })
            .unwrap()
    }

    /// 返回值契约：SessionSummary 携带分叉溯源回显字段（wire camelCase：
    /// forkedFromSessionId / forkAnchorSceneIdx；非分叉会话 = null，该形态由
    /// sessions.rs 的 session_summary_serializes_camel_case 兜底）。
    #[test]
    fn session_summary_fork_fields_serialize_camel_case() {
        let json = serde_json::to_value(SessionSummary {
            id: 7,
            title: "雨夜来电（分叉）".into(),
            updated_at: 42,
            instances: vec![SessionInstanceDto {
                id: 1,
                name: "旅人".into(),
                is_user: true,
                character_id: None,
                render_style: "type".into(),
            }],
            forked_from_session_id: Some(3),
            fork_anchor_scene_idx: Some(2),
        })
        .unwrap();
        assert_eq!(json["forkedFromSessionId"], 3, "源会话 id 回显");
        assert_eq!(json["forkAnchorSceneIdx"], 2, "锚点场号回显");
    }

    /// 错误契约（stub 阶段可断言的两条）：源会话不存在 / 已删 → NotFound；
    /// 在世会话 → Unavailable（分叉服务未接线的显式错误，非静默）。
    #[test]
    fn fork_session_missing_source_is_not_found_and_wired_path_is_unavailable_stub() {
        let (app, dir) = temp_state("fork_stub");
        // 不存在 → NotFound（storage.get_session 的真实错误路径，Task-43 保留）。
        let err = fork_session_impl(&app, 999, 0, "分叉").unwrap_err();
        assert!(matches!(err, IpcError::NotFound { entity, id } if entity == "session" && id == 999));

        // 已软删等价不可见（ADR-009）→ NotFound。
        let session = seed_session(&app, "雨夜来电");
        app.storage.soft_delete_session(session.id).unwrap();
        let err = fork_session_impl(&app, session.id, 0, "分叉").unwrap_err();
        assert!(matches!(err, IpcError::NotFound { .. }));

        // 在世会话 → 分叉本体尚未接线：Unavailable 桩（Task-43 换成真实调用后，
        // 本断言连同 stub 段一并替换为分叉结果契约测试）。
        let session = seed_session(&app, "旧书店");
        let err = fork_session_impl(&app, session.id, 0, "旧书店（分叉）").unwrap_err();
        assert!(matches!(err, IpcError::Unavailable { .. }));
        assert!(err.to_string().contains("分叉服务尚未接线"), "实际：{err}");
        // stub 不产生任何新会话（错误路径零落库）。
        assert_eq!(app.storage.list_sessions().unwrap().len(), 1, "仅剩在世源会话");
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
