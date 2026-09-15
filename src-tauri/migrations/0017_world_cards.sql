-- 0017_world_cards.sql — 世界卡与其实例（2026-09-15 世界卡定稿）。
-- worlds          = 可复用世界观资产（舞台预设库）：世界观正文 + 历法预设，
--                   与角色卡平级；消费方式 = 建会话时快照实例化。
-- world_instances = 会话内世界（恰一）：name / worldbook / calendar_config 从卡
--                   一次性值拷贝（改卡不回写，D1 冻结语义同 character_instances）；
--                   world_id 记溯源（卡只软删不物删，外键恒有效）。
-- 历法收编（本迁移核心）：sessions.calendar_config 裁撤，会话历法唯一归属移至
--   world_instances.calendar_config——时间规则是世界的属性（0012 曾裁撤角色卡历法，
--   历法自此有正确归宿）；无存量义务（应用未发布，AGENTS.md「数据迁移兼容性暂不
--   适用」），旧会话历法不搬运，sessions 直接删列重建语义。
-- worldbook / calendar_config 不加 CHECK（自由文本 + JSON 由应用层 parse 兜底，
-- 与 characters 同口径）；ADR-009 全库软删除墓碑照例。

CREATE TABLE worlds (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    worldbook       TEXT    NOT NULL DEFAULT '',  -- 世界观正文（markdown-lite），空白 = 装配省略
    calendar_config TEXT,                         -- 历法预设存储 JSON（Rust serde 产 snake_case）；NULL = 内置默认历
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    deleted_at      INTEGER                       -- 软删除墓碑（ADR-009）
);

CREATE TABLE world_instances (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      INTEGER NOT NULL REFERENCES sessions (id),
    world_id        INTEGER NOT NULL REFERENCES worlds (id),  -- 溯源（卡软删不阻断实例，行仍在）
    name            TEXT    NOT NULL,
    worldbook       TEXT    NOT NULL DEFAULT '',  -- 快照：值拷贝，改卡不回写
    calendar_config TEXT,                         -- 历法快照（随卡拷贝，会话历法唯一归属）；NULL = 默认历
    created_at      INTEGER NOT NULL,
    deleted_at      INTEGER                       -- 软删除墓碑（ADR-009）
);
-- 恰一世界实例（每会话至多一行在世）：部分唯一索引做库级保证
--（与 uq_character_state_live 的 partial unique 口径一致）。
CREATE UNIQUE INDEX uq_world_instances_session
    ON world_instances (session_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_world_instances_session ON world_instances (session_id, id);

-- 历法易主：sessions 不再持历法（列无外键无索引，直接 DROP；SQLite ≥ 3.35）。
ALTER TABLE sessions DROP COLUMN calendar_config;
