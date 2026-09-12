//! sessions 表查询（FR-007：多会话管理）。软删过滤统一封装在本层（ADR-009）。

use rusqlite::{params, Connection, Row};

use crate::domain::error::StorageError;
use crate::domain::models::{NewCharacterInstance, NewScene, NewSession, Session};

use super::{instances, now, scenes, characters};

pub(crate) const ENTITY: &str = "session";

const COLS: &str = "id, title, calendar_config, created_at, updated_at, deleted_at";

fn row_to_session(row: &Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get(0)?,
        title: row.get(1)?,
        calendar_config: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        deleted_at: row.get(5)?,
    })
}

/// 用户位卡的日历快照（FR-013「日历归属与继承」在多角色阵容下的裁量为：快照取
/// **用户扮演位**的卡——会话视角主体；显式开局包优先级更高）。卡不存在时返回 None，
/// 由实例化路径的逐卡 NotFound 上报真实原因（保持可判别错误语义）。
fn snapshot_user_calendar(
    conn: &Connection,
    character_id: i64,
) -> Result<Option<String>, StorageError> {
    match conn.query_row(
        "SELECT calendar_config FROM characters WHERE id = ?1 AND deleted_at IS NULL",
        params![character_id],
        |r| r.get::<_, Option<String>>(0),
    ) {
        Ok(v) => Ok(v),
        // 卡不存在：日历取 None，错误由下方实例化的 characters::get 上报。
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
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

    let user_pick = new
        .roster
        .iter()
        .find(|pick| pick.is_user)
        .expect("阵容校验已保证恰一用户位");
    let explicit = new.opening.as_ref().and_then(|o| o.calendar.as_ref());
    let (calendar_config, calendar) = match explicit {
        Some(cal) => {
            let json = serde_json::to_string(cal)
                .map_err(|e| StorageError::Backend(format!("会话日历序列化失败：{e}")))?;
            (Some(json), cal.clone())
        }
        None => {
            let raw = snapshot_user_calendar(&tx, user_pick.character_id)?;
            let cal = crate::domain::fiction_time::parse(raw.as_deref());
            (raw, cal)
        }
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
mod tests {
    use super::*;
    use crate::domain::fiction_time;
    use crate::domain::models::{MessageRole, NewCharacter, OpeningSeed, RosterPick};
    use crate::domain::ports::StoragePort;
    use crate::infra::storage::test_support::{cleanup, temp_storage};
    use crate::infra::storage::Storage;
    use rusqlite::Connection;
    use std::thread::sleep;
    use std::time::Duration;

    /// 阵容便捷构造：用户位卡 + 单张 LLM 位卡（保持 roster 输入序 = 实例创建序）。
    fn roster(user_card: i64, llm_card: i64) -> Vec<RosterPick> {
        vec![
            RosterPick { character_id: user_card, is_user: true },
            RosterPick { character_id: llm_card, is_user: false },
        ]
    }

    fn make_session(storage: &crate::infra::storage::Storage, title: &str) -> i64 {
        let user_card = storage
            .create_character(&NewCharacter { name: "旅人".into(), ..Default::default() })
            .unwrap()
            .id;
        let llm_card = storage
            .create_character(&NewCharacter { name: "卡".into(), ..Default::default() })
            .unwrap()
            .id;
        storage
            .create_session(&NewSession {
                roster: roster(user_card, llm_card),
                title: title.into(),
                opening: None,
            })
            .unwrap()
            .id
    }

    /// 验收 4（TASK-011）多角色裁量版：create_session 从**用户位卡**复制
    /// characters.calendar_config 快照——用户位卡有日历则会话拿到同值；
    /// 用户位卡为 NULL（内置默认历）则会话亦 NULL。LLM 位卡日历不参与快照。
    #[test]
    fn create_session_snapshots_user_position_calendar() {
        let (storage, dir) = temp_storage("sess_calendar");
        let db_path = dir.join("test.db");
        let with_cal = storage
            .create_character(&NewCharacter {
                name: "有历".into(),
                ..Default::default()
            })
            .unwrap()
            .id;
        let without_cal = storage
            .create_character(&NewCharacter {
                name: "默认".into(),
                ..Default::default()
            })
            .unwrap()
            .id;
        drop(storage);

        // 预置角色卡日历（JSON 任意，存储层透传不解释）
        let config = r#"{"months":["白蜡月"],"days_per_month":30,"dayNames":["晨露日"]}"#;
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "UPDATE characters SET calendar_config = ?1 WHERE id = ?2",
                rusqlite::params![config, with_cal],
            )
            .unwrap();
        }

        let storage = Storage::open(&db_path).unwrap();
        // 用户位 = 有历卡：快照取它。
        let snapshotted = storage
            .create_session(&NewSession {
                roster: roster(with_cal, without_cal),
                title: String::new(),
                opening: None,
            })
            .unwrap();
        assert_eq!(
            snapshotted.calendar_config.as_deref(),
            Some(config),
            "建会话必须复制用户位卡日历快照（FR-013 多角色裁量）"
        );
        // 快照随行读回一致
        assert_eq!(
            storage.get_session(snapshotted.id).unwrap().calendar_config.as_deref(),
            Some(config)
        );

        // 用户位 = 无历卡：会话亦 NULL = 内置默认历（LLM 位卡日历不影响）。
        let default_cal = storage
            .create_session(&NewSession {
                roster: roster(without_cal, with_cal),
                title: String::new(),
                opening: None,
            })
            .unwrap();
        assert_eq!(
            default_cal.calendar_config, None,
            "用户位卡无日历（NULL）则会话亦 NULL = 内置默认历"
        );
        drop(storage);
        cleanup(&dir);
    }

    // ---- FR-014：开局包单事务落库 ----

    /// 夹具：建用户位卡「苏鸢」+ LLM 位卡「阿烬」，返回 (storage, dir, user_card, llm_card)。
    fn char_fixture(tag: &str) -> (Storage, std::path::PathBuf, i64, i64) {
        let (storage, dir) = temp_storage(tag);
        let user_card = storage
            .create_character(&NewCharacter { name: "苏鸢".into(), ..Default::default() })
            .unwrap()
            .id;
        let llm_card = storage
            .create_character(&NewCharacter { name: "阿烬".into(), ..Default::default() })
            .unwrap()
            .id;
        (storage, dir, user_card, llm_card)
    }

    /// 显式开局：向导指定的日历 / 锚 / 场景字段逐一落库——日历覆盖快照（snake_case
    /// 存储 JSON）、锚行 idx=0、date_label 经 date_label 派生、present = 全部实例 id。
    #[test]
    fn opening_seeds_explicit_calendar_and_anchor_scene() {
        let (storage, dir, user_card, llm_card) = char_fixture("opening_explicit");
        let preset = fiction_time::presets::fantasy();
        let session = storage
            .create_session(&NewSession {
                roster: roster(user_card, llm_card),
                title: String::new(),
                opening: Some(OpeningSeed {
                    calendar: Some(preset.clone()),
                    fic_day: Some(45),
                    fic_part: Some("夜".into()),
                    location: Some("旧都 · 灯市".into()),
                    time_note: Some("灯节点亮的那一刻".into()),
                }),
            })
            .unwrap();

        // 日历显式指定优先于用户位卡快照（本例卡无快照，JSON 为 Rust 序列化产物）。
        let stored = session.calendar_config.as_deref().unwrap();
        assert_eq!(fiction_time::parse(Some(stored)), preset, "显式日历原样落库");
        assert!(stored.contains("days_per_month"), "存储 JSON 为 snake_case：{stored}");

        let scene = storage.latest_scene(session.id).unwrap().unwrap();
        assert_eq!(scene.idx, 0, "开场锚 = 首场景行");
        assert_eq!(scene.fic_day, Some(45));
        assert_eq!(scene.fic_part.as_deref(), Some("夜"));
        assert_eq!(
            scene.date_label.as_deref(),
            Some("白蜡月·潮汐日·夜（灯节）"),
            "date_label 与结算共用 date_label 派生（日名按年内日序取模）"
        );
        assert_eq!(scene.location.as_deref(), Some("旧都 · 灯市"));
        assert_eq!(scene.time_note.as_deref(), Some("灯节点亮的那一刻"));
        assert_eq!(scene.summary, None, "开场行无摘要");
        // 在场 = 全部阵容实例（roster 输入序 = 实例创建序：用户位在前）。
        assert_eq!(scene.present, vec![1, 2], "在场 = 全部实例 id（迁移 0009 语义）");
        // 实例化本身：用户位在前（is_user DESC 排序），快照值逐一正确。
        let instances = storage.list_instances(session.id).unwrap();
        assert_eq!(instances.len(), 2);
        assert!(instances[0].is_user && !instances[1].is_user, "用户位排在首位");
        assert_eq!(instances[0].name, "苏鸢");
        assert_eq!(instances[1].name, "阿烬");
        assert_eq!(instances[1].character_id, Some(llm_card), "实例记模板溯源");
        drop(storage);
        cleanup(&dir);
    }

    /// 降级路径（opening = None）也无条件 seed 默认锚行：day=1 / part=夜；日历走
    /// 用户位卡快照兜底，date_label 按快照皮肤派生（§7-6：从第一拍有账可记）。
    #[test]
    fn degraded_path_still_seeds_default_anchor_from_snapshot() {
        let (storage, dir) = temp_storage("opening_degraded");
        let user_card = storage
            .create_character(&NewCharacter { name: "有历".into(), ..Default::default() })
            .unwrap()
            .id;
        let llm_card = storage
            .create_character(&NewCharacter { name: "阿烬".into(), ..Default::default() })
            .unwrap()
            .id;
        drop(storage);
        // 预置用户位卡日历（带皮肤）：降级路径的锚行 date_label 应按快照派生。
        {
            let conn = Connection::open(dir.join("test.db")).unwrap();
            conn.execute(
                "UPDATE characters SET calendar_config = ?1 WHERE id = ?2",
                rusqlite::params![
                    r#"{"name":"旧都历","months":["霜月","白蜡月"],"days_per_month":30,"day_names":["晨露日","萤火日"]}"#,
                    user_card
                ],
            )
            .unwrap();
        }
        let storage = Storage::open(&dir.join("test.db")).unwrap();

        let session = storage
            .create_session(&NewSession {
                roster: roster(user_card, llm_card),
                title: String::new(),
                opening: None,
            })
            .unwrap();
        assert!(
            session.calendar_config.is_some(),
            "降级路径日历 = 用户位卡快照兜底"
        );
        let scene = storage.latest_scene(session.id).unwrap().unwrap();
        assert_eq!(scene.idx, 0);
        assert_eq!(scene.fic_day, Some(1), "day 缺省 1");
        assert_eq!(scene.fic_part.as_deref(), Some("夜"), "part 缺省「夜」");
        assert_eq!(
            scene.date_label.as_deref(),
            Some("霜月·晨露日·夜"),
            "date_label 按快照日历派生"
        );
        assert_eq!(scene.location, None, "降级路径无用户场景字段");
        assert_eq!(scene.time_note, None);
        drop(storage);
        cleanup(&dir);
    }

    /// 事务原子性：阵容含不存在的卡 → 会话行 / 实例 / 开场锚行都不留痕迹；
    /// 错误为逐卡 NotFound（实例化路径的真实语义，不再是无名外键冲突）。
    #[test]
    fn opening_rolls_back_session_and_scene_together() {
        let (storage, dir, user_card, _llm_card) = char_fixture("opening_rollback");
        let err = storage
            .create_session(&NewSession {
                roster: roster(user_card, 999_999),
                title: String::new(),
                opening: Some(OpeningSeed {
                    calendar: Some(fiction_time::presets::modern()),
                    fic_day: None,
                    fic_part: None,
                    location: None,
                    time_note: None,
                }),
            })
            .unwrap_err();
        assert!(matches!(err, StorageError::NotFound { .. }), "实际：{err:?}");

        // scenes / sessions / character_instances 表全库无行（会话行未落 → 后续全部回滚）。
        let conn = Connection::open(dir.join("test.db")).unwrap();
        let scenes: i64 = conn
            .query_row("SELECT COUNT(*) FROM scenes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(scenes, 0, "开场锚行随会话行一并回滚");
        let sessions: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sessions, 0, "会话行回滚");
        let instances: i64 = conn
            .query_row("SELECT COUNT(*) FROM character_instances", [], |r| r.get(0))
            .unwrap();
        assert_eq!(instances, 0, "实例随会话一并回滚");
        drop(storage);
        cleanup(&dir);
    }

    /// 阵容结构校验（D2 / D3）：零成员、双用户位、纯 LLM 位（零扮演位）、
    /// 只有用户位（无 LLM 位）都被拒绝，零落库。
    #[test]
    fn create_session_rejects_invalid_rosters() {
        let (storage, dir, user_card, llm_card) = char_fixture("roster_invalid");
        let cases: Vec<(&str, Vec<RosterPick>)> = vec![
            ("空阵容", vec![]),
            ("双用户位", roster(user_card, llm_card)),
            (
                "纯 LLM 位",
                vec![
                    RosterPick { character_id: user_card, is_user: false },
                    RosterPick { character_id: llm_card, is_user: false },
                ],
            ),
            ("只有用户位", vec![RosterPick { character_id: user_card, is_user: true }]),
        ];
        // 「双用户位」用两张不同的卡各标 is_user 构造真正的双扮演位。
        let mut double_user = roster(user_card, llm_card);
        double_user[1].is_user = true;
        let cases: Vec<(&str, Vec<RosterPick>)> = cases
            .into_iter()
            .map(|(name, picks)| if name == "双用户位" { (name, double_user.clone()) } else { (name, picks) })
            .collect();
        for (name, picks) in cases {
            let err = storage
                .create_session(&NewSession { roster: picks, title: String::new(), opening: None })
                .unwrap_err();
            assert!(matches!(err, StorageError::Conflict(_)), "{name} 应被拒绝：{err:?}");
        }
        assert!(storage.list_sessions().unwrap().is_empty(), "全部拒绝：零落库");
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 建会话阵容实例化验收（方案 §6 验收总纲 1）：1 用户位 + 2 LLM 位 → 3 实例，
    /// is_user 恰一、快照值与卡一致、present 写全部实例 id。
    #[test]
    fn create_session_instantiates_full_roster() {
        let (storage, dir, user_card, llm_card) = char_fixture("roster_full");
        let second = storage
            .create_character(&NewCharacter {
                name: "路人".into(),
                persona: "恰好路过".into(),
                ..Default::default()
            })
            .unwrap()
            .id;
        let session = storage
            .create_session(&NewSession {
                roster: vec![
                    RosterPick { character_id: user_card, is_user: true },
                    RosterPick { character_id: llm_card, is_user: false },
                    RosterPick { character_id: second, is_user: false },
                ],
                title: String::new(),
                opening: None,
            })
            .unwrap();

        let instances = storage.list_instances(session.id).unwrap();
        assert_eq!(instances.len(), 3, "三卡三实例");
        assert_eq!(
            instances.iter().filter(|i| i.is_user).count(),
            1,
            "is_user 恰好一（D2）"
        );
        // 用户位在前（is_user DESC），LLM 位按创建序（id ASC）。
        assert!(instances[0].is_user);
        assert_eq!(instances[0].name, "苏鸢");
        assert_eq!(instances[0].character_id, Some(user_card));
        assert_eq!(instances[1].name, "阿烬");
        assert_eq!(instances[2].name, "路人");
        assert_eq!(instances[2].persona, "恰好路过", "persona 随卡快照");
        // 锚行 present = 全部实例 id。
        let scene = storage.latest_scene(session.id).unwrap().unwrap();
        let ids: Vec<i64> = instances.iter().map(|i| i.id).collect();
        assert_eq!(scene.present, ids, "开场锚行在场名单 = 全部实例");
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_crud_and_title_update() {
        let (storage, dir) = temp_storage("sess_crud");
        let id = make_session(&storage, "");

        assert_eq!(storage.get_session(id).unwrap().title, "");

        storage.update_session_title(id, "第一夜").unwrap();
        assert_eq!(storage.get_session(id).unwrap().title, "第一夜");

        // 软删过滤 + NotFound + 还原
        storage.soft_delete_session(id).unwrap();
        assert!(storage.list_sessions().unwrap().is_empty());
        assert!(matches!(
            storage.get_session(id),
            Err(StorageError::NotFound { .. })
        ));
        storage.restore_session(id).unwrap();
        assert_eq!(storage.list_sessions().unwrap().len(), 1);
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sessions_listed_by_updated_at_desc() {
        let (storage, dir) = temp_storage("sess_order");
        let s1 = make_session(&storage, "一");
        sleep(Duration::from_millis(4));
        let s2 = make_session(&storage, "二");
        sleep(Duration::from_millis(4));
        let s3 = make_session(&storage, "三");

        let ids: Vec<i64> = storage
            .list_sessions()
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec![s3, s2, s1], "默认按 updated_at 倒序（FR-007）");

        // 触碰最旧的 s1 → 跳到最前
        sleep(Duration::from_millis(4));
        storage.touch_session(s1).unwrap();
        let ids: Vec<i64> = storage
            .list_sessions()
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec![s1, s3, s2]);

        // 新消息刷新 updated_at：往 s2 插一条后 s2 应排最前
        sleep(Duration::from_millis(4));
        let _ = storage
            .insert_message(&crate::domain::models::NewMessage::new(
                s2,
                MessageRole::User,
                "你好",
            ))
            .unwrap();
        let ids: Vec<i64> = storage
            .list_sessions()
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec![s2, s1, s3]);
        drop(storage);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
