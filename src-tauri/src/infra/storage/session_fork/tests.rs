//! session_fork 存储测试（自 session_fork.rs 外置，源文件 500 行上限）：
//! 验收口径（方案《多角色与时间线-最终》§6 第 3 步）——「第 7 天分叉回第 3 天」：
//! 新线状态是第 3 天当时值（无第 7 天才获得的东西）、虚时从第 3 天重走、原线零影响、
//! 两线轨迹各自独立；外加三级 id 映射正确性与锚点边界用例。

use super::super::test_support::{cleanup, temp_storage};
use super::super::Storage;
use crate::domain::error::StorageError;
use crate::domain::llm_call::{LlmCallKind, LlmCallStatus, NewLlmCall};
use crate::domain::models::{
    CharacterState, CharacterStateScope, MessageRole, NewCharacter, NewCharacterState, NewMessage,
    NewScene, NewSession, OpeningSeed, RosterPick, Scene, Session,
};
use crate::domain::ports::{AttachRange, SettlementWrite, StoragePort};
use rusqlite::{params, Connection};
use std::path::PathBuf;

/// 阵容：旅人（用户位）+ 艾莉、烬（两个 LLM 位）——映射正确性用例要求 ≥2 LLM 位。
fn roster(user_card: i64, ai_card: i64, jin_card: i64) -> Vec<RosterPick> {
    vec![
        RosterPick {
            character_id: user_card,
            is_user: true,
        },
        RosterPick {
            character_id: ai_card,
            is_user: false,
        },
        RosterPick {
            character_id: jin_card,
            is_user: false,
        },
    ]
}

/// 测试夹具：三卡会话（开局包显式指定历法，验证分叉继承会话行历法），
/// 返回 (storage, dir, source_session_id, [用户位, 艾莉位, 烬位] 实例 id)。
fn setup(tag: &str) -> (Storage, PathBuf, i64, [i64; 3]) {
    let (storage, dir) = temp_storage(tag);
    let user_card = storage
        .create_character(&NewCharacter {
            name: "旅人".into(),
            ..Default::default()
        })
        .unwrap()
        .id;
    let ai_card = storage
        .create_character(&NewCharacter {
            name: "艾莉".into(),
            ..Default::default()
        })
        .unwrap()
        .id;
    let jin_card = storage
        .create_character(&NewCharacter {
            name: "烬".into(),
            ..Default::default()
        })
        .unwrap()
        .id;
    // 世界卡携历法预设（回声历）：实例化后历法唯一归属在世界实例，分叉线应
    // 继承同一快照值。
    let world = storage
        .create_world(&crate::domain::models::NewWorld {
            name: "回声港".into(),
            worldbook: String::new(),
            calendar_config: Some(
                serde_json::to_string(&crate::domain::fiction_time::CalendarConfig {
                    name: Some("回声历".into()),
                    months: vec!["霜月".into()],
                    days_per_month: 30,
                    day_names: vec!["晨露日".into()],
                    festivals: Default::default(),
                })
                .unwrap(),
            ),
        })
        .unwrap();
    let sid = storage
        .create_session(&NewSession {
            world_id: world.id,
            roster: roster(user_card, ai_card, jin_card),
            title: "原本".into(),
            opening: Some(OpeningSeed {
                fic_day: None,
                fic_part: None,
                location: None,
                time_note: None,
            }),
            default_render_style: "type".to_string(),
        })
        .unwrap()
        .id;
    let instances = storage.list_instances(sid).unwrap();
    let pick = |name: &str| instances.iter().find(|i| i.name == name).unwrap().id;
    (storage, dir, sid, [pick("旅人"), pick("艾莉"), pick("烬")])
}

