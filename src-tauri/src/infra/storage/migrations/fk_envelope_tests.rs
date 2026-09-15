//! FK=OFF 包络验收测试（外置于独立文件：migrations/tests.rs 已超 500 行上限）。
//! 覆盖三面：FK 开启的最严环境（对齐 Storage::open 生产形态）下迁移链全过且零违例、
//! 包络结束（含失败路径）后 foreign_keys 恢复原值、foreign_key_check 兜底报错路径。
use super::*;

/// 读连接当前的 foreign_keys 开关。
fn foreign_keys_on(conn: &Connection) -> bool {
    conn.query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
        .map(|v| v != 0)
        .unwrap()
}

/// 全库 foreign_key_check 违例的子表名列表（每条违例一行）。
fn fk_violating_tables(conn: &Connection) -> Vec<String> {
    let mut stmt = conn.prepare("PRAGMA foreign_key_check").unwrap();
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
    rows.collect::<Result<Vec<_>, _>>().unwrap()
}

/// 版本账本快照。
fn ledger(conn: &Connection) -> Vec<i64> {
    let mut stmt = conn
        .prepare("SELECT version FROM schema_version ORDER BY version")
        .unwrap();
    let rows = stmt.query_map([], |row| row.get::<_, i64>(0)).unwrap();
    rows.collect::<Result<Vec<_>, _>>().unwrap()
}

/// 最严环境：连接 FK=ON（复刻 Storage::open 迁移前的生产形态；rusqlite 裸连接默认
/// OFF，须手动开启）。完整迁移链成功、账本 1..=12、foreign_key_check 零违例、
/// 包络结束 foreign_keys 恢复为开。
#[test]
fn envelope_runs_full_chain_with_foreign_keys_on() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    run(&conn).unwrap();

    assert_eq!(ledger(&conn), vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    assert!(
        fk_violating_tables(&conn).is_empty(),
        "FK=ON 连接跑完迁移链不得有外键违例"
    );
    assert!(
        foreign_keys_on(&conn),
        "包络结束 foreign_keys 恢复原值（开）"
    );
}

/// 恢复语义对称：原本关闭的连接跑完迁移仍保持关闭——恢复原值，不强制改写调用方
/// 的开关。本仓库 bundled SQLite 编译带 SQLITE_DEFAULT_FOREIGN_KEYS=1（libsqlite3-sys
/// build.rs），裸连接默认即开，关闭形态须显式构造。
#[test]
fn envelope_restores_foreign_keys_off_unchanged() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", false).unwrap();

    run(&conn).unwrap();

    assert!(!foreign_keys_on(&conn), "包络恢复原值而非强制开");
}

/// 兜底报错路径：v8 形态库预置一条悬空消息（session_id 指向不存在的会话，即当年
/// MAJOR-1' 的违例存量形态）。FK=ON 且无包络时 0009 的搬运 INSERT...SELECT 会直接
/// 撞外键；有包络则迁移跑完、账本推进到 12，再由 foreign_key_check 兜底报错并恢复
/// PRAGMA——报错带违例表与父表上下文，连接不留 FK 关闭的脏状态。
#[test]
fn envelope_reports_fk_violation_and_restores_pragma() {
    let conn = Connection::open_in_memory().unwrap();
    // 手工推进到版本 8 并预置违例数据：0001/0002 的 SQL 内嵌 PRAGMA foreign_keys = ON
    // 会把手工期连接翻回开启态，插悬空行前须再次关闭，插完恢复 ON，让 run() 记录到
    // 的原值是「开」。
    for (version, sql) in &MIGRATIONS[..8] {
        conn.execute_batch(sql).unwrap();
        conn.execute(
            "INSERT INTO schema_version (version, applied_at) VALUES (?1, 0)",
            [version],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO characters (id, name, persona, render_style, created_at, updated_at) \
             VALUES (1, '苏鸢', '', 'type', 0, 0)",
        [],
    )
    .unwrap();
    conn.pragma_update(None, "foreign_keys", false).unwrap();
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, created_at) \
             VALUES (300, 999, 'user', '悬空消息', 4)",
        [],
    )
    .unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    let err = run(&conn).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("foreign_key_check") && msg.contains("messages") && msg.contains("sessions"),
        "违例报错应带兜底校验与违例/父表上下文：{msg}"
    );
    // 迁移本身全部落地（悬空行是数据错误而非 schema 错误），报错来自兜底校验。
    assert_eq!(ledger(&conn), vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    // 失败路径不留脏连接状态：FK 恢复为原值（开）。
    assert!(foreign_keys_on(&conn));
    assert_eq!(
        fk_violating_tables(&conn),
        vec!["messages"],
        "悬空消息行就是那条违例"
    );
}
