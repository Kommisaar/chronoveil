//! LLM 调用轨迹域（透明化功能）：llm_calls 读路径与 Trace wire DTO。

use serde::Serialize;
use specta::Type;
use tauri::State;

use crate::domain::models;
use crate::domain::ports::StoragePort;
use crate::state::AppState;

use super::error::IpcError;

/// LLM 调用类别（wire 小写；与 llm_calls.kind 库值一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum LlmCallKindDto {
    Dialogue,
    Explorer,
    Director,
}

impl From<models::LlmCallKind> for LlmCallKindDto {
    fn from(kind: models::LlmCallKind) -> Self {
        match kind {
            models::LlmCallKind::Dialogue => LlmCallKindDto::Dialogue,
            models::LlmCallKind::Explorer => LlmCallKindDto::Explorer,
            models::LlmCallKind::Director => LlmCallKindDto::Director,
        }
    }
}

/// LLM 调用终态（wire 小写；与 llm_calls.status 库值一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum LlmCallStatusDto {
    Ok,
    Error,
}

impl From<models::LlmCallStatus> for LlmCallStatusDto {
    fn from(status: models::LlmCallStatus) -> Self {
        match status {
            models::LlmCallStatus::Ok => LlmCallStatusDto::Ok,
            models::LlmCallStatus::Error => LlmCallStatusDto::Error,
        }
    }
}

/// LLM 调用轨迹（透明化功能）：llm_calls 行投影。`promptJson` / `toolCallsJson`
/// 以 string 透传（前端 parse）——内容是网关请求 / 响应的原始 JSON，序列化形态
/// 由网关侧钉死，wire 层不再二次建模。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LlmCallDto {
    pub id: i64,
    /// 所属会话；null = 无会话调用（历法起草），不出现在会话查询里。
    pub session_id: Option<i64>,
    pub kind: LlmCallKindDto,
    pub model: String,
    /// 请求发起时刻（Unix 毫秒）。
    pub started_at: i64,
    /// 本次 HTTP 请求墙钟耗时（毫秒）。
    pub duration_ms: i64,
    /// 请求消息数组 JSON（[{role, content, …}]），string 透传。
    pub prompt_json: String,
    /// 响应正文；失败 / 取消为已收到的半条。
    pub response_text: Option<String>,
    pub reasoning_text: Option<String>,
    /// 该轮模型发起的工具调用 [{name, arguments}] JSON，string 透传。
    pub tool_calls_json: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub status: LlmCallStatusDto,
    /// status = error 时的人类可读原因。
    pub error_text: Option<String>,
}

impl From<models::LlmCall> for LlmCallDto {
    fn from(call: models::LlmCall) -> Self {
        Self {
            id: call.id,
            session_id: call.session_id,
            kind: LlmCallKindDto::from(call.kind),
            model: call.model,
            started_at: call.started_at,
            duration_ms: call.duration_ms,
            prompt_json: call.prompt_json,
            response_text: call.response_text,
            reasoning_text: call.reasoning_text,
            tool_calls_json: call.tool_calls_json,
            prompt_tokens: call.prompt_tokens,
            completion_tokens: call.completion_tokens,
            status: LlmCallStatusDto::from(call.status),
            error_text: call.error_text,
        }
    }
}

// ---- LLM 调用轨迹（透明化功能：llm_calls 读路径）----

/// `list_llm_calls` 未显式传 limit 时的默认截断（最新 200 条，面板单页足够）。
pub const DEFAULT_LLM_CALL_LIST_LIMIT: u32 = 200;

