//! 领域错误类型：存储端口的统一错误抽象（CMP-003）。
//! 不暴露 rusqlite 细节——调用方只面对语义化错误（ADR-010 依赖倒置）。

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageError {
    /// 实体不存在，或已被软删除（对调用方等价：均不可见，ADR-009）。
    NotFound { entity: &'static str, id: i64 },
    /// 约束冲突（外键指向不存在的行等）或非法入参。
    Conflict(String),
    /// 后端故障（打开失败、SQL 执行失败、数据损坏等）。
    Backend(String),
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StorageError::NotFound { entity, id } => {
                write!(f, "{entity} #{id} 不存在（或已软删除）")
            }
            StorageError::Conflict(msg) => write!(f, "存储约束冲突：{msg}"),
            StorageError::Backend(msg) => write!(f, "存储后端错误：{msg}"),
        }
    }
}

impl std::error::Error for StorageError {}
