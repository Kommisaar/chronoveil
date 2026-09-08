-- 0002_scenes_character_state.sql — 5b 数据层地基（data_model rev 6「5b 增量」；FR-011 / FR-012 / FR-013，ADR-009）。
-- 内容：scenes / character_state 两新表；messages 扩可空 scene_id / character_id；
--       characters / sessions 扩可空 calendar_config（角色归属地 / 建会话快照，各自演进互不回写）。
--
-- 唯一约束与软删墓碑的冲突（data_model 开工决策点，TASK-011 验收 2）：
-- 采用 partial unique index —— UNIQUE(character_id, session_id, "key") 只约束在世行
-- （WHERE deleted_at IS NULL），软删后同键可重插为新行，墓碑行原样保留（清标即还原）。
-- 备选「约束含 deleted_at」会把墓碑时间戳卷进键语义、软删时还得改写键，弃用。

PRAGMA foreign_keys = ON;

CREATE TABLE scenes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions (id),
    idx        INTEGER NOT NULL,                 -- 同会话单调自增（墓碑行一并计序，全历史不重号）
    location   TEXT,                             -- 场景地点
    time_note  TEXT,                             -- 叙事层时间原文
    fic_day    INTEGER,                          -- 记账层：第几天（FR-013 唯一事实源的一半）
    fic_part   TEXT,                             -- 记账层：时段
    date_label TEXT,                             -- 虚拟日历命名缓存
    summary    TEXT,                             -- 本场一句话（远景压缩单元）
    present    TEXT,                             -- JSON：在场 character id 数组
    deleted_at INTEGER                           -- 软删除墓碑（ADR-009）
);
CREATE INDEX idx_scenes_session ON scenes (session_id, idx);

CREATE TABLE character_state (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters (id),
    session_id   INTEGER NOT NULL REFERENCES sessions (id),
    scope        TEXT    NOT NULL CHECK (scope IN ('state', 'relation')),  -- 状态 | 关系（FR-012 三层拆解）
    "key"        TEXT    NOT NULL,              -- 情绪 / 持有 / 约定 / 对某角的态度
    value        TEXT    NOT NULL,              -- 叙事语言，非数字
    expiry       TEXT,                          -- JSON：scene_end | event:xxx | manual | null（BR-002 过期三义）
    source_scene INTEGER,                       -- 来源场景
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER                        -- 软删除墓碑（ADR-009）
);
CREATE UNIQUE INDEX uq_character_state_live
    ON character_state (character_id, session_id, "key") WHERE deleted_at IS NULL;
CREATE INDEX idx_character_state_session ON character_state (session_id, id);

-- 消息归属与说话人（可空：非场景消息 / 用户消息为 NULL；读写接线随导演结算任务）
ALTER TABLE messages ADD COLUMN scene_id     INTEGER REFERENCES scenes (id);
ALTER TABLE messages ADD COLUMN character_id INTEGER REFERENCES characters (id);

-- 日历归属与继承（data_model「日历归属与继承」）：角色卡是日历归属地，NULL = 内置默认历；
-- 会话存建会话时从 Character 复制的快照，之后各自演进、互不回写。
ALTER TABLE characters ADD COLUMN calendar_config TEXT;
ALTER TABLE sessions ADD COLUMN calendar_config TEXT;
