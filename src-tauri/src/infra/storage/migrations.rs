//! 手写顺序迁移（CMP-003）：`schema_version` 表记录已应用版本；同一库重复启动幂等。
//! 迁移 SQL 放 `src-tauri/migrations/`，按版本号顺序执行，每个迁移单事务；
//! 待应用迁移的整批执行套 FK=OFF 包络（原因见 run 内注释：PRAGMA 事务内 no-op，
//! 包络必须落在事务边界之外）。

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
    // 多角色群像地基（方案《多角色与时间线-最终》§2 第 1 步，D1/D2/D8）：
    // character_instances 新表 + sessions/messages/character_state 三处换挂
    // （sessions DROP character_id；messages 死列换 instance_id；状态挂 instance_id）
    (9, include_str!("../../../migrations/0009_character_instances.sql")),
    // 状态历史化（方案《多角色与时间线-最终》§2 第 2 步，方案 A append-only）：
    // character_state 扩 superseded_at（取代链）+ 唯一索引收窄为只约束当前生效行
    // （deleted_at IS NULL AND superseded_at IS NULL）
    (10, include_str!("../../../migrations/0010_character_state_history.sql")),
    // 时间线分叉地基（方案《多角色与时间线-最终》§2 第 3 步）：sessions 扩可空
    // 分叉元信息两列（forked_from_session_id 不设外键、fork_anchor_scene_idx 记锚场景号）
    (11, include_str!("../../../migrations/0011_session_fork.sql")),
    // 角色卡历法裁撤（2026-09-13 产品裁剪，先例同 0004 丢 greeting）：历法不属
    // 角色卡，sessions.calendar_config 是会话历法唯一归属
    (12, include_str!("../../../migrations/0012_drop_character_calendar.sql")),
    // 角色卡演出参数（2026-09-13 用户定稿）：动效时长 / 打字节奏 / 标点微停
    // 三列可空（NULL = 跟随全局设置），取值范围在命令层校验
    (13, include_str!("../../../migrations/0013_add_character_anim_params.sql")),
    // 角色动画风格跟随全局（2026-09-14 用户定稿）：characters.render_style
    // 可空（NULL = 跟随全局 config.json render_style），整表重建去 NOT NULL；
    // 实例快照在建会话时解析为具体值，instances.render_style 保持 NOT NULL
    (14, include_str!("../../../migrations/0014_character_render_style_follow.sql")),
    // 模型覆写扁平化（2026-09-15 数据模型统一）：model_config JSON 串列拆为
    // model_provider_id / model_name / model_temperature 三列（NULL = 跟随全局，
    // 与 0013 演出参数同族），顺带删除恒 NULL 死列 voice_config
    (15, include_str!("../../../migrations/0015_flatten_model_override.sql")),
    // 角色称号集合（2026-09-15）：titles 单列 JSON 字符串数组（真集合形态，
    // 与 scenes.present 同族；写侧恒落 "[]"，读侧 NULL 视作空数组）
    (16, include_str!("../../../migrations/0016_character_titles.sql")),
    // 世界卡与其实例（2026-09-15 世界卡定稿）：worlds 新表 + world_instances 新表
    // （恰一，partial unique）+ sessions 裁撤 calendar_config（历法唯一归属移至
    // 世界实例——时间规则是世界的属性，0012 裁撤角色卡历法后的正确归宿）
    (17, include_str!("../../../migrations/0017_world_cards.sql")),
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
    // 幂等重入零副作用：应用每次启动都会走到这里，没有待应用迁移时不碰 PRAGMA、
    // 也不做全库校验（foreign_key_check 是为迁移批兜底的，空批不需要）。
    if MIGRATIONS.iter().all(|(version, _)| *version <= current) {
        return Ok(());
    }
    // FK=OFF 包络（C11 加固）：多表重建类迁移（如 0009 的 RENAME + 建新表 + 搬运 +
    // DROP 序列）在 FK 开启的连接上执行时，过渡态的父表换挂或存量悬空引用会让搬运
    // INSERT ... SELECT 直接撞外键，迁移成败取决于「库里恰好没有违例数据」。SQLite
    // 语义：PRAGMA foreign_keys 在事务内设置是 no-op，因此关/开必须落在事务边界之外
    // ——先记录原值，逐迁移关闭执行（各自单事务，语义不变），跑完恢复。前提：进入
    // 本函数时连接上没有打开的事务（Storage::open 路径成立）。逐迁移重申 OFF 而非
    // 批前关一次的理由见 apply_pending。
    let fk_before: bool = conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
        .map(|v| v != 0)
        .map_err(|e| StorageError::Backend(format!("迁移前读取 foreign_keys 原值失败：{e}")))?;
    let outcome = apply_pending(conn, current);
    // 恢复先于报告：迁移半途失败也不能把连接留在 FK 关闭的脏状态。foreign_key_check
    // 的执行语义不受 foreign_keys 开关影响，放在恢复之后等价，且让恢复点唯一。
    let restored = conn
        .pragma_update(None, "foreign_keys", fk_before)
        .map_err(|e| {
            StorageError::Backend(format!(
                "迁移后恢复 foreign_keys 原值（{fk_before}）失败：{e}"
            ))
        });
    outcome?;
    restored?;
    // foreign_key_check 兜底：FK=OFF 期间搬运的数据不再受引擎即时校验，迁移批全部
    // 落地后全库扫一次。报出违例说明某个迁移自身的搬运逻辑有错（对未来多表重建类
    // 迁移的兜底检测），而非对违例数据的容忍；全库口径不区分违例是迁移引入还是
    // 迁移前就存在——无论哪种，数据都已损坏，迁移必须报错而不是静默通过。
    let violation = conn.query_row("PRAGMA foreign_key_check", [], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
        ))
    });
    match violation {
        Ok((table, rowid, parent, fkid)) => {
            return Err(StorageError::Backend(format!(
                "迁移后 foreign_key_check 发现违例：表 {table} 行 {rowid} \
                 违反对 {parent} 的外键约束 #{fkid}"
            )));
        }
        // 无违例行 = 校验通过（PRAGMA 查询空结果即零违例）。
        Err(rusqlite::Error::QueryReturnedNoRows) => {}
        Err(e) => {
            return Err(StorageError::Backend(format!(
                "迁移后执行 foreign_key_check 失败：{e}"
            )));
        }
    }
    Ok(())
}

