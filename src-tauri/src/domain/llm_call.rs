//! LLM 调用轨迹（透明化功能）：llm_calls 表投影，一次 HTTP 请求一条记录。
//!
//! 自 domain/models.rs 纯搬移（500 行硬上限拆分）；类型、字段注释与 serde 形态
//! 逐字不变，消费方 use 路径由 models 改指本模块。

use serde::{Deserialize, Serialize};

use crate::domain::error::StorageError;

/// LLM 调用类别（llm_calls.kind CHECK 三值）：主对话流式 / 记忆探索器工具循环 /
/// 导演结算裁决。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LlmCallKind {
    /// 主对话流式生成（generation）。
    Dialogue,
    /// 记忆探索器工具循环（explorer，每轮一次请求）。
    Explorer,
    /// 导演结算裁决（director，含修正重试的每次尝试）。
    Director,
}

impl LlmCallKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LlmCallKind::Dialogue => "dialogue",
            LlmCallKind::Explorer => "explorer",
            LlmCallKind::Director => "director",
        }
    }

    /// 从库值解析；未知值视为后端数据损坏。历史「draft」值（历法起草 2026-09-13
    /// 裁撤）不再识别——应用未发布、无存量数据要保护。
    pub fn from_db(value: &str) -> Result<Self, StorageError> {
        match value {
            "dialogue" => Ok(LlmCallKind::Dialogue),
            "explorer" => Ok(LlmCallKind::Explorer),
            "director" => Ok(LlmCallKind::Director),
            other => Err(StorageError::Backend(format!("未知 LLM 调用类别：{other}"))),
        }
    }
}

/// LLM 调用终态（llm_calls.status CHECK 二值）。取消按 error 落（error_text = 已取消）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LlmCallStatus {
    Ok,
    Error,
}

impl LlmCallStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            LlmCallStatus::Ok => "ok",
            LlmCallStatus::Error => "error",
        }
    }

    /// 从库值解析；未知值视为后端数据损坏。
    pub fn from_db(value: &str) -> Result<Self, StorageError> {
        match value {
            "ok" => Ok(LlmCallStatus::Ok),
            "error" => Ok(LlmCallStatus::Error),
            other => Err(StorageError::Backend(format!("未知 LLM 调用终态：{other}"))),
        }
    }
}

/// LLM 调用轨迹（透明化功能）：每次 LLM HTTP 请求的完整可回放记录。
/// 日志性质旁路数据——**不做软删除**（无墓碑列，ADR-009 在此不适用），只插不改不删。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LlmCall {
    pub id: i64,
    /// 所属会话；历史起草调用（2026-09-13 裁撤）曾为 None，现行写入方恒 Some。
    pub session_id: Option<i64>,
    pub kind: LlmCallKind,
    pub model: String,
    /// 请求发起时刻（Unix 毫秒）。
    pub started_at: i64,
    /// 本次 HTTP 请求墙钟耗时（毫秒）。
    pub duration_ms: i64,
    /// 请求消息数组 JSON（[{role, content, …}]；工具轮含 tool 角色与 tool_calls 回传）。
    pub prompt_json: String,
    /// 响应正文；失败 / 取消路径为已收到的半条（None = 零内容）。
    pub response_text: Option<String>,
    /// 思考内容（字段型 reasoning / 内联 <think> 拆分产物）。
    pub reasoning_text: Option<String>,
    /// 本轮模型发起的工具调用 [{name, arguments}] JSON；非工具轮为 None。
    pub tool_calls_json: Option<String>,
    /// usage（网关未回报即 None：流式不做请求侧 include_usage 追加，有则记）。
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub status: LlmCallStatus,
    /// status = error 时的人类可读原因。
    pub error_text: Option<String>,
}

/// 插入调用轨迹入参（id / 落库时刻由存储层分配）。
#[derive(Debug, Clone, PartialEq)]
pub struct NewLlmCall {
    pub session_id: Option<i64>,
    pub kind: LlmCallKind,
    pub model: String,
    pub started_at: i64,
    pub duration_ms: i64,
    pub prompt_json: String,
    pub response_text: Option<String>,
    pub reasoning_text: Option<String>,
    pub tool_calls_json: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub status: LlmCallStatus,
    pub error_text: Option<String>,
}
