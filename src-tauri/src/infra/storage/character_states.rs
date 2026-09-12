//! character_state 表查询（FR-012：会话内人物状态，多角色换挂后挂**实例**——
//! 迁移 0009：列 character_id + session_id → instance_id NOT NULL，会话隶属由实例
//! 携带）。软删过滤统一封装在本层（ADR-009）。
//! 状态历史化（迁移 0010，方案 §2 第 2 步方案 A）：同键（instance_id, key）演进为
//! append-only 行链——写入只追加，旧行打 superseded_at；「当前生效行」判定 =
//! `deleted_at IS NULL AND superseded_at IS NULL`（与迁移 0010 的 partial unique
//! index 互为同一约束的两处出现，改动须同步）。superseded_at（演进取代，历史链）
//! 与 deleted_at（墓碑清除，ADR-009）语义独立：历史链行仍可经 as_of 查询还原，
//! 墓碑行不参与任何读路径。

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::domain::error::StorageError;
use crate::domain::models::{CharacterState, CharacterStateScope, NewCharacterState};

use super::now;

pub(crate) const ENTITY: &str = "character_state";

const COLS: &str = "id, instance_id, scope, \"key\", value, expiry, \
                    source_scene, updated_at, deleted_at, superseded_at";

/// 行 → 领域对象；scope 解析需携带领域错误，故不走 `rusqlite::Result` 闭包签名。
fn state_from_row(row: &Row<'_>) -> Result<CharacterState, StorageError> {
    Ok(CharacterState {
        id: row.get(0)?,
        instance_id: row.get(1)?,
        scope: CharacterStateScope::from_db(&row.get::<_, String>(2)?)?,
        key: row.get(3)?,
        value: row.get(4)?,
        expiry: row.get(5)?,
        source_scene: row.get(6)?,
        updated_at: row.get(7)?,
        deleted_at: row.get(8)?,
        superseded_at: row.get(9)?,
    })
}

/// 按主键取整行（追加写入后的新行回读用；新行恒为生效行，无需过滤）。
fn get_by_id(conn: &Connection, id: i64) -> Result<CharacterState, StorageError> {
    let sql = format!("SELECT {COLS} FROM character_state WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => state_from_row(row),
        None => Err(StorageError::NotFound { entity: ENTITY, id }),
    }
}

/// 追加式状态变更（迁移 0010 状态历史化）：同键存在生效行时旧行打 superseded_at +
/// 插入新行（append-only，历史链保留全程——第 3 步时间线分叉依赖「还原的是存的」）；
/// 无生效行（首插 / 墓碑后重插 / 被取代后重插）则直接插入。墓碑行不阻塞重插：
/// partial unique index 只约束生效行（迁移 0002 决策、0010 收窄）。
/// 事务边界在 super（mod.rs）：端口直连路径由调用方包单事务（取代 + 插入半写会断链），
/// 结算路径复用 commit_settlement 的外层事务。连接互斥串行（单进程单写入），
/// 查后写无竞态。
pub(crate) fn upsert(
    conn: &Connection,
    new: &NewCharacterState,
) -> Result<CharacterState, StorageError> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM character_state \
             WHERE instance_id = ?1 AND \"key\" = ?2 \
             AND deleted_at IS NULL AND superseded_at IS NULL",
            params![new.instance_id, new.key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        conn.execute(
            "UPDATE character_state SET superseded_at = ?2 \
             WHERE id = ?1 AND deleted_at IS NULL AND superseded_at IS NULL",
            params![id, now()],
        )?;
    }
    conn.execute(
        "INSERT INTO character_state (instance_id, scope, \"key\", \
             value, expiry, source_scene, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            new.instance_id,
            new.scope.as_str(),
            new.key,
            new.value,
            new.expiry,
            new.source_scene,
            now(),
        ],
    )?;
    get_by_id(conn, conn.last_insert_rowid())
}

