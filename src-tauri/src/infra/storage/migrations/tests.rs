//! 逐迁移验收测试（自 migrations.rs 外置，源文件 500 行上限）：
//! 每个迁移的形状 / 幂等 / 既有数据保全断言；新迁移在此追加对应用例。
use super::*;

#[test]
fn migration_runner_is_idempotent() {
    let conn = Connection::open_in_memory().unwrap();
    run(&conn).unwrap();
    run(&conn).unwrap();
    run(&conn).unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM schema_version WHERE version = 1",
            [],
            |r| r.get(0),
        )
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
    assert_eq!(
        versions,
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        "旧版本记录保留，新版本追加"
    );

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
        .query_row("SELECT content, COUNT(*) FROM messages", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!((content.as_str(), count), ("你好", 1), "消息行数不增不减");

    // 新列就位且对旧行为 NULL（可空扩列）；
    // 0009 起 messages.character_id 死列移除、换挂 instance_id（方案 §2.2）。
    let column_names = |table: &str| -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(1)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    };
    let msg_cols = column_names("messages");
    assert!(
        msg_cols.iter().any(|c| c == "scene_id"),
        "messages.scene_id 缺失"
    );
    assert!(
        msg_cols.iter().any(|c| c == "instance_id"),
        "messages.instance_id 缺失"
    );
    assert!(
        !msg_cols.iter().any(|c| c == "character_id"),
        "messages.character_id 死列应已移除（迁移 0009）"
    );
    for table in ["characters", "sessions"] {
        assert!(
            column_names(table).iter().any(|c| c == "calendar_config"),
            "{table}.calendar_config 缺失"
        );
    }
    let (msg_scene, msg_inst): (Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT scene_id, instance_id FROM messages WHERE id = 300",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((msg_scene, msg_inst), (None, None), "旧行扩列为 NULL");
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
        .query_row(
            "SELECT COUNT(*) FROM schema_version WHERE version = 7",
            [],
            |r| r.get(0),
        )
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
    for (name, style) in [
        ("旧卡", "typewriter"),
        ("标准卡", "type"),
        ("别格卡", "neon"),
    ] {
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
    for required in [
        "kind",
        "model",
        "started_at",
        "duration_ms",
        "prompt_json",
        "status",
    ] {
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
    assert!(
        !columns.iter().any(|(col, _)| col == "deleted_at"),
        "轨迹表不做软删除"
    );

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
    assert_eq!(
        indexes,
        vec!["idx_llm_calls_session"],
        "会话内按序查询的索引必须存在"
    );

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
        assert!(
            conn.execute_batch(bad).is_err(),
            "值域外的值必须被 CHECK 拒绝：{bad}"
        );
    }
}

/// 0009（多角色群像地基，方案 §2 第 1 步）：character_instances 新表形状与值域、
/// 三处换挂（sessions 无 character_id / messages 挂 instance_id / 状态挂
/// instance_id + (instance_id, key) 唯一）、旧行数据平移不丢（D8 不回填新列）。
#[test]
fn migration_0009_builds_instances_and_rewires_ownership() {
    let conn = Connection::open_in_memory().unwrap();
    // 手工推进到版本 8（0008 形态既有库），预置数据后让 run() 只应用 0009。
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
             VALUES (1, '苏鸢', '守夜人', 'type', 1, 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO sessions (id, character_id, title, created_at, updated_at) \
             VALUES (20, 1, '旧会话', 2, 3)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, created_at) \
             VALUES (300, 20, 'user', '你好', 4)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO scenes (id, session_id, idx, present) VALUES (500, 20, 0, '[1]')",
        [],
    )
    .unwrap();
    conn.execute(
            "INSERT INTO character_state (character_id, session_id, scope, \"key\", value, updated_at) \
             VALUES (1, 20, 'state', '情绪', '警觉', 6)",
            [],
        )
        .unwrap();

    run(&conn).unwrap();

    // 数据平移：sessions / messages / scenes 逐行幸存；character_state 旧行不搬运
    // （instance_id NOT NULL 无法机械回填，D8 预发布无存量数据）。
    let title: String = conn
        .query_row("SELECT title FROM sessions WHERE id = 20", [], |r| r.get(0))
        .unwrap();
    assert_eq!(title, "旧会话");
    let (content, instance): (String, Option<i64>) = conn
        .query_row(
            "SELECT content, instance_id FROM messages WHERE id = 300",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (content.as_str(), instance),
        ("你好", None),
        "消息行幸存，instance_id 旧行 NULL"
    );
    let present: String = conn
        .query_row("SELECT present FROM scenes WHERE id = 500", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(
        present, "[1]",
        "scenes 行原样平移（内容语义升级不回填，D8）"
    );
    let states: i64 = conn
        .query_row("SELECT COUNT(*) FROM character_state", [], |r| r.get(0))
        .unwrap();
    assert_eq!(states, 0, "状态旧行不迁移（D8）");

    // 换挂断言：sessions / messages 无 character_id 残留；character_state 挂 instance_id。
    let column_names = |table: &str| -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(1)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    };
    assert!(
        !column_names("sessions").iter().any(|c| c == "character_id"),
        "sessions.character_id 应已移除（D2 扮演位由 is_user 表达）"
    );
    assert!(
        !column_names("messages").iter().any(|c| c == "character_id"),
        "messages.character_id 死列应已移除"
    );
    for table in ["sessions", "character_instances", "messages", "scenes"] {
        assert!(
            column_names(table).iter().any(|c| c == "deleted_at"),
            "{table}.deleted_at 缺失（ADR-009）"
        );
    }
    // 实例表形状与值域（CHECK is_user IN (0,1)）。
    let inst_cols = column_names("character_instances");
    for col in [
        "id",
        "session_id",
        "character_id",
        "name",
        "persona",
        "render_style",
        "is_user",
        "created_at",
        "deleted_at",
    ] {
        assert!(
            inst_cols.iter().any(|c| c == col),
            "character_instances.{col} 缺失"
        );
    }
    conn.execute(
            "INSERT INTO character_instances (session_id, name, persona, render_style, is_user, created_at) \
             VALUES (20, '旅人', '', 'type', 1, 10)",
            [],
        )
        .unwrap();
    assert!(
            conn.execute_batch(
                "INSERT INTO character_instances (session_id, name, persona, render_style, is_user, created_at) \
                 VALUES (20, '坏位', '', 'type', 2, 11)"
            )
            .is_err(),
            "is_user 值域外必须被 CHECK 拒绝"
        );
    // 状态唯一索引：同 (instance_id, key) 在世行冲突；键挂新表外键。
    conn.execute(
        "INSERT INTO character_state (instance_id, scope, \"key\", value, updated_at) \
             VALUES (1, 'state', '情绪', '释然', 12)",
        [],
    )
    .unwrap();
    assert!(
        conn.execute_batch(
            "INSERT INTO character_state (instance_id, scope, \"key\", value, updated_at) \
                 VALUES (1, 'relation', '情绪', 'x', 13)"
        )
        .is_err(),
        "(instance_id, key) 唯一索引必须约束在世行"
    );
    assert!(
        conn.execute_batch(
            "INSERT INTO character_state (instance_id, scope, \"key\", value, updated_at) \
                 VALUES (999, 'state', 'k', 'v', 14)"
        )
        .is_err(),
        "状态外键必须指向 character_instances"
    );
    // 自增序列随重建延续（消息表重建后新 id 不与旧行撞号）。
    conn.execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (20, 'user', '新', 15)",
            [],
        )
        .unwrap();
    let next_id: i64 = conn
        .query_row("SELECT MAX(id) FROM messages", [], |r| r.get(0))
        .unwrap();
    assert!(next_id > 300, "重建后自增续号：实际 {next_id}");
}

