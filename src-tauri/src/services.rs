//! 服务层（ADR-010）：编排，禁 tauri / rusqlite / reqwest，经 ports 使用基础设施。

pub mod character_io;
pub mod director;
pub mod explorer;
pub mod generation;
pub mod prompt;
