//! 手写顺序迁移（CMP-003）：`schema_version` 表记录已应用版本；同一库重复启动幂等。
//! 迁移 SQL 放 `src-tauri/migrations/`，按版本号顺序执行，每个迁移单事务。

use rusqlite::{params, Connection};

use crate::domain::error::StorageError;
use crate::infra::storage::now;

/// 版本号递增的迁移清单；新迁移追加新行，不改历史条目。
pub(crate) const MIGRATIONS: &[(i64, &str)] = &[
    // v1 三张表（data_model rev 6，ADR-009 全库软删除）
    (1, include_str!("../../../migrations/0001_init.sql")),
    // 5b 数据层地基（data_model「5b 增量」；FR-011 / FR-012 / FR-013）：
    // scenes / character_state 新表、messages 扩列、calendar_config 两处
    (2, include_str!("../../../migrations/0002_scenes_character_state.sql")),
    // 编辑器「强调色」（2026-09-09）：characters.accent_color 可空扩列
    (3, include_str!("../../../migrations/0003_character_accent.sql")),
    // 角色卡移除开场白（2026-09-09 产品裁剪）：characters 丢弃 greeting 列
    (4, include_str!("../../../migrations/0004_drop_character_greeting.sql")),
    // 角色卡元数据（2026-09-09）：characters 扩列 gender / age（可空自由文本）
    (5, include_str!("../../../migrations/0005_character_gender_age.sql")),
    // render_style 遗留默认值订正（Task-10）：'typewriter' 是 18 表外串（真实 id 为
    // 'type'），存量行订正为引擎可识别风格；列默认值随 0001 历史保留（插入恒显式传值）
    (6, include_str!("../../../migrations/0006_render_style_type.sql")),
    // 桥场加厚（Task-03）：scenes.recap 可空扩列（两三句加厚回顾，远景编年史桥场专用）
    (7, include_str!("../../../migrations/0007_scenes_recap.sql")),
    // LLM 调用轨迹（透明化功能）：llm_calls 新表——每次 LLM HTTP 请求一条完整
    // 轨迹（kind 四类 / usage 可空 / status 二值），日志性质数据不做软删除
    (8, include_str!("../../../migrations/0008_llm_calls.sql")),
    // 多角色群像地基（方案《多角色与时间线-最终》§2 第 1 步，D1/D2/D8）：
    // character_instances 新表 + sessions/messages/character_state 三处换挂
    // （sessions DROP character_id；messages 死列换 instance_id；状态挂 instance_id）
    (9, include_str!("../../../migrations/0009_character_instances.sql")),
    // 状态历史化（方案《多角色与时间线-最终》§2 第 2 步，方案 A append-only）：
    // character_state 扩 superseded_at（取代链）+ 唯一索引收窄为只约束当前生效行
    // （deleted_at IS NULL AND superseded_at IS NULL）
    (10, include_str!("../../../migrations/0010_character_state_history.sql")),
];

/// 把库迁移到最新版本；已应用版本跳过（幂等）。
pub(crate) fn run(conn: &Connection) -> Result<(), StorageError> {
    // schema_version 是迁移器自身的账本，先于任何迁移保证存在（与 0001 内定义一致，IF NOT EXISTS 幂等）。
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (
            version    INTEGER NOT NULL PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );",
    )?;
    let current: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_version",
        [],
        |row| row.get(0),
    )?;
    for (version, sql) in MIGRATIONS {
        if *version <= current {
            continue;
        }
        // 单迁移单事务：SQL 与版本记录同生共死，半写不可能发生。
        let tx = conn
            .unchecked_transaction()
            .map_err(StorageError::from)?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_version (version, applied_at) VALUES (?1, ?2)",
            params![version, now()],
        )?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
