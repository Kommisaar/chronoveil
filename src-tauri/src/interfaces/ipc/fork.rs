//! 会话分叉域（时间线分叉，多角色第 3 步）：wire 命令接线 infra 存储分叉服务
//! （Task-43 存储链 + Task-44 wire 契约，Task-45 完成 stub→真实接线）。
//!
//! wire 契约（Task-44 冻结，接线未改签名）：
//! - 命令名 `fork_session`（wire camelCase `forkSession`），入参 `sessionId` /
//!   `anchorSceneIdx` / `title`（平铺 invoke 参数，非包裹对象）；
//! - 返回新建会话摘要（SessionSummary，含 `forkedFromSessionId` /
//!   `forkAnchorSceneIdx` 两回显字段）；语义 = 从源会话锚点场分叉新会话（含锚点场
//!   及其之前的消息 / 状态），前端成功后走 `refreshSessions` 单点重拉；
//! - 错误：锚点场号不存在 → `NotFound { entity: "scene" }`（id 位携带场号 idx，
//!   非行主键）；源会话不存在 / 已删 → `NotFound { entity: "session" }`。

use tauri::State;

use crate::domain::ports::StoragePort;
use crate::state::AppState;

use super::error::IpcError;
use super::sessions::{SessionSummary, session_summary_with_roster};

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
    // 分叉本体在存储端口（单事务拷贝编排，见 infra/storage/session_fork.rs）：源会话
    // 在世校验与锚点场号校验都在其内（软删等价不可见 / 墓碑锚无意义，ADR-009），
    // IPC 层不重复预查；`title` 直通落库（分叉标题恒显式传入，见命令注释）。摘要
    // 组装走 session_summary_with_roster 单点——新线阵容回显查新会话实例表真值，
    // 分叉溯源两字段取新会话行真值。
    let session = app.storage.fork_session(session_id, anchor_scene_idx, title)?;
    session_summary_with_roster(app, session)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models;
    use crate::domain::ports::{AttachRange, SettlementWrite, StoragePort};
    use crate::interfaces::ipc::test_support::{sample_character, temp_state};

    use crate::interfaces::ipc::sessions::SessionInstanceDto;

    /// 在世源会话夹具：双卡双人阵容（旅人用户位 + 苏鸢 LLM 位）建会话。
    fn seed_session(app: &AppState, title: &str) -> models::Session {
        let user_card = sample_character(app, "旅人");
        let llm_card = sample_character(app, "苏鸢");
        app.storage
            .create_session(&models::NewSession {
                roster: vec![
                    models::RosterPick { character_id: user_card.id, is_user: true },
                    models::RosterPick { character_id: llm_card.id, is_user: false },
                ],
                title: title.into(),
                opening: None,
            })
            .unwrap()
    }

    /// 源世界夹具：建会话（开场锚行 idx 0 无条件 seed）→ 插 2 条消息并结算归属
    /// 锚场（同拍开出 idx 1 新场，FR-011 边界快照模型）→ 再插 2 条未归属消息
    /// （属于进行中的 idx 1 场）。返回（源会话，[用户位, LLM 位] 实例 id）。
    fn seed_world(app: &AppState) -> (models::Session, [i64; 2]) {
        let session = seed_session(app, "雨夜来电");
        let instances = app.storage.list_instances(session.id).unwrap();
        let user = instances.iter().find(|i| i.is_user).unwrap().id;
        let llm = instances.iter().find(|i| !i.is_user).unwrap().id;

        let mut m1 = models::NewMessage::new(session.id, models::MessageRole::User, "推门进店");
        m1.instance_id = Some(user);
        app.storage.insert_message(&m1).unwrap();
        let mut m2 =
            models::NewMessage::new(session.id, models::MessageRole::Assistant, "欢迎光临旧书店");
        m2.instance_id = Some(llm);
        let m2 = app.storage.insert_message(&m2).unwrap();

        // 结算一拍：锚场（idx 0）收束，上述两条消息归属锚场；同拍开出 idx 1 新场。
        let anchor = app.storage.latest_scene(session.id).unwrap().unwrap();
        app.storage
            .commit_settlement(&SettlementWrite {
                scene: models::NewScene {
                    session_id: session.id,
                    location: Some("钟楼下".into()),
                    time_note: None,
                    fic_day: Some(2),
                    fic_part: Some("夜".into()),
                    date_label: None,
                    summary: None,
                    recap: None,
                    present: vec![user, llm],
                },
                close_scene_id: Some(anchor.id),
                close_summary: Some("雨夜旧书店打烊".into()),
                close_recap: None,
                attach: Some(AttachRange {
                    scene_id: anchor.id,
                    after_message_id: 0,
                    upto_message_id: m2.id,
                }),
                state_upserts: vec![],
                state_clears: vec![],
            })
            .unwrap();

        // 未归属消息（scene_id IS NULL）：进行中 idx 1 场的对话，锚点取 idx 0 时不随线。
        let mut m3 = models::NewMessage::new(session.id, models::MessageRole::User, "再看看钟楼");
        m3.instance_id = Some(user);
        app.storage.insert_message(&m3).unwrap();
        let mut m4 =
            models::NewMessage::new(session.id, models::MessageRole::Assistant, "夜色更深了");
        m4.instance_id = Some(llm);
        app.storage.insert_message(&m4).unwrap();

        (session, [user, llm])
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

    /// 真实接线（Task-45）：分叉走存储端口单事务拷贝，返回摘要 = 新会话行真值
    /// （分叉溯源两字段 + 新线阵容回显 + 标题直通）；关键落库效果冒烟——新会话
    /// 存在、场景只拷到锚点、锚前归属消息随线而锚后未归属消息不随线、源线零影响
    /// （拷贝全量口径由 storage 层 session_fork 测试兜底）。
    #[test]
    fn fork_session_wires_storage_fork_and_echoes_new_session_summary() {
        let (app, dir) = temp_state("fork_wired");
        let (source, [user, llm]) = seed_world(&app);

        let created = fork_session_impl(&app, source.id, 0, "雨夜来电（分叉）").unwrap();
        // 摘要 = 新会话行真值：溯源两字段回显、标题直通（IPC 层传入值原样落库回显）。
        assert_eq!(created.forked_from_session_id, Some(source.id));
        assert_eq!(created.fork_anchor_scene_idx, Some(0));
        assert_eq!(created.title, "雨夜来电（分叉）");
        assert!(created.updated_at >= source.updated_at, "新线 updated_at = 分叉时刻");
        // 阵容回显 = 新会话实例表真值：逐实例再实例化（新 id、快照值同源、用户位在前）。
        assert_eq!(
            created
                .instances
                .iter()
                .map(|i| (i.name.as_str(), i.is_user))
                .collect::<Vec<_>>(),
            vec![("旅人", true), ("苏鸢", false)]
        );
        assert!(
            created.instances.iter().all(|i| i.id != user && i.id != llm),
            "实例在新线再实例化，不复用源线实例 id"
        );

        // 关键落库效果：新会话行存在且溯源两列落值；场景只拷到锚点（idx 0 一场，
        // 锚后的 idx 1 不拷）；锚场归属消息随线、锚后未归属消息不随线；源线零影响。
        let row = app.storage.get_session(created.id).unwrap();
        assert_eq!(row.forked_from_session_id, Some(source.id));
        assert_eq!(row.fork_anchor_scene_idx, Some(0));
        let new_scenes = app.storage.list_scenes(created.id).unwrap();
        assert_eq!(
            new_scenes.iter().map(|s| s.idx).collect::<Vec<_>>(),
            vec![0],
            "只拷锚点场"
        );
        let new_msgs = app.storage.list_messages(created.id).unwrap();
        let contents: Vec<&str> = new_msgs.iter().map(|m| m.content.as_str()).collect();
        assert_eq!(contents, vec!["推门进店", "欢迎光临旧书店"], "锚前归属消息随线");
        assert_eq!(app.storage.list_scenes(source.id).unwrap().len(), 2, "源线场次不动");
        assert_eq!(app.storage.list_messages(source.id).unwrap().len(), 4, "源线消息不动");
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 错误契约（接线后全为存储端口真实路径，语义不变）：源会话不存在 / 已删 →
    /// NotFound(session)；锚点号无对应在世场 → NotFound(scene)（id 位 = 传入场号
    /// idx）；失败路径零落库（单事务回滚 + 校验前置）。
    #[test]
    fn fork_session_errors_are_not_found_from_storage_port() {
        let (app, dir) = temp_state("fork_errors");
        // 不存在 → NotFound(session)。
        let err = fork_session_impl(&app, 999, 0, "分叉").unwrap_err();
        assert!(matches!(err, IpcError::NotFound { entity, id } if entity == "session" && id == 999));

        // 已软删等价不可见（ADR-009）→ NotFound(session)。
        let (session, _) = seed_world(&app);
        app.storage.soft_delete_session(session.id).unwrap();
        let err = fork_session_impl(&app, session.id, 0, "分叉").unwrap_err();
        assert!(matches!(err, IpcError::NotFound { entity, .. } if entity == "session"));

        // 在世会话但锚点号越界（世界只有 idx 0/1 两场）→ NotFound(scene)。
        let (live, _) = seed_world(&app);
        let err = fork_session_impl(&app, live.id, 9, "越界锚点").unwrap_err();
        assert!(matches!(err, IpcError::NotFound { entity, id } if entity == "scene" && id == 9));
        // 失败不产生新会话（在世源会话仅本测试的世界，两条源线一条已删）。
        assert_eq!(app.storage.list_sessions().unwrap().len(), 1, "仅剩在世源会话");
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
