//! 生成域（TASK-006 闭环接线：FR-001 / FR-007 / FR-008 / SEQ-001）：
//! 发送消息、取消生成、重新生成最后一条，以及生成任务的命令层装配。

use std::sync::Arc;

use tauri::State;

use crate::domain::models;
use crate::domain::ports::StoragePort;
use crate::infra::llm::{EventSink, LlmClient};
use crate::services::{
    director,
    generation::{self, GenerationDeps, PendingGeneration},
};
use crate::state::AppState;

use super::error::IpcError;
use super::messages::{to_chat_message, ChatMessage};

/// 生成任务驱动器：命令层传 `tauri::async_runtime::spawn`，测试传 no-op（不经运行时）。
pub(crate) type GenerationSpawner = Arc<dyn Fn(PendingGeneration) + Send + Sync>;

// ---- 生成（TASK-006 闭环接线：FR-001 / FR-007 / FR-008 / SEQ-001）----

/// 命令层生成任务驱动：交给 Tauri 异步运行时（fire-and-forget；终态经事件通道回传）。
fn tauri_spawner() -> GenerationSpawner {
    Arc::new(|pending: PendingGeneration| {
        tauri::async_runtime::spawn(pending.run());
    })
}

fn generation_deps(app: &AppState, sink: Arc<dyn EventSink>, llm: LlmClient) -> GenerationDeps {
    // 配置读取一次（读当次值不缓存，ADR-012），派生两个装配期参数：
    // - 导演模型解析（FR-011 / INT-003）：跟随主模型、不做角色级覆写（§7-5）。
    //   解析失败 = 未配置 → None，生成闭环跳过结算（导演是可选能力，不阻塞生成）。
    // - 近景场景数（近景窗口可选化）：1–6，缺省 2；config 读取失败（坏文件等）
    //   回落 ADR-004 默认值，不阻塞正文生成。
    let config = app.config.load().ok();
    let director_llm = config
        .as_ref()
        .and_then(|config| director::resolve_director_llm(config).ok())
        .map(|client| Arc::new(with_call_trace(app, client)));
    let near_scenes = config
        .map_or(
            crate::domain::context::SETTLED_SCENES_IN_NEAR,
            |config| config.near_scenes as usize,
        );
    GenerationDeps {
        storage: app.storage.clone(),
        sink,
        llm: Arc::new(llm),
        director_llm,
        near_scenes,
    }
}

/// 给解析好的客户端挂接调用轨迹 sink（透明化功能）：组合根 setup 注入的组合实现
/// （TauriCallSink：落库 + Trace 事件）经 AppState 取用；None = 测试装配未注入，
/// 不记录（轨迹是旁路，缺席不阻塞任何主流程）。AI 起草历法（draft_calendar 域）
/// 的单次调用同样经此挂接，故对 ipc 子树可见。
pub(super) fn with_call_trace(app: &AppState, llm: LlmClient) -> LlmClient {
    match app.call_sink() {
        Some(sink) => llm.with_call_sink(sink),
        None => llm,
    }
}

/// 两级模型配置解析（INT-002 / 验收 4）多角色裁量版：config.json 全局默认 ←
/// 「主持实例」模板卡的 model_config 覆写。主持实例 = 首个 LLM 位实例（与
/// generation::host_instance 同一归属语义）；实例无模板（动态造人）或无 LLM 位
/// （畸形阵容，存储层已拒绝）→ 不覆写，跟随全局默认。
fn resolve_llm(app: &AppState, session_id: i64) -> Result<LlmClient, IpcError> {
    let host_card = app
        .storage
        .list_instances(session_id)?
        .into_iter()
        .find(|i| !i.is_user)
        .and_then(|i| i.character_id)
        .map(|id| app.storage.get_character(id))
        .transpose()?;
    let config = app.config.load()?;
    let llm_config = generation::resolve_effective_llm(&config, host_card.as_ref())
        .map_err(|message| IpcError::Config { message })?;
    let llm =
        LlmClient::new(llm_config).map_err(|e| IpcError::Config { message: e.to_string() })?;
    Ok(with_call_trace(app, llm))
}

