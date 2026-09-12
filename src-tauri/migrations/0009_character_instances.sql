-- 0009_character_instances.sql — 多角色群像地基（方案《多角色与时间线-最终》§2 第 1 步；D1 / D2 / D8）。
-- 内容四件事：
--   1) sessions 重建：DROP character_id（D2 扮演位改由实例 is_user 表达；D8 无迁移负担）；
--      calendar_config 快照列保留（方案「开放问题：留 sessions 还是移会话级配置」实施裁量为维持现状）。
--   2) 新表 character_instances：会话内运行时角色身份 = 角色卡一次性快照（D1 卡死人活）；
--      character_id 可空 = 动态造人溯源（D6）；is_user 扮演位标记（D2，全会话恰好 1，应用层保证）。
--   3) messages 重建：DROP 死列 character_id（0002 起从未写入），挂 instance_id → 实例真值。
--   4) character_state 重建：character_id + session_id → instance_id NOT NULL（会话隶属由实例携带）；
--      唯一索引 (character_id, session_id, key) 简化为 (instance_id, key) WHERE deleted_at IS NULL（Q5/D9：
--      「对XX」关系约定走 key 文本，不加列）。
-- 附带语义升级（列不动）：scenes.present 的 JSON 数组内容从 character_id 改为 instance_id——
-- 场景行的在场名单自此是实例 id；旧行内容不回填（D8 预发布无存量数据，AGENTS.md
-- 「数据迁移兼容性暂不适用」条款，发布后失效）。
--
-- 实现说明（SQLite 限制）：三个被 DROP 的列都带 FOREIGN KEY 约束，ALTER TABLE DROP COLUMN
-- 拒绝执行；且 DROP 父表时对子表引用行的隐式 DELETE 会在事务内留下「粘性」延迟违例计数
-- （即使随后重建同名表补回数据，COMMIT 仍失败——defer_foreign_keys 救不了）。故采用
-- 「先建新父表 → 逐个重建子表把外键换挂到新父表 → 最后 DROP 旧父表（届时无人引用）」的
-- 顺序重建：每张旧表的 DROP 都是纯子表侧删除或零引用删除，全程无延迟违例，单事务原子。
-- 数据平移：sessions / messages / scenes 逐行原样搬运（含 id，主键序列不断号）；messages
-- 的 instance_id 对旧行为 NULL、character_state 旧行不搬运（instance_id NOT NULL 无法机械
-- 回填，D8 不迁移历史状态）。

-- 1) sessions 重建（去 character_id；先 RENAME 让位，子表外键将被自动改写指向旧名）
ALTER TABLE sessions RENAME TO sessions_v8;
CREATE TABLE sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT    NOT NULL DEFAULT '',        -- 缺省取首条用户消息截断
    calendar_config TEXT,                               -- 会话日历快照（FR-013），保留现状
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,                   -- 每条新消息刷新，排序用
    deleted_at      INTEGER                             -- 软删除墓碑（ADR-009）
);
INSERT INTO sessions (id, title, calendar_config, created_at, updated_at, deleted_at)
    SELECT id, title, calendar_config, created_at, updated_at, deleted_at FROM sessions_v8;
-- 旧索引随 RENAME 附在 sessions_v8 上并占用原名，先摘掉再给新表建同名索引
--（sessions_v8 本身将在步骤 6 落幕）。
DROP INDEX idx_sessions_updated;
CREATE INDEX idx_sessions_updated ON sessions (updated_at DESC);

-- 2) character_instances 新表（挂新 sessions）
CREATE TABLE character_instances (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER NOT NULL REFERENCES sessions (id),
    character_id INTEGER REFERENCES characters (id),    -- 模板溯源（D1）：选卡实例化记卡 id；NULL = 动态造人（D6）
    name         TEXT    NOT NULL,
    persona      TEXT    NOT NULL DEFAULT '',          -- D1 快照：值拷贝，改卡不回写
    render_style TEXT    NOT NULL DEFAULT 'type',
    is_user      INTEGER NOT NULL DEFAULT 0 CHECK (is_user IN (0, 1)),  -- D2 扮演位：全会话恰好 1（应用层保证）
    created_at   INTEGER NOT NULL,
    deleted_at   INTEGER                                -- 软删除墓碑（ADR-009）
);
CREATE INDEX idx_character_instances_session ON character_instances (session_id, id);

-- 3) messages 重建（去死列 character_id，挂 instance_id；挂新 sessions）
CREATE TABLE messages_new (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     INTEGER NOT NULL REFERENCES sessions (id),
    role           TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
    content        TEXT    NOT NULL DEFAULT '',        -- 原始 markdown-lite，显示时才解析（BR-005）
    reasoning      TEXT,                               -- 思考内容，与正文分离落库（FR-003）
    think_ms       INTEGER,                            -- 思考可见时长
    tokens         INTEGER,                            -- 用量统计，可空
    created_at     INTEGER NOT NULL,
    interrupt_flag TEXT,                               -- 终态落库：中断标记（ADR-001）
    deleted_at     INTEGER,                            -- 软删除墓碑（重新生成/重试替换）
    scene_id       INTEGER REFERENCES scenes (id),     -- 结算 AttachRange 回填的场景归属
    instance_id    INTEGER REFERENCES character_instances (id)  -- 说话人实例：user = 用户位，assistant = 生成位
);
INSERT INTO messages_new (id, session_id, role, content, reasoning, think_ms, tokens,
                          created_at, interrupt_flag, deleted_at, scene_id)
    SELECT id, session_id, role, content, reasoning, think_ms, tokens,
           created_at, interrupt_flag, deleted_at, scene_id FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX idx_messages_session ON messages (session_id, id);

