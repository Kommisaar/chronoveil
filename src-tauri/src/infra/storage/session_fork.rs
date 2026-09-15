//! 时间线分叉（方案《多角色与时间线-最终》§2 第 3 步）：在锚点场景上「从此分叉」，
//! 生成一个新会话，从锚点重走自己的时间线。本模块是多表编排（sessions /
//! world_instances / character_instances / scenes / messages / character_state
//! 一次性拷贝），事务边界在 `super`（storage.rs 端口实现）绑成单事务——任一步失败
//! 整体回滚，不留半条新线。
//!
//! 拷贝契约（正确性核心）：
//! - **拷贝彻底，禁止引用式偷懒**：锚点前的全部在世行按值逐字段复制、session_id
//!   整体改写为新会话；新线不持有任何指向源会话行的引用（除元信息两列记锚）。
//!   这是对方案「禁止引用式偷懒」的字面落实——引用式共享会让两线的后续写入互相
//!   污染，分叉就不再是分叉。
//! - **锚点界定**：锚场景本身**包含**在拷贝内（「从第 3 场分叉」= 新线含第 1..3
//!   场与截至锚场时刻的消息）；场景号（idx）保留原号——各线独立计数，号在本会话
//!   内唯一即可（单链假设重审之一，方案 §2 第 3 步），新线自有场次从锚点下一号
//!   （MAX(idx)+1）长起。
//! - **消息归属口径**：messages 归属以结算回填的 `scene_id` 为准（边界快照模型，
//!   FR-011）——已归属消息看其归属场是否 ≤ 锚点；`scene_id IS NULL` 的未归属消息
//!   （进行中场 / 结算欠账）只在整个会话的最新在世场就是锚点时随线拷贝（它们属于
//!   进行中的锚场；锚点之后还有后续场时，未归属消息属于锚点之后的场，不拷）。
//!   只拷在世消息（墓碑行 = 重新生成替换的旧条，ADR-009，不入新线）。
//! - **状态口径**：每（实例, key）取「含锚点场收束成果」的时点值
//!   `list_as_of_scene(锚点 idx + 1)`（导演约定状态记在被收束场、自下一场起生效，
//!   as_of 契约见 character_states.rs / ports.rs）落为新线的当前生效行——新线状态
//!   是锚点时点的值，锚点之后才出现的值不在其中。状态行的 source_scene 同步映射
//!   到新线场景 id（as_of 查询按 source_scene 的 idx 锚定，留旧 id 会让新线的后续
//!   as_of 跨会话读错号）。
//! - **llm_calls 不拷贝**：调用轨迹属原线（日志性质旁路数据），新线从零开始——
//!   「两线轨迹各自独立」正是验收口径。
//! - **BR-003 收窄**：「虚时不倒流」收窄为「**单时间线内**不倒流」（domain::
//!   fiction_time::clamp_day 注）：每条线（会话）独立虚时钟，从锚点场的 fic_day /
//!   fic_part 继续走；跨线回退合法且正是分叉的意义。本函数按值拷贝锚点前各场的
//!   fic_day / fic_part，新线账本即从锚点续写，无需换算。
//!
//! id 映射（三级，全部经逐行 last_insert_rowid 实测回填 HashMap，**不对
//! AUTOINCREMENT 的连续性做任何假设**——并发写入 / 墓碑 / 序列空洞使算术推算
//! 必然出错）：旧 instance_id → 新 id、旧 scene_id → 新 id、旧 session_id → 新 id。
//! 消息的 instance_id / scene_id 与场景 present JSON 数组都要过映射。
//!
//! 实例与消息的拷贝走本模块原生 SQL 而非 instances::insert / messages::insert：
//! 前者需保留 created_at 与墓碑语义（insert 恒 now() / 恒在世），后者的
//! scene_id / instance_id 是结算回填字段，NewMessage 不携带。

use std::collections::HashMap;

use rusqlite::{params, Connection};

use crate::domain::error::StorageError;
use crate::domain::models::{NewCharacterState, Session};

use super::{character_states, messages, now, scenes, sessions, world_instances};

