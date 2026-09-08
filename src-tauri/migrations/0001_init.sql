-- 0001_init.sql — v1 三张表（data_model rev 5，ADR-009 全库软删除）
-- 执行时机：阶段 2（db.rs 迁移器）；库文件 ~/.chronoveil/chronoveil.db（ADR-012）。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER NOT NULL PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

CREATE TABLE characters (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    persona      TEXT    NOT NULL DEFAULT '',        -- 人设系统提示词
    greeting     TEXT    NOT NULL DEFAULT '',        -- 开场白 markdown-lite
    render_style TEXT    NOT NULL DEFAULT 'typewriter', -- 18 种风格之一（FR-005）
    model_config TEXT,                               -- JSON 角色专属模型覆写，可空
    voice_config TEXT,                               -- TTS 预留缝，恒 NULL（CON-003）
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER                             -- 软删除墓碑（ADR-009）
);

CREATE TABLE sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters (id),
    title        TEXT    NOT NULL DEFAULT '',        -- 缺省取首条用户消息截断
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,                   -- 每条新消息刷新，排序用
    deleted_at   INTEGER
);
CREATE INDEX idx_sessions_updated ON sessions (updated_at DESC);

CREATE TABLE messages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     INTEGER NOT NULL REFERENCES sessions (id),
    role           TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
    content        TEXT    NOT NULL DEFAULT '',      -- 原始 markdown-lite，显示时才解析（BR-005）
    reasoning      TEXT,                             -- 思考内容，与正文分离落库（FR-003）
    think_ms       INTEGER,                          -- 思考可见时长
    tokens         INTEGER,                          -- 用量统计，可空
    created_at     INTEGER NOT NULL,
    interrupt_flag TEXT,                             -- 终态落库：中断标记（ADR-001）
    deleted_at     INTEGER                           -- 软删除墓碑（重新生成/重试替换）
);
CREATE INDEX idx_messages_session ON messages (session_id, id);