-- 4) scenes 重建（形状不变；仅为把外键从旧父表换挂到新 sessions，present 内容语义升级见文件头）
CREATE TABLE scenes_new (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions (id),
    idx        INTEGER NOT NULL,                 -- 同会话单调自增（墓碑行一并计序，全历史不重号）
    location   TEXT,                             -- 场景地点
    time_note  TEXT,                             -- 叙事层时间原文
    fic_day    INTEGER,                          -- 记账层：第几天（FR-013 唯一事实源的一半）
    fic_part   TEXT,                             -- 记账层：时段
    date_label TEXT,                             -- 虚拟日历命名缓存
    summary    TEXT,                             -- 本场一句话（远景压缩单元）
    recap      TEXT,                             -- 桥场加厚回顾（Task-03）
    present    TEXT,                             -- JSON：在场实例 id 数组（0009 起语义为实例，原为 character id）
    deleted_at INTEGER                          -- 软删除墓碑（ADR-009）
);
INSERT INTO scenes_new (id, session_id, idx, location, time_note, fic_day, fic_part,
                        date_label, summary, recap, present, deleted_at)
    SELECT id, session_id, idx, location, time_note, fic_day, fic_part,
           date_label, summary, recap, present, deleted_at FROM scenes;
DROP TABLE scenes;
ALTER TABLE scenes_new RENAME TO scenes;
CREATE INDEX idx_scenes_session ON scenes (session_id, idx);

-- 4b) llm_calls 重建（形状不变；调用轨迹表同样引用 sessions——旧父表 RENAME 时其
-- 外键被自动改写指向 sessions_v8，须随子表换挂一并重建，否则 DROP 后引用悬空）。
CREATE TABLE llm_calls_new (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        INTEGER REFERENCES sessions (id),
    kind              TEXT    NOT NULL CHECK (kind IN ('dialogue', 'explorer', 'director', 'draft')),
    model             TEXT    NOT NULL,
    started_at        INTEGER NOT NULL,
    duration_ms       INTEGER NOT NULL,
    prompt_json       TEXT    NOT NULL,
    response_text     TEXT,
    reasoning_text    TEXT,
    tool_calls_json   TEXT,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    status            TEXT    NOT NULL CHECK (status IN ('ok', 'error')),
    error_text        TEXT
);
INSERT INTO llm_calls_new (id, session_id, kind, model, started_at, duration_ms,
                           prompt_json, response_text, reasoning_text, tool_calls_json,
                           prompt_tokens, completion_tokens, status, error_text)
    SELECT id, session_id, kind, model, started_at, duration_ms,
           prompt_json, response_text, reasoning_text, tool_calls_json,
           prompt_tokens, completion_tokens, status, error_text FROM llm_calls;
DROP TABLE llm_calls;
ALTER TABLE llm_calls_new RENAME TO llm_calls;
CREATE INDEX idx_llm_calls_session ON llm_calls (session_id, id);

-- 5) character_state 重建（character_id + session_id → instance_id NOT NULL；旧行不搬运，D8）
CREATE TABLE character_state_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id  INTEGER NOT NULL REFERENCES character_instances (id),
    scope        TEXT    NOT NULL CHECK (scope IN ('state', 'relation')),  -- 状态 | 关系（FR-012 三层拆解）
    "key"        TEXT    NOT NULL,              -- 情绪 / 持有 / 约定 / 对某实例的态度（Q5「对XX」走 key 文本）
    value        TEXT    NOT NULL,              -- 叙事语言，非数字
    expiry       TEXT,                          -- JSON：scene_end | event:xxx | manual | null（BR-002 过期三义）
    source_scene INTEGER,                       -- 来源场景
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER                        -- 软删除墓碑（ADR-009）
);
DROP TABLE character_state;
ALTER TABLE character_state_new RENAME TO character_state;
-- 唯一约束从 (character_id, session_id, key) 收敛为 (instance_id, key)（方案 §2.2 换挂），
-- 仍只约束在世行（partial unique index，迁移 0002 决策沿用）。
CREATE UNIQUE INDEX uq_character_state_live
    ON character_state (instance_id, "key") WHERE deleted_at IS NULL;
CREATE INDEX idx_character_state_instance ON character_state (instance_id, id);

-- 6) 收尾：子表全部换挂完毕，旧父表零引用，可安全 DROP（其索引随之消失，新索引上面已建）
DROP TABLE sessions_v8;
