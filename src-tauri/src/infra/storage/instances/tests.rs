//! character_instances 存储原语测试（自 instances.rs 外置）：以裸连接直接驱动
//! 同层自由函数（insert / list_by_session / get / soft_delete），锁死在世行读
//! 路径与 ADR-009 软删墓碑语义——不经 StoragePort 包装，端口层组合另有覆盖。

use super::*;
use crate::infra::storage::test_support::temp_storage;
use rusqlite::Connection;
use std::path::PathBuf;

/// 测试夹具：temp_storage 建迁移完好的临时库，释放端口包装后重开裸连接（与
/// 生产 Storage::open 同样开外键），补一条最小会话行作外键锚——sessions::insert
/// 强制「1 用户位 + LLM 位」阵容，而实例原语测试只需要合法 session_id。
/// 返回 (连接, 临时目录, 会话 id)。
fn setup(tag: &str) -> (Connection, PathBuf, i64) {
    let (storage, dir) = temp_storage(tag);
    drop(storage);
    let conn = Connection::open(dir.join("test.db")).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    conn.execute(
        "INSERT INTO sessions (title, created_at, updated_at) VALUES ('', ?1, ?1)",
        params![now()],
    )
    .unwrap();
    let session_id = conn.last_insert_rowid();
    (conn, dir, session_id)
}

/// 动态造人式入参（D6）：character_id = None，无需角色卡行。
fn new_instance(session_id: i64, name: &str, is_user: bool) -> NewCharacterInstance {
    NewCharacterInstance {
        session_id,
        character_id: None,
        name: name.into(),
        persona: String::new(),
        render_style: "type".into(),
        is_user,
    }
}

/// get 命中分支 + 逐字段往返：insert 落库后 get 回读与入参一致。created_at
/// 例外——insert 返回值的时间戳是落库后的第二次 now()，与库值可能差 1ms，
/// 故对 get 回读（库值）以调用前后时间窗断言。
#[test]
fn insert_then_get_roundtrips_all_fields() {
    let (conn, dir, sid) = setup("instance_roundtrip");
    let new = NewCharacterInstance {
        session_id: sid,
        character_id: None,
        name: "旅伴".into(),
        persona: "沉默寡言的向导".into(),
        // 非 'type'（表默认值）：证明列值确系写入，而非吃列默认。
        render_style: "script".into(),
        is_user: true,
    };
    let before = now();
    let inserted = insert(&conn, &new).unwrap();
    let after = now();

    assert!(inserted.id > 0);
    let got = get(&conn, inserted.id).unwrap();
    assert_eq!(got.id, inserted.id);
    assert_eq!(got.session_id, sid);
    assert_eq!(got.character_id, None, "NULL 溯源往返一致");
    assert_eq!(got.name, "旅伴");
    assert_eq!(got.persona, "沉默寡言的向导");
    assert_eq!(got.render_style, "script");
    assert!(got.is_user, "is_user 经 0/1 库值往返");
    assert_eq!(got.deleted_at, None);
    assert!(
        got.created_at >= before && got.created_at <= after,
        "created_at 是落库时刻（时间窗内），非返回值上的第二次 now()"
    );
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

/// list_by_session 排序：is_user DESC 优先于 id ASC——用户位即便最后插入
/// 仍排最前，其余按插入序。
#[test]
fn list_by_session_orders_user_first_then_by_insert_order() {
    let (conn, dir, sid) = setup("instance_list_order");
    let first = insert(&conn, &new_instance(sid, "甲", false)).unwrap();
    let second = insert(&conn, &new_instance(sid, "乙", false)).unwrap();
    let you = insert(&conn, &new_instance(sid, "你", true)).unwrap();

    let list = list_by_session(&conn, sid).unwrap();
    let ids: Vec<i64> = list.iter().map(|i| i.id).collect();
    assert_eq!(ids, vec![you.id, first.id, second.id], "用户位在前，其余按插入序");
    assert!(list[0].is_user);
    assert!(list[1..].iter().all(|i| !i.is_user), "其余行均为非用户位");
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

/// list_by_session 软删过滤：墓碑行不入在世列表，其余行原序保留。
#[test]
fn list_by_session_excludes_soft_deleted() {
    let (conn, dir, sid) = setup("instance_list_tomb");
    let keep1 = insert(&conn, &new_instance(sid, "甲", true)).unwrap();
    let gone = insert(&conn, &new_instance(sid, "乙", false)).unwrap();
    let keep2 = insert(&conn, &new_instance(sid, "丙", false)).unwrap();
    soft_delete(&conn, gone.id, 1_700_000_000_000).unwrap();

    let ids: Vec<i64> = list_by_session(&conn, sid).unwrap().iter().map(|i| i.id).collect();
    assert_eq!(ids, vec![keep1.id, keep2.id], "软删行被过滤，其余原序保留");
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

/// get 对墓碑行返回 NotFound：软删后与不存在对调用方等价（ADR-009 读路径
/// 统一过滤），错误携带实体名与 id。
#[test]
fn get_treats_soft_deleted_as_not_found() {
    let (conn, dir, sid) = setup("instance_get_tomb");
    let inst = insert(&conn, &new_instance(sid, "甲", false)).unwrap();
    soft_delete(&conn, inst.id, 1_700_000_000_000).unwrap();
    assert!(
        matches!(get(&conn, inst.id), Err(StorageError::NotFound { entity, id }) if entity == ENTITY && id == inst.id),
        "墓碑行按 NotFound 处理，且错误元数据指向本实体本行"
    );
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

/// get 对从未存在的 id 返回 NotFound：错误元数据同样携带实体名与所查 id。
#[test]
fn get_missing_id_returns_not_found() {
    let (conn, dir, _sid) = setup("instance_get_missing");
    let missing = 424_242;
    assert!(
        matches!(get(&conn, missing), Err(StorageError::NotFound { entity, id }) if entity == ENTITY && id == missing),
        "记录不存在同走 NotFound，错误元数据回显所查 id"
    );
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

/// soft_delete 成功路径：墓碑值恰为调用方传入的时间戳（离场清算可复现场景
/// 时刻，而非偷用 now()）。
#[test]
fn soft_delete_stamps_tombstone_with_caller_ts() {
    let (conn, dir, sid) = setup("instance_softdel_ok");
    let inst = insert(&conn, &new_instance(sid, "甲", false)).unwrap();
    let ts = 1_700_000_000_000;
    soft_delete(&conn, inst.id, ts).unwrap();

    let tomb: Option<i64> = conn
        .query_row(
            "SELECT deleted_at FROM character_instances WHERE id = ?1",
            params![inst.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tomb, Some(ts), "墓碑 = 调用方传入的时间戳");
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

/// soft_delete 重复删除（影响行数 n==0）：与删不存在行同走 NotFound——状态
/// 不二次改写，墓碑保持首次时间戳（幂等等价语义锁死）。
#[test]
fn soft_delete_twice_is_not_found_and_keeps_first_tombstone() {
    let (conn, dir, sid) = setup("instance_softdel_twice");
    let inst = insert(&conn, &new_instance(sid, "甲", false)).unwrap();
    soft_delete(&conn, inst.id, 1000).unwrap();
    assert!(
        matches!(soft_delete(&conn, inst.id, 2000), Err(StorageError::NotFound { .. })),
        "重复删除返回 NotFound，而非二次改写成功"
    );
    let tomb: Option<i64> = conn
        .query_row(
            "SELECT deleted_at FROM character_instances WHERE id = ?1",
            params![inst.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tomb, Some(1000), "墓碑保持首次时间戳，不被覆盖");
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}
