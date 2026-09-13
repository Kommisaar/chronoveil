//! sessions 表查询（FR-007：多会话管理）。软删过滤统一封装在本层（ADR-009）。

use rusqlite::{params, Connection, Row};

use crate::domain::error::StorageError;
use crate::domain::models::{NewCharacterInstance, NewScene, NewSession, Session};

use super::{instances, now, scenes, characters};

pub(crate) const ENTITY: &str = "session";

const COLS: &str = "id, title, calendar_config, created_at, updated_at, deleted_at, \
                    forked_from_session_id, fork_anchor_scene_idx";

fn row_to_session(row: &Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get(0)?,
        title: row.get(1)?,
        calendar_config: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        deleted_at: row.get(5)?,
        // 分叉元信息（迁移 0011）：普通建会话恒 NULL，只有分叉写入路径落值。
        forked_from_session_id: row.get(6)?,
        fork_anchor_scene_idx: row.get(7)?,
    })
}

/// 建会话（FR-007 + 多角色阵容 + FR-014 开局包），单事务（unchecked_transaction，
/// 模式同 insert_message / commit_settlement）：会话行、逐卡实例化与开场锚行同生共死，
/// 任一失败整体回滚。
///
/// - 阵容（D1/D2/D3）：`roster` 逐卡实例化——name / persona / render_style 从卡快照
///   拷贝（改卡不回写），character_id 记溯源；校验「恰一用户位 + ≥1 LLM 位」
///   （N ≥ 1，D3 逐拍生成的调用主体；v1.5 简化：多 LLM 位按 roster 序单次生成，
///   逐拍独立调用属第 2 步后能力）；动态人物（character_id = NULL 的实例）不经此
///   路径（D6 走导演裁决，第 3 步后接线）。
/// - 日历：向导显式指定优先（由 Rust 序列化 domain `CalendarConfig` 得 snake_case
///   存储 JSON，wire camelCase 不会入库），否则用户位卡快照兜底（FR-013）；
/// - 开场锚行（scenes idx-0）**无条件 seed**（§7-6）：显式开局与降级路径（opening =
///   None）都落「第 1 天 · 夜」缺省锚（§7-3），保证 latest_scene 从第一拍就存在；
///   `fic_day` / `fic_part` 缺省取 1 / 夜，`date_label` 落库前经
///   `fiction_time::date_label` 派生（与结算共用同一函数），`present` = 全部实例 id
///   （迁移 0009 起在场名单语义 = 实例）。
pub(crate) fn insert(conn: &Connection, new: &NewSession) -> Result<Session, StorageError> {
    // 阵容结构校验（D2 恰一扮演位 / D3 至少一位 LLM 位）：不合法直接拒绝，零落库。
    let user_count = new.roster.iter().filter(|pick| pick.is_user).count();
    if new.roster.len() < 2 || user_count != 1 {
        return Err(StorageError::Conflict(format!(
            "会话阵容必须为「用户扮演位 1 张卡 + LLM 位至少 1 张卡」，实际 {} 名成员、{} 个扮演位",
            new.roster.len(),
            user_count
        )));
    }
    let ts = now();
    let tx = conn.unchecked_transaction()?;

    // 会话日历（FR-013）：开局包显式指定，未指定 = 内置默认历。角色卡不持有
    // 历法（2026-09-13 产品裁剪），会话行是历法唯一归属。
    let explicit = new.opening.as_ref().and_then(|o| o.calendar.as_ref());
    let (calendar_config, calendar) = match explicit {
        Some(cal) => {
            let json = serde_json::to_string(cal)
                .map_err(|e| StorageError::Backend(format!("会话日历序列化失败：{e}")))?;
            (Some(json), cal.clone())
        }
        None => (None, crate::domain::fiction_time::parse(None)),
    };

    tx.execute(
        "INSERT INTO sessions (title, calendar_config, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?3)",
        params![new.title, calendar_config, ts],
    )?;
    let session_id = tx.last_insert_rowid();

    // 逐卡实例化（D1）：快照拷贝 + 溯源；卡不存在 / 已软删 → NotFound，整体回滚。
    let mut instance_ids = Vec::with_capacity(new.roster.len());
    for pick in &new.roster {
        let card = characters::get(&tx, pick.character_id)?;
        let instance = instances::insert(
            &tx,
            &NewCharacterInstance {
                session_id,
                character_id: Some(card.id),
                name: card.name,
                persona: card.persona,
                render_style: card.render_style,
                is_user: pick.is_user,
            },
        )?;
        instance_ids.push(instance.id);
    }

    // 开场锚行：day 缺省 1（防御性钳到 ≥1，入口校验在命令层）、part 缺省「夜」。
    let opening = new.opening.as_ref();
    let fic_day = opening.and_then(|o| o.fic_day).unwrap_or(1).max(1);
    let fic_part = opening
        .and_then(|o| o.fic_part.clone())
        .unwrap_or_else(|| "夜".to_string());
    scenes::insert(&tx, &NewScene {
        session_id,
        location: opening.and_then(|o| o.location.clone()),
        time_note: opening.and_then(|o| o.time_note.clone()),
        fic_day: Some(fic_day),
        fic_part: Some(fic_part.clone()),
        date_label: Some(crate::domain::fiction_time::date_label(
            &calendar, fic_day, &fic_part,
        )),
        summary: None,
        // 开场锚行无收束段，无 recap（Task-03）。
        recap: None,
        // 在场 = 全部阵容实例（FR-014 §1；迁移 0009 起在场名单语义 = 实例 id）。
        present: instance_ids,
    })?;

    tx.commit()?;
    Ok(Session {
        id: session_id,
        title: new.title.clone(),
        calendar_config,
        created_at: ts,
        updated_at: ts,
        deleted_at: None,
        // 建会话非分叉路径：分叉元信息为 NULL（迁移 0011）。
        forked_from_session_id: None,
        fork_anchor_scene_idx: None,
    })
}

/// 在世会话，按 updated_at 倒序（FR-007）；同刻以 id 降序保稳定。
pub(crate) fn list_by_updated_desc(conn: &Connection) -> Result<Vec<Session>, StorageError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM sessions WHERE deleted_at IS NULL \
         ORDER BY updated_at DESC, id DESC"
    ))?;
    let rows = stmt.query_map([], row_to_session)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub(crate) fn get(conn: &Connection, id: i64) -> Result<Session, StorageError> {
    let sql = format!("SELECT {COLS} FROM sessions WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], row_to_session)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => StorageError::NotFound { entity: ENTITY, id },
            other => other.into(),
        })
}

/// 刷新 updated_at（排序用）；只动时间戳，不参与可见性语义，故不过滤墓碑。
pub(crate) fn touch_at(conn: &Connection, id: i64, ts: i64) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
        params![id, ts],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

pub(crate) fn update_title(conn: &Connection, id: i64, title: &str) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE sessions SET title = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, title],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

pub(crate) fn soft_delete(conn: &Connection, id: i64, ts: i64) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE sessions SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, ts],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

pub(crate) fn restore(conn: &Connection, id: i64) -> Result<(), StorageError> {
    let n = conn.execute(
        "UPDATE sessions SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
        params![id],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound { entity: ENTITY, id });
    }
    Ok(())
}

#[cfg(test)]
mod tests;