/// 结算一拍（FR-011 边界快照模型）：把 `(after, upto]` 消息挂到被收束场（带收束
/// 摘要 / recap 回写），开新场 header（fic_day = day，在场名单逐场轮换压映射）。
/// 摘要 / recap 文案在此派生（边界快照模型：S_N 的摘要在第 N+1 拍回写；
/// recap 仅第 3 场〔day == 4 拍收束〕加厚，压 recap 字段拷贝）。
fn settle(
    storage: &Storage,
    sid: i64,
    close: i64,
    after: i64,
    upto: i64,
    day: i64,
    present: Vec<i64>,
) -> Scene {
    let close_summary = Some(format!("第{day}天开场时收束前场"));
    let close_recap = (day == 4).then(|| "灯火次第熄灭，只有钟楼还亮着。".to_string());
    storage
        .commit_settlement(&SettlementWrite {
            scene: NewScene {
                session_id: sid,
                location: Some(format!("第 {day} 天的地点")),
                time_note: None,
                fic_day: Some(day),
                fic_part: Some("夜".into()),
                date_label: None,
                summary: None,
                recap: None,
                present,
            },
            close_scene_id: Some(close),
            close_summary,
            close_recap,
            attach: Some(AttachRange {
                scene_id: close,
                after_message_id: after,
                upto_message_id: upto,
            }),
            state_upserts: vec![],
            state_clears: vec![],
        })
        .unwrap()
}

fn msg(
    storage: &Storage,
    sid: i64,
    role: MessageRole,
    content: &str,
    instance: Option<i64>,
) -> i64 {
    let mut new = NewMessage::new(sid, role, content);
    new.instance_id = instance;
    storage.insert_message(&new).unwrap().id
}

fn state(instance: i64, key: &str, value: &str, source: Option<i64>) -> NewCharacterState {
    NewCharacterState {
        instance_id: instance,
        scope: CharacterStateScope::State,
        key: key.into(),
        value: value.into(),
        expiry: None,
        source_scene: source,
    }
}

/// 原线行数账（分叉前后对照）：（场景全部行, 在世消息, 实例全部行, 状态全部行）。
fn stats(conn: &Connection, sid: i64) -> (i64, i64, i64, i64) {
    let count = |sql: &str| -> i64 { conn.query_row(sql, params![sid], |r| r.get(0)).unwrap() };
    (
        count("SELECT COUNT(*) FROM scenes WHERE session_id = ?1"),
        count("SELECT COUNT(*) FROM messages WHERE session_id = ?1 AND deleted_at IS NULL"),
        count("SELECT COUNT(*) FROM character_instances WHERE session_id = ?1"),
        count(
            "SELECT COUNT(*) FROM character_state cs \
             JOIN character_instances ci ON ci.id = cs.instance_id WHERE ci.session_id = ?1",
        ),
    )
}

fn kv<'a>(states: &'a [CharacterState], instance: i64, key: &str) -> Option<&'a str> {
    states
        .iter()
        .find(|s| s.instance_id == instance && s.key == key)
        .map(|s| s.value.as_str())
}

