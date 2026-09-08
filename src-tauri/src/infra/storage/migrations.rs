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
        assert_eq!(versions, vec![1, 2], "旧版本记录保留，新版本追加");

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
}
