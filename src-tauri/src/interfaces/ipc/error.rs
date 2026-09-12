//! 命令错误（验收 4：命令错误可序列化）。

use serde::Serialize;
use specta::Type;

/// 命令错误的统一 wire 形态。`kind` 是判别字段（camelCase），前端可 switch 分型。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum IpcError {
    /// 目标不存在或已软删除（ADR-009：对调用方等价）。
    NotFound { entity: String, id: i64 },
    /// 约束冲突 / 非法入参。
    Conflict { message: String },
    /// 存储后端故障。
    Storage { message: String },
    /// 配置装载 / 校验 / 保存失败（ADR-012：坏文件快速失败，不静默重置）。
    Config { message: String },
    /// 能力尚未接线（生成闭环由 TASK-006 接入）。
    Unavailable { message: String },
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IpcError::NotFound { entity, id } => write!(f, "{entity} #{id} 不存在（或已软删除）"),
            IpcError::Conflict { message } => write!(f, "{message}"),
            IpcError::Storage { message } => write!(f, "存储错误：{message}"),
            IpcError::Config { message } => write!(f, "配置错误：{message}"),
            IpcError::Unavailable { message } => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for IpcError {}

impl From<crate::domain::error::StorageError> for IpcError {
    fn from(e: crate::domain::error::StorageError) -> Self {
        use crate::domain::error::StorageError;
        match e {
            StorageError::NotFound { entity, id } => {
                IpcError::NotFound { entity: entity.to_string(), id }
            }
            StorageError::Conflict(message) => IpcError::Conflict { message },
            StorageError::Backend(message) => IpcError::Storage { message },
        }
    }
}

impl From<crate::infra::config::ConfigError> for IpcError {
    fn from(e: crate::infra::config::ConfigError) -> Self {
        IpcError::Config { message: e.to_string() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_error_is_serializable_and_typed_by_kind() {
        let e = IpcError::from(crate::domain::error::StorageError::NotFound {
            entity: "session",
            id: 404,
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "notFound", "判别字段 kind（camelCase）");
        assert_eq!(json["entity"], "session");
        assert_eq!(json["id"], 404);

        let conflict = serde_json::to_value(IpcError::Conflict { message: "内容为空".into() }).unwrap();
        assert_eq!(conflict["kind"], "conflict");
        assert_eq!(conflict["message"], "内容为空");
        // Display / std::error::Error 可用（日志与前端提示均可读）。
        assert!(e.to_string().contains("session #404"), "Display 人类可读：{e}");
    }
}