/// 验收主线：第 7 天分叉回第 3 天——新线状态含 A（第 3 场所设）不含 B（第 7 场才设）、
/// 虚时从锚点重走、原线逐表零影响、llm_calls 不随线、三级映射全部落新 id、
/// 新线从锚点下一号长场。
#[test]
fn fork_at_day3_copies_world_and_leaves_source_untouched() {
    let (storage, dir, sid, [user_i, ai_i, jin_i]) = setup("fork_main");
    let source_scene0 = storage.latest_scene(sid).unwrap().unwrap(); // 开场锚行 idx 0（第 1 天）

    // 手工 NULL-source 状态：自会话之始存在（as_of 任何锚点可还原，覆盖 NULL 映射路径）。
    storage
        .upsert_character_state(&state(user_i, "笔墨", "备好", None))
        .unwrap();

    // 铺 7 个场景（idx 1..7，fic_day 1..7）+ 逐场两消息；assistant 说话人在艾莉 / 烬
    // 间轮换；在场名单逐场轮换。锚定叙事：第 3 场（idx 3）= 第 3 天。
    let mut scenes = vec![source_scene0];
    let mut answers = Vec::new();
    let mut last = 0i64;
    let presents: &[&[usize]] = &[
        &[0],       // 第 1 场
        &[0, 1],    // 第 2 场
        &[1, 2],    // 第 3 场
        &[2],       // 第 4 场
        &[0, 2],    // 第 5 场
        &[1],       // 第 6 场
        &[0, 1, 2], // 第 7 场
    ];
    let inst = |k: usize| [user_i, ai_i, jin_i][k];
    for day in 1..=7i64 {
        let _u = msg(
            &storage,
            sid,
            MessageRole::User,
            &format!("第{day}天问"),
            Some(user_i),
        );
        let speaker = if day % 2 == 1 { ai_i } else { jin_i };
        let a = msg(
            &storage,
            sid,
            MessageRole::Assistant,
            &format!("第{day}天答"),
            Some(speaker),
        );
        answers.push(a);
        let close = scenes.last().unwrap();
        let present: Vec<i64> = presents[(day - 1) as usize]
            .iter()
            .map(|k| inst(*k))
            .collect();
        scenes.push(settle(&storage, sid, close.id, last, a, day, present));
        last = a;
    }
    // 第 3 场所设状态 A（导演约定记在被收束场、自下一场起生效），双实例双 key 压映射；
    // 第 7 场才设状态 B（直接经 upsert 原语，与结算清算支路同一落库路径）。
    storage
        .upsert_character_state(&state(ai_i, "情绪", "警觉", Some(scenes[3].id)))
        .unwrap();
    storage
        .upsert_character_state(&state(jin_i, "持有", "铜钥匙", Some(scenes[3].id)))
        .unwrap();
    storage
        .upsert_character_state(&state(ai_i, "情绪", "释然", Some(scenes[7].id)))
        .unwrap();
    // 锚点之后的进行中消息（未归属）+ 锚点场内一条墓碑消息（第 4 天答被整条替换的
    // 旧版：软删行不入新线）。
    msg(
        &storage,
        sid,
        MessageRole::User,
        "第8天进行中",
        Some(user_i),
    );
    let tomb = answers[3];
    storage.soft_delete_message(tomb).unwrap();

    // 轨迹属原线：分叉前源线已有两条。
    let trace = |kind| NewLlmCall {
        session_id: Some(sid),
        kind,
        model: "m".into(),
        started_at: 1,
        duration_ms: 1,
        prompt_json: "[]".into(),
        response_text: None,
        reasoning_text: None,
        tool_calls_json: None,
        prompt_tokens: None,
        completion_tokens: None,
        status: LlmCallStatus::Ok,
        error_text: None,
    };
    storage
        .insert_llm_call(&trace(LlmCallKind::Dialogue))
        .unwrap();
    storage
        .insert_llm_call(&trace(LlmCallKind::Explorer))
        .unwrap();

    // 原线分叉前快照（验收「原线零影响」的对照基准）。
    let before_session = storage.get_session(sid).unwrap();
    let before = {
        let conn = Connection::open(dir.join("test.db")).unwrap();
        stats(&conn, sid)
    };

    // ---- 分叉：在第 3 场（idx 3）分叉 ----
    let forked: Session = storage.fork_session(sid, 3, "回声线").unwrap();

    // 新会话元信息：标题透传调用方、分叉锚两列落值、世界实例（含历法）= 源快照
    // 值拷贝（历法唯一归属 0017 起随世界实例走）。
    assert_eq!(forked.title, "回声线");
    assert_eq!(forked.forked_from_session_id, Some(sid));
    assert_eq!(forked.fork_anchor_scene_idx, Some(3));
    let source_world = storage.world_instance_by_session(sid).unwrap().unwrap();
    let forked_world = storage
        .world_instance_by_session(forked.id)
        .unwrap()
        .expect("分叉线继承世界实例");
    assert_eq!(
        (forked_world.world_id, forked_world.calendar_config.clone()),
        (source_world.world_id, source_world.calendar_config.clone()),
        "世界与历法快照随线值拷贝"
    );
    let stored_forked = storage.get_session(forked.id).unwrap();
    assert_eq!(
        (
            stored_forked.forked_from_session_id,
            stored_forked.fork_anchor_scene_idx
        ),
        (Some(sid), Some(3)),
        "分叉锚落库读回一致"
    );

    // 场景：idx 保留原号 0..3；「第 3 天」的锚场随线（虚时从第 3 天重走的账本基础）。
    let new_scenes = storage.list_scenes(forked.id).unwrap();
    let idxes: Vec<i64> = new_scenes.iter().map(|s| s.idx).collect();
    assert_eq!(
        idxes,
        vec![0, 1, 2, 3],
        "新线 = 锚点前全部场景（含锚点），原号保留"
    );
    let new_s3 = &new_scenes[3];
    assert_eq!(new_s3.fic_day, Some(3), "虚时账本从锚点场原值重走");
    assert_eq!(
        new_s3.summary.as_deref(),
        Some("第4天开场时收束前场"),
        "摘要随值拷贝"
    );
    assert_eq!(
        new_s3.recap.as_deref(),
        Some("灯火次第熄灭，只有钟楼还亮着。"),
        "recap（第 3 场收束加厚）随值拷贝"
    );
    assert_eq!(new_s3.location.as_deref(), Some("第 3 天的地点"));
    // 虚时逐场一致（深拷贝不是抽样近似）：新线各场与源线同号场逐字段相等。
    for (old, new) in scenes.iter().take(4).zip(new_scenes.iter()) {
        assert_eq!(old.fic_day, new.fic_day, "idx {} 虚时一致", new.idx);
        assert_eq!(old.fic_part, new.fic_part);
        assert_eq!(old.date_label, new.date_label);
    }

    // 三级映射之一（实例）：新线在场名单全部落新实例 id；按名单轮换逐场核对。
    let new_instances = storage.list_instances(forked.id).unwrap();
    let new_pick = |name: &str| new_instances.iter().find(|i| i.name == name).unwrap().id;
    let (nu, nai, njin) = (new_pick("旅人"), new_pick("艾莉"), new_pick("烬"));
    let present_of = |idx: i64| -> Vec<i64> {
        let conn = Connection::open(dir.join("test.db")).unwrap();
        let raw: String = conn
            .query_row(
                "SELECT present FROM scenes WHERE session_id = ?1 AND idx = ?2",
                params![forked.id, idx],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    };
    assert_eq!(
        present_of(0),
        vec![nu, nai, njin],
        "锚行名单 = 全员新实例 id"
    );
    assert_eq!(present_of(1), vec![nu]);
    assert_eq!(present_of(2), vec![nu, nai]);
    assert_eq!(
        present_of(3),
        vec![nai, njin],
        "present 数组逐 id 过映射（非整表复制）"
    );

    // 三级映射之二 / 之三（消息的 instance_id 与 scene_id）：在世消息 = 截至锚场的
    // 已归属在世消息；锚点后进行中（未归属）与墓碑消息都不入新线。
    let new_messages = storage.list_messages(forked.id).unwrap();
    let contents: Vec<&str> = new_messages.iter().map(|m| m.content.as_str()).collect();
    assert_eq!(
        contents,
        vec![
            "第1天问",
            "第1天答",
            "第2天问",
            "第2天答",
            "第3天问",
            "第3天答",
            "第4天问"
        ],
        "截至锚场时刻的在世消息随线；墓碑（第4天答旧版）与未归属（第8天进行中）不拷"
    );
    assert_eq!(
        new_messages[1].instance_id,
        Some(nai),
        "说话人实例映射到新线艾莉"
    );
    assert_eq!(
        new_messages[3].instance_id,
        Some(njin),
        "说话人实例映射到新线烬"
    );
    let new_scene_by_idx = |idx: i64| new_scenes.iter().find(|s| s.idx == idx).unwrap().id;
    assert_eq!(
        new_messages.last().unwrap().scene_id,
        Some(new_scene_by_idx(3)),
        "锚场消息的归属场映射到新线场景行"
    );
    assert_eq!(new_messages[0].scene_id, Some(new_scene_by_idx(0)));
    {
        // 全量 JOIN 断言：新线不存在任何指向源会话行 / 源实例的悬空引用。
        let conn = Connection::open(dir.join("test.db")).unwrap();
        let dangling: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages m \
                 LEFT JOIN character_instances ci ON ci.id = m.instance_id \
                 LEFT JOIN scenes sc ON sc.id = m.scene_id \
                 WHERE m.session_id = ?1 \
                   AND ((m.instance_id IS NOT NULL \
                         AND (ci.id IS NULL OR ci.session_id != m.session_id)) \
                     OR (m.scene_id IS NOT NULL \
                         AND (sc.id IS NULL OR sc.session_id != m.session_id)))",
                params![forked.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dangling, 0, "新线消息引用必须全部落在自己会话内");
        let bad_present: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM scenes s WHERE s.session_id = ?1 \
                 AND EXISTS (SELECT 1 FROM json_each(s.present) je \
                             WHERE je.value NOT IN \
                                 (SELECT id FROM character_instances WHERE session_id = ?1))",
                params![forked.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(bad_present, 0, "新线在场名单必须全部是本会话实例");
    }

    // 状态：新线 = 第 3 天当时值——含 A（第 3 场所设）与自始的笔墨，不含 B（第 7 场）。
    let new_states = storage.list_character_states(forked.id).unwrap();
    assert_eq!(
        kv(&new_states, nai, "情绪"),
        Some("警觉"),
        "新线情绪 = 锚点时点值 A"
    );
    assert_eq!(kv(&new_states, njin, "持有"), Some("铜钥匙"));
    assert_eq!(
        kv(&new_states, nu, "笔墨"),
        Some("备好"),
        "NULL-source 自始状态随线"
    );
    assert_eq!(new_states.len(), 3, "B（释然）不得入新线");
    let mood = new_states.iter().find(|s| s.key == "情绪").unwrap();
    assert_eq!(
        mood.source_scene,
        Some(new_scene_by_idx(3)),
        "状态 source_scene 必须映射到新线场景行（否则新线未来 as_of 跨会话读错号）"
    );
    // 新线上的 as_of 查询用映射后的锚正常工作：锚点之前只剩 NULL-source 的笔墨。
    let as_of_new = storage
        .list_character_states_as_of_scene(forked.id, 1)
        .unwrap();
    assert_eq!(as_of_new.len(), 1);
    assert_eq!(as_of_new[0].key, "笔墨");

    // 轨迹各自独立：新线零轨迹，源线原样两条。
    assert!(
        storage.list_llm_calls(forked.id, 10).unwrap().is_empty(),
        "llm_calls 不拷贝"
    );
    assert_eq!(storage.list_llm_calls(sid, 10).unwrap().len(), 2);

    // 原线零影响：逐表行数 + 内容抽样。
    let source_scenes = storage.list_scenes(sid).unwrap();
    assert_eq!(source_scenes.len(), 8, "源线场景（锚行 + 7 场）一条不动");
    assert_eq!(source_scenes[7].fic_day, Some(7));
    let source_states = storage.list_character_states(sid).unwrap();
    assert_eq!(
        kv(&source_states, ai_i, "情绪"),
        Some("释然"),
        "源线当下生效行仍是 B（新线回退不影响原线演进）"
    );
    assert_eq!(
        storage.list_messages(sid).unwrap().len(),
        14,
        "源线在世消息数不变（13 条已归属 + 1 条进行中）"
    );
    {
        let conn = Connection::open(dir.join("test.db")).unwrap();
        let after = stats(&conn, sid);
        assert_eq!(
            after, before,
            "源线逐表行数分叉前后一致：{before:?} → {after:?}"
        );
        let still_tombstoned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE id = ?1 AND deleted_at IS NOT NULL",
                params![tomb],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(still_tombstoned, 1, "源线墓碑行原样保留");
    }
    let after_session = storage.get_session(sid).unwrap();
    assert_eq!(
        after_session.updated_at, before_session.updated_at,
        "分叉不触碰源会话时间戳"
    );
    assert_eq!(
        after_session.forked_from_session_id, None,
        "源会话不是分叉线"
    );
    // id 空间：新线行与源线行零共享（拷贝不是引用）。
    for new in &new_scenes {
        assert!(
            !scenes.iter().any(|old| old.id == new.id),
            "场景行必须是新行"
        );
    }
    for ni in &new_instances {
        assert!(![user_i, ai_i, jin_i].contains(&ni.id), "实例行必须是新行");
    }

    // 新线从锚点下一号长自己的场次（idx 接锚点原号 +1）。
    let grown = storage
        .insert_scene(&NewScene {
            session_id: forked.id,
            location: Some("新线第 4 场".into()),
            time_note: None,
            fic_day: Some(4),
            fic_part: Some("夜".into()),
            date_label: None,
            summary: None,
            recap: None,
            present: vec![nu],
        })
        .unwrap();
    assert_eq!(grown.idx, 4, "新线自有场次 = 锚点 idx + 1（各线独立计数）");
    assert_eq!(
        storage.list_scenes(sid).unwrap().len(),
        8,
        "新线长场不影响源线"
    );

    drop(storage);
    cleanup(&dir);
}

/// 边界：锚点 = 第 1 场（开场锚行）——未归属消息（锚点即最新在世场）随线拷贝；
/// 锚点号不存在 → NotFound 零副作用；源会话已软删 → NotFound。
#[test]
fn fork_edges_anchor_zero_missing_and_deleted() {
    let (storage, dir, sid, [user_i, ai_i, _jin_i]) = setup("fork_edges");
    let base = storage.list_sessions().unwrap().len();

    // 无结算：锚行（idx 0）+ 两条未归属消息（进行中）+ 一条 NULL-source 手工状态。
    msg(&storage, sid, MessageRole::User, "开局一问", Some(user_i));
    msg(
        &storage,
        sid,
        MessageRole::Assistant,
        "开局一答",
        Some(ai_i),
    );
    storage
        .upsert_character_state(&state(user_i, "斗篷", "湿透", None))
        .unwrap();

    // 锚点 = 第 1 场（idx 0）：新线只含锚行；未归属消息属于进行中的锚场（锚点即
    // 最新在世场）→ 随线。
    let forked = storage.fork_session(sid, 0, "起点线").unwrap();
    let new_scenes = storage.list_scenes(forked.id).unwrap();
    assert_eq!(new_scenes.len(), 1, "锚点前（含）只有开场锚行");
    assert_eq!(new_scenes[0].idx, 0);
    let new_messages = storage.list_messages(forked.id).unwrap();
    let contents: Vec<&str> = new_messages.iter().map(|m| m.content.as_str()).collect();
    assert_eq!(
        contents,
        vec!["开局一问", "开局一答"],
        "未归属消息随锚点=最新场拷贝"
    );
    let new_states = storage.list_character_states(forked.id).unwrap();
    assert_eq!(new_states.len(), 1);
    assert_eq!(new_states[0].key, "斗篷");
    assert_eq!(new_states[0].source_scene, None, "NULL-source 保持 NULL");
    assert_eq!(forked.fork_anchor_scene_idx, Some(0));

    // 锚点号不存在 → NotFound，且零副作用（不落半条新线）。
    let err = storage.fork_session(sid, 99, "幻影线").unwrap_err();
    assert!(
        matches!(err, StorageError::NotFound { .. }),
        "实际：{err:?}"
    );
    assert_eq!(
        storage.list_sessions().unwrap().len(),
        base + 1,
        "失败分叉不落新会话"
    );

    // 源会话软删 → NotFound（软删等价不可见，ADR-009）；列表随后只剩分叉线。
    storage.soft_delete_session(sid).unwrap();
    let err = storage.fork_session(sid, 0, "亡者线").unwrap_err();
    assert!(
        matches!(err, StorageError::NotFound { .. }),
        "实际：{err:?}"
    );
    assert_eq!(
        storage.list_sessions().unwrap().len(),
        base,
        "软删源会话后列表只剩分叉线"
    );

    drop(storage);
    cleanup(&dir);
}