/// 0010（状态历史化，方案 §2 第 2 步）：character_state 扩可空 superseded_at 列、
/// 唯一索引 uq_character_state_live 重建为只约束「当前生效行」——旧行扩列为 NULL
/// （仍生效），同键在被取代 / 墓碑后可再插（append 合法），生效行仍互斥。
#[test]
fn migration_0010_adds_superseded_column_and_live_only_unique_index() {
    let conn = Connection::open_in_memory().unwrap();
    // 手工推进到版本 9（0009 形态既有库），预置数据后让 run() 只应用 0010。
    for (version, sql) in &MIGRATIONS[..9] {
        conn.execute_batch(sql).unwrap();
        conn.execute(
            "INSERT INTO schema_version (version, applied_at) VALUES (?1, 0)",
            [version],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO sessions (title, created_at, updated_at) VALUES ('旧会话', 1, 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO character_instances (session_id, name, persona, render_style, is_user, created_at) \
             VALUES (1, '苏鸢', '', 'type', 0, 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO character_state (instance_id, scope, \"key\", value, updated_at) \
             VALUES (1, 'state', '情绪', '释然', 2)",
        [],
    )
    .unwrap();

    run(&conn).unwrap();

    // 版本账本：10 新记。
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM schema_version WHERE version = 10",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "0010 恰好记录一次");
    // 新列就位且旧行为 NULL（= 仍生效，无存量需回填）。
    let superseded: Option<i64> = conn
        .query_row(
            "SELECT superseded_at FROM character_state WHERE instance_id = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(superseded, None, "旧行 superseded_at 扩列为 NULL = 仍生效");

    // 生效行同键仍互斥（索引收窄不是放松为无约束）。
    assert!(
        conn.execute_batch(
            "INSERT INTO character_state (instance_id, scope, \"key\", value, updated_at) \
                 VALUES (1, 'relation', '情绪', 'x', 3)"
        )
        .is_err(),
        "生效行 (instance_id, key) 唯一约束保留"
    );

    // 旧行被取代（打 superseded_at）后同键可再插——append 合法，历史链不冲突。
    conn.execute(
        "UPDATE character_state SET superseded_at = 4 WHERE instance_id = 1",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO character_state (instance_id, scope, \"key\", value, updated_at) \
             VALUES (1, 'state', '情绪', '悲伤', 5)",
        [],
    )
    .unwrap();
    // 墓碑行不阻塞同键再插（迁移 0002 决策、0010 收窄沿用）。
    conn.execute(
        "UPDATE character_state SET deleted_at = 6 WHERE value = '悲伤'",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO character_state (instance_id, scope, \"key\", value, updated_at) \
             VALUES (1, 'state', '情绪', '平静', 7)",
        [],
    )
    .unwrap();
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM character_state", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 3, "取代链 + 墓碑 + 重插三行共存");

    // 索引定义：uq_character_state_live 的 WHERE 同时含两个 NULL 判定。
    let index_sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_character_state_live'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        index_sql.contains("deleted_at IS NULL") && index_sql.contains("superseded_at IS NULL"),
        "唯一索引只约束当前生效行，实际：{index_sql}"
    );
}

/// 0011（时间线分叉地基，方案 §2 第 3 步）：sessions 扩两列可空分叉元信息——
/// 旧行扩列为 NULL（非分叉会话），列可写、无外键（源会话软删不阻断新线）。
#[test]
fn migration_0011_adds_fork_metadata_columns() {
    let conn = Connection::open_in_memory().unwrap();
    // 手工推进到版本 10（0010 形态既有库），预置数据后让 run() 只应用 0011。
    for (version, sql) in &MIGRATIONS[..10] {
        conn.execute_batch(sql).unwrap();
        conn.execute(
            "INSERT INTO schema_version (version, applied_at) VALUES (?1, 0)",
            [version],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO sessions (title, created_at, updated_at) VALUES ('旧会话', 1, 1)",
        [],
    )
    .unwrap();

    run(&conn).unwrap();

    // 版本账本：11 新记。
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM schema_version WHERE version = 11",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "0011 恰好记录一次");

    // 新列就位且旧行为 NULL（非分叉会话）。
    let (from, anchor): (Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT forked_from_session_id, fork_anchor_scene_idx FROM sessions WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (from, anchor),
        (None, None),
        "旧行分叉元信息扩列为 NULL = 非分叉会话"
    );

    // 列可写且无外键约束：forked_from_session_id 指向已软删的源会话也合法
    // （不设外键是迁移 0011 的明确决策——源会话墓碑不阻断新线）。
    conn.execute("UPDATE sessions SET deleted_at = 2 WHERE id = 1", [])
        .unwrap();
    conn.execute(
        "INSERT INTO sessions (title, created_at, updated_at, \
             forked_from_session_id, fork_anchor_scene_idx) \
         VALUES ('分叉线', 3, 3, 1, 3)",
        [],
    )
    .unwrap();
    let (from, anchor): (Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT forked_from_session_id, fork_anchor_scene_idx \
             FROM sessions WHERE title = '分叉线'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (from, anchor),
        (Some(1), Some(3)),
        "分叉元信息可落值，且源会话已软删（墓碑）不构成外键阻断"
    );
}
