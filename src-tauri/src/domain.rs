//! 领域层（ADR-010）：纯业务规则，禁 tauri / rusqlite / reqwest。

pub mod chat;
pub mod context;
pub mod error;
pub mod fiction_time;
pub mod llm_call;
pub mod models;
pub mod ports;
pub mod state_expiry;
