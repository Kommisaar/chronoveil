//! AI 起草历法域（FR-014 二期）：单次结构化 LLM 调用，结果仅供审阅，不落库。

use tauri::State;

use crate::infra::llm::{cancel_channel, CancelHandle};
use crate::services::calendar_draft;
use crate::state::AppState;

use super::error::IpcError;
use super::generation::with_call_trace;
use super::sessions::CalendarConfigDto;

// ---- AI 起草历法（FR-014 二期：单次结构化调用，结果仅供审阅，不落库）----

/// 起草错误 → IpcError 分型：入参 / 模型输出不合格 / 取消 → Conflict（用户可
/// 修正或重试的错误，文案即原因）；LLM 网关错误 → Unavailable（网络 / 401 /
/// 429 / 协议，可稍后重试或检查设置）。
fn map_draft_error(error: calendar_draft::CalendarDraftError) -> IpcError {
    use calendar_draft::CalendarDraftError as DraftError;
    match error {
        DraftError::InvalidDescription(_)
        | DraftError::InvalidOutput(_)
        | DraftError::Cancelled => IpcError::Conflict { message: error.to_string() },
        DraftError::Llm(llm_error) => IpcError::Unavailable { message: llm_error.to_string() },
    }
}

async fn draft_calendar_impl(
    app: &AppState,
    description: &str,
    cancel: &CancelHandle,
) -> Result<CalendarConfigDto, IpcError> {
    // 全局默认模型解析（起草不吃角色覆写 / 导演专用模型，见 calendar_draft）。
    let llm = with_call_trace(
        app,
        calendar_draft::resolve_draft_llm(&app.config.load()?)
            .map_err(|message| IpcError::Config { message })?,
    );
    let calendar = calendar_draft::draft_calendar(&llm, description, cancel)
        .await
        .map_err(map_draft_error)?;
    Ok(CalendarConfigDto::from(&calendar))
}

/// AI 起草历法（FR-014 二期）：按世界观描述起草自定义历法，返回给前端审阅后
/// 由用户走既有保存路径（本命令**不做持久化、不自动应用**）。单次调用、前端
/// 弹窗等待——不走生成注册表（无会话互斥语义）也不流式；cancel 通道本切片
/// 暂无触发方（UI 取消按钮属后续切片），此处预留打断缝。
#[tauri::command]
#[specta::specta]
pub async fn draft_calendar(
    state: State<'_, AppState>,
    description: String,
) -> Result<CalendarConfigDto, IpcError> {
    let (_signal, cancel) = cancel_channel();
    draft_calendar_impl(&state, &description, &cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::fiction_time;
    use crate::interfaces::ipc::test_support::temp_state;

    // ---- AI 起草历法（FR-014 二期）----

    /// 命令语义：provider 未配置 → Config 分型（明确文案）；空白描述 → Conflict
    /// （参数错误先于任何网络调用，与 services/calendar_draft 同文案）。
    #[tokio::test]
    async fn draft_calendar_command_rejects_blank_and_unconfigured_provider() {
        let (app, dir) = temp_state("draft");
        // signal 必须活过整个调用（watch 语义），通道在测试体内创建。
        let (_signal, cancel) = crate::infra::llm::cancel_channel();
        let err = draft_calendar_impl(&app, "旧都世界观", &cancel).await.unwrap_err();
        assert!(matches!(err, IpcError::Config { .. }));
        assert!(err.to_string().contains("未配置全局默认模型"), "实际：{err}");

        // 配置全局默认 provider（base_url 指向黑洞：空白描述不应触网）。
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

        let err = draft_calendar_impl(&app, "   ", &cancel).await.unwrap_err();
        match err {
            IpcError::Conflict { message } => {
                assert_eq!(message, "描述内容为空：请先填写世界观描述");
            }
            other => panic!("空白描述应报 Conflict，实际 {other:?}"),
        }
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 全链路（mock LLM 服务）：config.json 全局默认模型 → 起草 → DTO wire 形态
    /// （camelCase + festivals 数字字符串键）。
    #[tokio::test]
    async fn draft_calendar_command_returns_dto_through_mock_llm() {
        let (app, dir) = temp_state("draft_ok");
        let content = r#"```json
{"name":"白蜡历","months":["白蜡月","烬月"],"daysPerMonth":30,
 "dayNames":["晨露日"],"festivals":{"45":"灯节"}}
```"#
        .to_string();
        let server = crate::infra::llm::mock::MockServer::start(move |_req, stream| {
            let _ = crate::infra::llm::mock::json_body(stream, &content);
        });
        let mut config = crate::infra::config::Config::new_with_defaults();
        config.providers = vec![crate::infra::config::ProviderConfig {
            id: "p1".into(),
            name: "测试".into(),
            base_url: server.url(),
            api_key: "k".into(),
            models: vec!["m".into()],
            model: None,
        }];
        config.active_provider_id = Some("p1".into());
        config.active_model = Some("m".into());
        app.config.save(&config).unwrap();

        let dto = {
            let (_signal, cancel) = crate::infra::llm::cancel_channel();
            draft_calendar_impl(&app, "旧都世界观", &cancel).await.unwrap()
        };
        assert_eq!(dto.name.as_deref(), Some("白蜡历"));
        assert_eq!(dto.days_per_month, 30);
        assert_eq!(dto.months, vec!["白蜡月".to_string(), "烬月".to_string()]);
        assert_eq!(dto.festivals.as_ref().unwrap()[&45], "灯节");
        // DTO 可无损转回 domain（前端保存走 update_character 的领域校验地基）。
        assert!(fiction_time::validate(&fiction_time::CalendarConfig::from(&dto)));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 会话日历 wire 契约（FR-014；起草历法与开局包共用同一 DTO，原在
    // sessions.rs，Task-44 因 sessions.rs 500 行纪律迁至本域消费方）----

    /// wire 形态：camelCase + festivals 数字字符串键；与 domain 往返无损。
    #[test]
    fn calendar_config_dto_serializes_camel_case_with_numeric_festival_keys() {
        let domain = fiction_time::presets::fantasy();
        let dto = CalendarConfigDto::from(&domain);
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["name"], "旧都历");
        assert_eq!(json["daysPerMonth"], 30);
        assert_eq!(
            json["festivals"]["45"], "灯节",
            "节日键 = 数字字符串（BTreeMap<i64, String> 的 JSON 形态）"
        );
        assert_eq!(json["festivals"]["360"], "守夜");
        // domain → DTO → domain 往返无损。
        assert_eq!(fiction_time::CalendarConfig::from(&dto), domain);
        // 空节日表 → wire null（None = 无节日的规范形态，与反向 From 对称）。
        let mut bare = domain.clone();
        bare.festivals.clear();
        assert!(
            serde_json::to_value(CalendarConfigDto::from(&bare)).unwrap()["festivals"].is_null()
        );
    }
}