/// 会话内全部**当前生效**状态（跨实例、不分组），按 id 升序（插入序稳定）。
/// 历史链行（superseded_at 非 NULL）与墓碑行都不出现——装配（generation）/
/// 结算（director）/ IPC 状态面板的读视角与历史化之前一致（验收 1：现有行为不变）。
/// 状态行不携带 session_id（迁移 0009 换挂）——经实例表按会话过滤。
pub(crate) fn list_by_session(
    conn: &Connection,
    session_id: i64,
) -> Result<Vec<CharacterState>, StorageError> {
    // JOIN 下裸列名歧义（两表都有 id / deleted_at）：SELECT 列逐一限定表名。
    let qualified = "character_state.id, character_state.instance_id, scope, \
                     \"key\", value, expiry, character_state.source_scene, \
                     character_state.updated_at, character_state.deleted_at, \
                     character_state.superseded_at";
    let sql = format!(
        "SELECT {qualified} FROM character_state \
         JOIN character_instances ON character_instances.id = character_state.instance_id \
         WHERE character_instances.session_id = ?1 \
           AND character_state.deleted_at IS NULL \
           AND character_state.superseded_at IS NULL \
         ORDER BY character_state.id ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![session_id])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(state_from_row(row)?);
    }
    Ok(out)
}

pub(crate) fn soft_delete(conn: &Connection, id: i64, ts: i64) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE character_state SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, ts],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

/// 状态时间点还原（迁移 0010 / 方案 §2 第 2 步；第 3 步「时间线分叉」的读原语）。
/// 语义详见 domain/ports.rs 同名方法的契约注释；此处是实现要点：
/// - 每（实例, key）取「来源场景号严格小于锚点 idx」的最新行——导演约定状态记在
///   被收束场（source_scene）上、自下一场起生效，故 `idx < 锚点` = 锚点场景进行中时
///   已生效；NULL source_scene 视为自会话之始存在（`source IS NULL` 单独放行）。
/// - 生效过滤只排墓碑（deleted_at IS NULL），**不排** superseded 行：锚点时点的
///   最新行往往正是当下已被取代的历史行，这正是 as_of 的意义。
/// - 每 key 取最新用相关子查询实现（ORDER BY updated_at DESC, id DESC 兜底同刻
///   稳定序），代替窗口函数——语义等价且不依赖 SQLite 版本特性。
pub(crate) fn list_as_of_scene(
    conn: &Connection,
    session_id: i64,
    scene_idx: i64,
) -> Result<Vec<CharacterState>, StorageError> {
    // 生效判定（只排墓碑）与来源锚定（号 < 锚点 / NULL 放行）在内外两层查询各出现
    // 一次，两处 SQL 字面一致——与 list_by_session 的「当下生效」判定刻意不同
    //（as_of 不排 superseded），改动时四处于以同步。
    let sql = format!(
        "SELECT {COLS} FROM character_state \
         WHERE id IN ( \
             SELECT cs.id FROM character_state cs \
             JOIN character_instances ci ON ci.id = cs.instance_id \
             LEFT JOIN scenes src ON src.id = cs.source_scene \
             WHERE ci.session_id = ?1 \
               AND cs.deleted_at IS NULL \
               AND (cs.source_scene IS NULL OR src.idx < ?2) \
               AND cs.id = ( \
                   SELECT cs2.id FROM character_state cs2 \
                   JOIN character_instances ci2 ON ci2.id = cs2.instance_id \
                   LEFT JOIN scenes src2 ON src2.id = cs2.source_scene \
                   WHERE ci2.session_id = ?1 \
                     AND cs2.instance_id = cs.instance_id AND cs2.\"key\" = cs.\"key\" \
                     AND cs2.deleted_at IS NULL \
                     AND (cs2.source_scene IS NULL OR src2.idx < ?2) \
                   ORDER BY cs2.updated_at DESC, cs2.id DESC LIMIT 1) \
         ) \
         ORDER BY id ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![session_id, scene_idx])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(state_from_row(row)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