/// 逐迁移执行待应用项（单迁移单事务：SQL 与版本记录同生共死，半写不可能发生）；
/// 失败错误带迁移版本号与步骤上下文，定位到具体迁移的具体一步。
///
/// 每个迁移开启事务前重申 `foreign_keys = OFF`，而不是批前关一次：迁移 0001 / 0002
/// 的 SQL 内嵌 `PRAGMA foreign_keys = ON`（`migrations/0001_init.sql:4` /
/// `0002_scenes_character_state.sql:10`），执行到它们会把连接翻回开启态，批内后续
/// 重建类迁移（0009 / 0010 的 DROP TABLE + RENAME 序列）就仍在 FK=ON 下跑，包络形同
/// 虚设。任务约束不改迁移文件内容，只能在执行器侧逐迁移兜住；0001 / 0002 自身批内
/// 的翻正无法外部干预，但两者均为建表 / 扩列 DDL、无跨表数据搬运，不构成暴露面。
/// PRAGMA 事务内 no-op，故重申必须落在事务开启之前。
fn apply_pending(conn: &Connection, current: i64) -> Result<(), StorageError> {
    for (version, sql) in MIGRATIONS {
        if *version <= current {
            continue;
        }
        let context = |step: &str, err: rusqlite::Error| {
            StorageError::Backend(format!("迁移 {version:04} {step}失败：{err}"))
        };
        conn.pragma_update(None, "foreign_keys", false)
            .map_err(|err| context("预关闭外键开关", err))?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|err| context("开启事务", err))?;
        tx.execute_batch(sql).map_err(|err| context("执行", err))?;
        tx.execute(
            "INSERT INTO schema_version (version, applied_at) VALUES (?1, ?2)",
            params![version, now()],
        )
        .map_err(|err| context("登记版本", err))?;
        tx.commit().map_err(|err| context("提交", err))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod fk_envelope_tests;