/// 从源会话的锚点场景分叉出新会话（单事务由调用方绑定）。
///
/// 参数：源会话 id、锚场景号（源会话 scenes.idx 口径）、新标题（文案由调用方定，
/// 本层原样落库）。返回新会话行（forked_from_session_id / fork_anchor_scene_idx
/// 已落值）；新线 id 经 AUTOINCREMENT 分配，不可假设与源会话有任何数值关系。
///
/// 错误：源会话不存在或已软删 → NotFound（软删等价不可见，ADR-009 语义——已删
/// 会话不可再分叉）；锚点号无对应在世场景 → NotFound（id 字段承载的是锚点 idx，
/// 即调用方传入值）；拷贝途中必要映射缺失 → Backend（数据损坏级别，显式上抛
/// 不吞）。原线零影响：只读源会话全部行，不触碰其任何时间戳与内容。
pub(crate) fn fork(
    conn: &Connection,
    source_session_id: i64,
    anchor_scene_idx: i64,
    new_title: &str,
) -> Result<Session, StorageError> {
    // 源会话在世校验（软删等价不可见）：分叉线继承源会话的世界与时间线，而非
    // 回查世界卡 / 角色卡（快照复制后各自演进，FR-013 语义随 0017 移入世界实例）。
    sessions::get(conn, source_session_id)?;

    // 锚点校验：必须是源会话内在世场景（号 → 行的存在性以此给出，墓碑锚无意义）。
    let anchor_exists: Option<i64> = conn
        .query_row(
            "SELECT id FROM scenes \
             WHERE session_id = ?1 AND idx = ?2 AND deleted_at IS NULL",
            params![source_session_id, anchor_scene_idx],
            |r| r.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    if anchor_exists.is_none() {
        return Err(StorageError::NotFound {
            entity: "scene",
            id: anchor_scene_idx,
        });
    }

    // 未归属消息（scene_id IS NULL）是否随线：仅当锚点就是最新在世场（见模块契约）。
    let anchor_is_latest = match scenes::latest(conn, source_session_id)? {
        Some(latest) => latest.idx == anchor_scene_idx,
        None => false,
    };

    let ts = now();

    // 1) 新会话行：标题由调用方传入；分叉锚两列在此落值（迁移 0011；历法列已随
    //    0017 裁撤，历法随世界实例走 1b）。
    conn.execute(
        "INSERT INTO sessions (title, created_at, updated_at, \
             forked_from_session_id, fork_anchor_scene_idx) \
         VALUES (?1, ?2, ?2, ?3, ?4)",
        params![new_title, ts, source_session_id, anchor_scene_idx],
    )?;
    let new_session_id = conn.last_insert_rowid();

    // 1b) 世界实例拷贝（2026-09-15 世界卡定稿）：历法唯一归属随行携带（0017），
    //     新线继续源线的历法与世界观数据。源无在世世界实例 = 数据损坏级别
    //     （建会话事务保证存在），显式上抛不吞。溯源 world_id 原样保留（快照
    //     冻结语义），created_at 保留源值。
    let source_world = world_instances::by_session(conn, source_session_id)?.ok_or_else(|| {
        StorageError::Backend(format!(
            "分叉源会话 #{source_session_id} 没有在世世界实例（建会话事务保证存在，缺失即数据损坏）"
        ))
    })?;
    conn.execute(
        "INSERT INTO world_instances (session_id, world_id, name, worldbook, \
             calendar_config, created_at, deleted_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            new_session_id,
            source_world.world_id,
            source_world.name,
            source_world.worldbook,
            source_world.calendar_config,
            source_world.created_at,
            source_world.deleted_at,
        ],
    )?;

    // 2) 实例全员拷贝（含墓碑位）：D4 离场实例的早期消息仍挂在它名下，新线消息
    //    拷贝有外键（messages.instance_id → character_instances.id），漏拷墓碑位
    //    会让历史消息悬空；墓碑语义随行保留（离场者在新线同样不在世）。
    let mut instance_map: HashMap<i64, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, character_id, name, persona, render_style, is_user, \
                 created_at, deleted_at \
             FROM character_instances WHERE session_id = ?1 ORDER BY id ASC",
        )?;
        let mut rows = stmt.query(params![source_session_id])?;
        while let Some(row) = rows.next()? {
            let old_id: i64 = row.get(0)?;
            conn.execute(
                "INSERT INTO character_instances (session_id, character_id, name, persona, \
                     render_style, is_user, created_at, deleted_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    new_session_id,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                ],
            )?;
            instance_map.insert(old_id, conn.last_insert_rowid());
        }
    }

    // 3) 锚点前（含锚点）在世场景拷贝，**保留原 idx**（各线独立计数）。逐行值拷贝
    //    而非 INSERT...SELECT：present 数组要过实例映射，SQL 内无法完成。
    let mut scene_map: HashMap<i64, i64> = HashMap::new();
    for scene in scenes::list_by_session(conn, source_session_id)? {
        if scene.idx > anchor_scene_idx {
            break; // list 按 idx 升序，锚点之后不再拷贝。
        }
        // 在场名单逐 id 映射到新线实例（名单语义 = 实例 id，迁移 0009）。
        let present = scene
            .present
            .iter()
            .map(|old| {
                instance_map.get(old).copied().ok_or_else(|| {
                    StorageError::Backend(format!(
                        "分叉拷贝映射缺失：场景 #{} 的在场实例 #{} 不在源会话实例集",
                        scene.id, old
                    ))
                })
            })
            .collect::<Result<Vec<i64>, StorageError>>()?;
        conn.execute(
            "INSERT INTO scenes (session_id, idx, location, time_note, fic_day, fic_part, \
                 date_label, summary, recap, present) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                new_session_id,
                scene.idx, // 原号保留：新线自有场次自锚点下一号长起（模块契约）。
                scene.location,
                scene.time_note,
                scene.fic_day,
                scene.fic_part,
                scene.date_label,
                scene.summary,
                scene.recap,
                serde_json::to_string(&present)
                    .map_err(|e| StorageError::Backend(format!("present 序列化失败：{e}")))?,
            ],
        )?;
        scene_map.insert(scene.id, conn.last_insert_rowid());
    }

    // 4) 锚点前在世消息拷贝（归属口径见模块契约）：session_id / scene_id /
    //    instance_id 三级映射全部改写，created_at 原样保留（对话顺序的展示依据）。
    for msg in messages::list_by_session(conn, source_session_id)? {
        let included = match msg.scene_id {
            Some(old_scene) => scene_map.contains_key(&old_scene),
            None => anchor_is_latest,
        };
        if !included {
            continue;
        }
        let new_scene_id = match msg.scene_id {
            None => None,
            Some(old_scene) => Some(scene_map.get(&old_scene).copied().ok_or_else(|| {
                StorageError::Backend(format!(
                    "分叉拷贝映射缺失：消息 #{} 归属场景 #{} 未随线拷贝",
                    msg.id, old_scene
                ))
            })?),
        };
        let new_instance_id = match msg.instance_id {
            None => None,
            Some(old_instance) => {
                Some(instance_map.get(&old_instance).copied().ok_or_else(|| {
                    StorageError::Backend(format!(
                        "分叉拷贝映射缺失：消息 #{} 说话人实例 #{} 不在源会话实例集",
                        msg.id, old_instance
                    ))
                })?)
            }
        };
        conn.execute(
            "INSERT INTO messages (session_id, role, content, reasoning, think_ms, tokens, \
                 created_at, interrupt_flag, scene_id, instance_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                new_session_id,
                msg.role.as_str(),
                msg.content,
                msg.reasoning,
                msg.think_ms,
                msg.tokens,
                msg.created_at,
                msg.interrupt_flag,
                new_scene_id,
                new_instance_id,
            ],
        )?;
    }

    // 5) 状态落新线：as_of(锚点 idx + 1) =「含锚点场收束成果」的当时值（每
    //    (实例, key) 恰一行，见 as_of 契约）。经既有 upsert 原语落库（新线无既有
    //    状态行，即纯插入为生效行）；instance_id / source_scene 过映射——source_scene
    //    留旧 id 会把新线未来的 as_of 查询引到源会话的场景行上（该查询按 idx 比较、
    //    不校验会话，见 character_states::list_as_of_scene）。
    let as_of = character_states::list_as_of_scene(conn, source_session_id, anchor_scene_idx + 1)?;
    for state in as_of {
        let new_instance = instance_map
            .get(&state.instance_id)
            .copied()
            .ok_or_else(|| {
                StorageError::Backend(format!(
                    "分叉拷贝映射缺失：状态行 #{} 归属实例 #{} 不在源会话实例集",
                    state.id, state.instance_id
                ))
            })?;
        let new_source_scene = match state.source_scene {
            None => None,
            Some(old_scene) => Some(scene_map.get(&old_scene).copied().ok_or_else(|| {
                StorageError::Backend(format!(
                    "分叉拷贝映射缺失：状态行 #{} 来源场景 #{} 未随线拷贝",
                    state.id, old_scene
                ))
            })?),
        };
        character_states::upsert(
            conn,
            &NewCharacterState {
                instance_id: new_instance,
                scope: state.scope,
                key: state.key.clone(),
                value: state.value.clone(),
                expiry: state.expiry.clone(),
                source_scene: new_source_scene,
            },
        )?;
    }

    Ok(Session {
        id: new_session_id,
        title: new_title.to_string(),
        created_at: ts,
        updated_at: ts,
        deleted_at: None,
        forked_from_session_id: Some(source_session_id),
        fork_anchor_scene_idx: Some(anchor_scene_idx),
    })
}

#[cfg(test)]
mod tests;