fn list_llm_calls_impl(
    app: &AppState,
    session_id: i64,
    limit: Option<u32>,
) -> Result<Vec<LlmCallDto>, IpcError> {
    // 先会话在世校验（不存在 / 已软删报 NotFound，与 list_messages_impl 同构），
    // 再走存储端口；列表按 id 倒序（最新在前），无会话的 draft 轨迹天然不入。
    app.storage.get_session(session_id)?;
    Ok(app
        .storage
        .list_llm_calls(session_id, limit.unwrap_or(DEFAULT_LLM_CALL_LIST_LIMIT))?
        .into_iter()
        .map(LlmCallDto::from)
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn list_llm_calls(
    state: State<'_, AppState>,
    session_id: i64,
    limit: Option<u32>,
) -> Result<Vec<LlmCallDto>, IpcError> {
    list_llm_calls_impl(&state, session_id, limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::{NewSession, RosterPick};
    use crate::interfaces::ipc::sessions::delete_session_impl;
    use crate::interfaces::ipc::test_support::{sample_character, temp_state};

    #[test]
    fn llm_call_dto_serializes_camel_case() {
        let dto = LlmCallDto::from(models::LlmCall {
            id: 12,
            session_id: Some(3),
            kind: models::LlmCallKind::Dialogue,
            model: "test-model".into(),
            started_at: 1_000,
            duration_ms: 250,
            prompt_json: r#"[{"role":"user","content":"你好"}]"#.into(),
            response_text: Some("在。".into()),
            reasoning_text: Some("想想".into()),
            tool_calls_json: Some(r#"[{"name":"search_history","arguments":"{}"}]"#.into()),
            prompt_tokens: Some(11),
            completion_tokens: None,
            status: models::LlmCallStatus::Ok,
            error_text: None,
        });
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["id"], 12);
        assert_eq!(json["sessionId"], 3);
        assert_eq!(json["kind"], "dialogue");
        assert_eq!(json["startedAt"], 1_000, "wire camelCase");
        assert_eq!(json["durationMs"], 250);
        assert_eq!(json["promptJson"], r#"[{"role":"user","content":"你好"}]"#, "string 透传");
        assert_eq!(json["responseText"], "在。");
        assert_eq!(json["toolCallsJson"], r#"[{"name":"search_history","arguments":"{}"}]"#);
        assert_eq!(json["promptTokens"], 11);
        assert!(json["completionTokens"].is_null());
        assert_eq!(json["status"], "ok");
        assert!(json["errorText"].is_null());
    }

    /// LLM 调用轨迹读路径（透明化功能）：先会话在世校验（NotFound 同构），
    /// 空会话返回空数组；正常返回 id 倒序且 limit 生效。
    #[test]
    fn list_llm_calls_checks_session_orders_desc_and_caps() {
        let (app, dir) = temp_state("llm_calls");
        let user_card = sample_character(&app, "旅人");
        let character = sample_character(&app, "苏鸢");
        let session = app
            .storage
            .create_session(&NewSession {
                roster: vec![
                    RosterPick { character_id: user_card.id, is_user: true },
                    RosterPick { character_id: character.id, is_user: false },
                ],
                title: String::new(),
                opening: None,
            })
            .unwrap();
        // 空会话：在世但无轨迹 → 空数组（非 NotFound）。
        assert!(list_llm_calls_impl(&app, session.id, None).unwrap().is_empty());

        for i in 0..3 {
            app.storage
                .insert_llm_call(&models::NewLlmCall {
                    session_id: Some(session.id),
                    kind: models::LlmCallKind::Explorer,
                    model: "test-model".into(),
                    started_at: i,
                    duration_ms: 10,
                    prompt_json: "[]".into(),
                    response_text: None,
                    reasoning_text: None,
                    tool_calls_json: None,
                    prompt_tokens: None,
                    completion_tokens: None,
                    status: models::LlmCallStatus::Ok,
                    error_text: None,
                })
                .unwrap();
        }

        // limit 生效：截取最新 2 条（id 倒序头两行）。
        let listed = list_llm_calls_impl(&app, session.id, Some(2)).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed[0].id > listed[1].id, "最新在前");
        assert_eq!(listed[0].kind, LlmCallKindDto::Explorer);

        // 缺省 limit 走 DEFAULT_LLM_CALL_LIST_LIMIT（3 条全出）。
        assert_eq!(list_llm_calls_impl(&app, session.id, None).unwrap().len(), 3);

        // 不存在 / 已软删会话 → NotFound（与 list_messages_impl 同语义）。
        delete_session_impl(&app, session.id).unwrap();
        assert!(matches!(
            list_llm_calls_impl(&app, session.id, None),
            Err(IpcError::NotFound { .. })
        ));
        assert!(matches!(
            list_llm_calls_impl(&app, 999_999, None),
            Err(IpcError::NotFound { .. })
        ));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
