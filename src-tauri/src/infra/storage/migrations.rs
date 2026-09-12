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
mod tests {
    use super::*;

    #[test]
    fn migration_runner_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        run(&conn).unwrap();
        run(&conn).unwrap();
        run(&conn).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_version WHERE version = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 1, "重复迁移不得重复记录版本");
    }

    /// 验收 1（TASK-011）：对 0001 形态的既有库跑 0002 不丢数据，新列 / 新表就位。
    #[test]
    fn migration_0002_preserves_v1_data() {
        let conn = Connection::open_in_memory().unwrap();
        // 复刻 0001 形态的既有库：手工应用 0001 并按迁移器行为登记版本 1。
        conn.execute_batch(MIGRATIONS[0].1).unwrap();
        conn.execute(
            "INSERT INTO schema_version (version, applied_at) VALUES (1, 0)",
            [],
        )
        .unwrap();

        // v1 形态既有数据：三表各一行
        conn.execute(
            "INSERT INTO characters (id, name, persona, greeting, render_style, \
                 created_at, updated_at) \
             VALUES (1, '艾莉', '底版', '开场', 'typewriter', 10, 10)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (id, character_id, title, created_at, updated_at) \
             VALUES (20, 1, '旧会话', 11, 12)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, created_at) \
             VALUES (300, 20, 'user', '你好', 13)",
            [],
        )
        .unwrap();

        run(&conn).unwrap();

        // 版本账本：1 保留、2 新记
        let versions: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT version FROM schema_version ORDER BY version")
                .unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(versions, vec![1, 2, 3, 4, 5, 6, 7, 8], "旧版本记录保留，新版本追加");

        // 旧数据逐字段原样（验收 1：迁移不丢数据）
        let (name, persona): (String, String) = conn
            .query_row(
                "SELECT name, persona FROM characters WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((name.as_str(), persona.as_str()), ("艾莉", "底版"));
        let title: String = conn
            .query_row("SELECT title FROM sessions WHERE id = 20", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "旧会话");
        let (content, count): (String, i64) = conn
            .query_row(
                "SELECT content, COUNT(*) FROM messages",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((content.as_str(), count), ("你好", 1), "消息行数不增不减");

        // 新列就位且对旧行为 NULL（可空扩列）
        let column_names = |table: &str| -> Vec<String> {
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
            let rows = stmt.query_map([], |r| r.get::<_, String>(1)).unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        let msg_cols = column_names("messages");
        for col in ["scene_id", "character_id"] {
            assert!(msg_cols.iter().any(|c| c == col), "messages.{col} 缺失");
        }
        for table in ["characters", "sessions"] {
            assert!(
                column_names(table).iter().any(|c| c == "calendar_config"),
                "{table}.calendar_config 缺失"
            );
        }
        let (msg_scene, msg_char): (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT scene_id, character_id FROM messages WHERE id = 300",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((msg_scene, msg_char), (None, None), "旧行扩列为 NULL");
        let old_cal: Option<String> = conn
            .query_row(
                "SELECT calendar_config FROM characters WHERE id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old_cal, None, "旧行 calendar_config 为 NULL（内置默认历）");

        // 新表在位且带墓碑列（ADR-009）
        for table in ["scenes", "character_state"] {
            assert!(
                column_names(table).iter().any(|c| c == "deleted_at"),
                "{table}.deleted_at 缺失（ADR-009）"
            );
        }
    }

    /// 0007（Task-03 桥场加厚）：scenes 扩可空 recap 列；0006 形态的既有库跑 0007
    /// 不丢数据，旧行 recap 为 NULL（渲染回退单行），summary 原样保留。
    #[test]
    fn migration_0007_adds_nullable_scenes_recap() {
        let conn = Connection::open_in_memory().unwrap();
        // 手工推进到版本 6，让 run() 只应用 0007。
        for (version, sql) in &MIGRATIONS[..6] {
            conn.execute_batch(sql).unwrap();
            conn.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?1, 0)",
                [version],
            )
            .unwrap();
        }
        // 0006 形态既有数据：角色 + 会话 + 一行带 summary 的场景。
        conn.execute(
            "INSERT INTO characters (name, persona, render_style, created_at, updated_at) \
             VALUES ('艾莉', '底版', 'type', 10, 10)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (character_id, title, created_at, updated_at) \
             VALUES (1, '旧会话', 11, 12)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO scenes (session_id, idx, location, summary, present, fic_day, fic_part) \
             VALUES (1, 0, '钟楼下', '开场', '[1]', 1, '夜')",
            [],
        )
        .unwrap();

        run(&conn).unwrap();

        // 版本账本：7 新记。
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_version WHERE version = 7", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 1, "0007 恰好记录一次");
        // recap 列就位且旧行为 NULL；既有列不丢。
        let (recap, summary): (Option<String>, Option<String>) = conn
            .query_row("SELECT recap, summary FROM scenes WHERE idx = 0", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(recap, None, "旧行扩列为 NULL（可空回退）");
        assert_eq!(summary.as_deref(), Some("开场"), "既有 summary 原样保留");
    }

    /// 0006（Task-10）：存量遗留串 'typewriter'（18 表外，渲染端静默回落 fade）
    /// 订正为真实风格 id 'type'；其他风格值原样保留。
    #[test]
    fn migration_0006_renames_legacy_typewriter_style() {
        let conn = Connection::open_in_memory().unwrap();
        // 手工推进到版本 5，让 run() 只应用 0006。
        for (version, sql) in &MIGRATIONS[..5] {
            conn.execute_batch(sql).unwrap();
            conn.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?1, 0)",
                [version],
            )
            .unwrap();
        }
        for (name, style) in [("旧卡", "typewriter"), ("标准卡", "type"), ("别格卡", "neon")] {
            conn.execute(
                "INSERT INTO characters (name, persona, render_style, created_at, updated_at) \
                     VALUES (?1, '', ?2, 0, 0)",
                params![name, style],
            )
            .unwrap();
        }

        run(&conn).unwrap();

        let mut stmt = conn
            .prepare("SELECT render_style FROM characters ORDER BY id")
            .unwrap();
        let styles: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            styles,
            vec!["type".to_string(), "type".to_string(), "neon".to_string()],
            "遗留 'typewriter' 订正为 'type'，其余风格不动"
        );
    }

    /// 0008（透明化功能）：llm_calls 新表——列集、kind / status 的 CHECK 值域、
    /// (session_id, id) 索引在位；NULL 会话（draft 调用）可插可查排除。
    #[test]
    fn migration_0008_creates_llm_calls_table() {
        let conn = Connection::open_in_memory().unwrap();
        // 手工推进到版本 7，让 run() 只应用 0008。
        for (version, sql) in &MIGRATIONS[..7] {
            conn.execute_batch(sql).unwrap();
            conn.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?1, 0)",
                [version],
            )
            .unwrap();
        }
        // 预置一个会话供外键引用（0001 已在上面的循环中应用）。
        conn.execute(
            "INSERT INTO characters (name, persona, render_style, created_at, updated_at) \
             VALUES ('苏鸢', '', 'type', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (character_id, title, created_at, updated_at) \
             VALUES (1, '', 0, 0)",
            [],
        )
        .unwrap();

        run(&conn).unwrap();

        // 列集与可空性（PRAGMA table_info 第 4 列 notnull：1 = NOT NULL）。
        let mut stmt = conn.prepare("PRAGMA table_info(llm_calls)").unwrap();
        let columns: Vec<(String, bool)> = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, i64>(3)? != 0))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let column = |name: &str| {
            columns
                .iter()
                .find(|(col, _)| col == name)
                .map(|(_, not_null)| *not_null)
        };
        // id 是 INTEGER PRIMARY KEY（rowid 别名）：PRAGMA 的 notnull 恒报 0，
        // 只断言其存在，NOT NULL 断言覆盖其余业务列。
        assert!(column("id").is_some(), "id 主键列应存在");
        for required in
            ["kind", "model", "started_at", "duration_ms", "prompt_json", "status"]
        {
            assert_eq!(column(required), Some(true), "{required} 应存在且 NOT NULL");
        }
        for nullable in [
            "session_id",
            "response_text",
            "reasoning_text",
            "tool_calls_json",
            "prompt_tokens",
            "completion_tokens",
            "error_text",
        ] {
            assert_eq!(column(nullable), Some(false), "{nullable} 应存在且可空");
        }
        assert!(!columns.iter().any(|(col, _)| col == "deleted_at"), "轨迹表不做软删除");

        // (session_id, id) 索引在位。
        let indexes: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'index' \
                     AND name = 'idx_llm_calls_session'",
                )
                .unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.collect::<Result<Vec<_>, _>>().unwrap()
        };
        assert_eq!(indexes, vec!["idx_llm_calls_session"], "会话内按序查询的索引必须存在");

        // kind / status 值域（CHECK）与 NULL 会话可插。
        conn.execute(
            "INSERT INTO llm_calls (session_id, kind, model, started_at, duration_ms, \
                 prompt_json, status) \
             VALUES (1, 'dialogue', 'm', 1, 2, '[]', 'ok')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO llm_calls (session_id, kind, model, started_at, duration_ms, \
                 prompt_json, status) \
             VALUES (NULL, 'draft', 'm', 3, 4, '[]', 'error')",
            [],
        )
        .unwrap();
        for bad in [
            "UPDATE llm_calls SET kind = 'other'",
            "UPDATE llm_calls SET status = 'pending'",
        ] {
            assert!(conn.execute_batch(bad).is_err(), "值域外的值必须被 CHECK 拒绝：{bad}");
        }
    }
}