fn send_message_impl(
    app: &AppState,
    sink: Arc<dyn EventSink>,
    spawner: &GenerationSpawner,
    session_id: i64,
    content: String,
) -> Result<ChatMessage, IpcError> {
    let session = app.storage.get_session(session_id)?;
    let trimmed = content.trim().to_string();
    if trimmed.is_empty() {
        return Err(IpcError::Conflict { message: "消息内容为空".into() });
    }
    let llm = resolve_llm(app, session.id)?;
    // 同会话互斥（FR-007 多路并发为跨会话并发；同会话重复触发拒绝，FR-008）。
    let ticket = app
        .generation
        .begin(session_id)
        .map_err(|_| IpcError::Conflict { message: "该会话已有进行中的生成".into() })?;
    // 用户条先落库（FR-001 / SEQ-001：RS->RS 落库用户消息），归属用户位实例
    // （多角色换挂；恰一用户位由建会话保证）。
    let user_instance = app
        .storage
        .list_instances(session_id)?
        .into_iter()
        .find(|i| i.is_user);
    let user_message = match app.storage.insert_message(&models::NewMessage {
        instance_id: user_instance.map(|i| i.id),
        ..models::NewMessage::new(session_id, models::MessageRole::User, trimmed.clone())
    }) {
        Ok(m) => m,
        Err(e) => {
            app.generation.finish(session_id);
            return Err(e.into());
        }
    };
    // FR-007：会话标题缺省取首条用户消息截断。
    if session.title.is_empty() {
        if let Err(e) = app
            .storage
            .update_session_title(session_id, &generation::default_title(&trimmed))
        {
            app.generation.finish(session_id);
            return Err(e.into());
        }
    }
    spawner(PendingGeneration {
        deps: generation_deps(app, sink, llm),
        registry: app.generation.clone(),
        ticket,
        regenerate: false,
    });
    Ok(to_chat_message(user_message, None))
}

#[tauri::command]
#[specta::specta]
pub fn send_message(
    state: State<'_, AppState>,
    session_id: i64,
    content: String,
) -> Result<ChatMessage, IpcError> {
    send_message_impl(&state, state.sink(), &tauri_spawner(), session_id, content)
}

fn cancel_generation_impl(app: &AppState, session_id: i64) -> Result<bool, IpcError> {
    // 无活跃生成即幂等 no-op（返回 false）；有则瞬时取消（FR-001 / NFR-004），
    // 半条按 cancel 终态落库并经 error 事件收尾（services/generation）。
    Ok(app.generation.cancel(session_id))
}

#[tauri::command]
#[specta::specta]
pub fn cancel_generation(state: State<'_, AppState>, session_id: i64) -> Result<bool, IpcError> {
    cancel_generation_impl(&state, session_id)
}

fn regenerate_last_impl(
    app: &AppState,
    sink: Arc<dyn EventSink>,
    spawner: &GenerationSpawner,
    session_id: i64,
) -> Result<ChatMessage, IpcError> {
    let session = app.storage.get_session(session_id)?;
    let llm = resolve_llm(app, session.id)?;
    // FR-008：只对最后一条 assistant 消息提供重新生成。
    let old = app
        .storage
        .latest_assistant_message(session_id)?
        .ok_or_else(|| IpcError::Conflict { message: "会话没有可重新生成的回复".into() })?;
    let ticket = app
        .generation
        .begin(session_id)
        .map_err(|_| IpcError::Conflict { message: "该会话已有进行中的生成".into() })?;
    spawner(PendingGeneration {
        deps: generation_deps(app, sink, llm),
        registry: app.generation.clone(),
        ticket,
        regenerate: true,
    });
    // 返回被替换的旧条：前端据此将其从界面移除（旧条软删发生在终态落库时，FR-008）；
    // speaker = 消息自带实例真值（机械适配，同 list_messages_impl）。
    let speaker = old.instance_id;
    Ok(to_chat_message(old, speaker))
}

