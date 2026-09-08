//! db.rs（CMP-003）：rusqlite + 手写顺序迁移 + 软删除统一过滤（ADR-009：查询默认 deleted_at IS NULL，不散落调用方）。
//! 库文件：~/.chronoveil/chronoveil.db（ADR-012）。
