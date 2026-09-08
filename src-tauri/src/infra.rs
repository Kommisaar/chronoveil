//! 基础设施层（ADR-010）：storage = db.rs（CMP-003），llm = model.rs（CMP-002），
//! config = config.json 装载与原子写（TASK-003 / ADR-012 / FR-009）；实现 domain::ports。

pub mod config;
pub mod llm;
pub mod storage;