#[tauri::command]
#[specta::specta]
pub fn regenerate_last(state: State<'_, AppState>, session_id: i64) -> Result<ChatMessage, IpcError> {
    regenerate_last_impl(&state, state.sink(), &tauri_spawner(), session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::{NewMessage, NewSession, RosterPick};
    use crate::interfaces::ipc::messages::MessageRole;
    use crate::interfaces::ipc::test_support::{sample_character, temp_state};

    // ---- 生成命令测试替身（不经 Tauri 运行时 / 事件通道）----

    struct DropSink;

    impl crate::infra::llm::EventSink for DropSink {
        fn emit(&self, _event: crate::infra::llm::LlmEvent) {}
    }

    fn noop_sink() -> Arc<dyn crate::infra::llm::EventSink> {
        Arc::new(DropSink)
    }

    fn noop_spawner() -> GenerationSpawner {
        Arc::new(|_pending: PendingGeneration| {
            // 测试不驱动生成任务（闭环集成见 services/generation 的 mock 网关测试）。
        })
    }

    #[test]
    fn generation_commands_wire_send_cancel_and_regenerate() {
        let (app, dir) = temp_state("generation");
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
            })
            .unwrap();

        // Provider 未配置 → 类型化 Config 错误；用户条与注册表零副作用。
        let err = send_message_impl(&app, noop_sink(), &noop_spawner(), session.id, "你好".into())
            .unwrap_err();
        assert!(matches!(err, IpcError::Config { .. }));
        assert!(app.storage.list_messages(session.id).unwrap().is_empty());

        // 配置全局默认 Provider（两级配置的底层，FR-009；双层级 provider→models）。
        let mut config = crate::infra::config::Config::new_with_defaults();
        config.providers = vec![crate::infra::config::ProviderConfig {
            id: "p1".into(),
            name: "测试".into(),
            base_url: "http://127.0.0.1:9/v1".into(),
            api_key: "k".into(),
            models: vec!["m".into()],
            model: None,
        }];
        config.active_provider_id = Some("p1".into());
        config.active_model = Some("m".into());
        app.config.save(&config).unwrap();

        // 发送：用户条立即落库返回（SEQ-001），生成任务交 spawner（测试 no-op 不驱动）。
        let user = send_message_impl(&app, noop_sink(), &noop_spawner(), session.id, "你好".into())
            .unwrap();
        assert_eq!(user.role, MessageRole::User);
        assert!(user.character_id.is_none(), "用户消息 speaker 为 null");
        assert_eq!(app.storage.list_messages(session.id).unwrap().len(), 1);
        // FR-007：标题缺省取首条用户消息截断。
        assert_eq!(app.storage.get_session(session.id).unwrap().title, "你好");

        // 注册表已占用：同会话重复发送 / 重新生成被拒（FR-007 / FR-008）。
        assert!(matches!(
            send_message_impl(&app, noop_sink(), &noop_spawner(), session.id, "第二条".into()),
            Err(IpcError::Conflict { .. })
        ));
        assert!(matches!(
            regenerate_last_impl(&app, noop_sink(), &noop_spawner(), session.id),
            Err(IpcError::Conflict { .. })
        ));
        // 取消活跃生成：返回 true；随后无活跃生成时取消为幂等 no-op（false）。
        assert!(cancel_generation_impl(&app, session.id).unwrap());
        assert!(!cancel_generation_impl(&app, session.id).unwrap());

        // 边界校验：空内容 Conflict、不存在会话 NotFound、无 assistant 条不可重新生成。
        assert!(matches!(
            send_message_impl(&app, noop_sink(), &noop_spawner(), session.id, "   ".into()),
            Err(IpcError::Conflict { .. })
        ));
        assert!(matches!(
            send_message_impl(&app, noop_sink(), &noop_spawner(), 999_999, "你好".into()),
            Err(IpcError::NotFound { .. })
        ));
        assert!(matches!(
            regenerate_last_impl(&app, noop_sink(), &noop_spawner(), 999_999),
            Err(IpcError::NotFound { .. })
        ));
        assert!(matches!(
            regenerate_last_impl(&app, noop_sink(), &noop_spawner(), session.id),
            Err(IpcError::Conflict { .. })
        ));

        // 有 assistant 条后重新生成：返回旧条（前端据以从界面移除），注册表占用；
        // speaker = 实例真值（消息自带 instance_id，机械适配）。
        app.storage
            .insert_message(&NewMessage {
                instance_id: Some(1),
                ..NewMessage::new(session.id, models::MessageRole::Assistant, "旧回复")
            })
            .unwrap();
        let old = regenerate_last_impl(&app, noop_sink(), &noop_spawner(), session.id).unwrap();
        assert_eq!(old.role, MessageRole::Assistant);
        assert_eq!(old.content, "旧回复");
        assert_eq!(old.character_id, Some(1), "speaker = 说话人实例 id");
        assert!(cancel_generation_impl(&app, session.id).unwrap());
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
