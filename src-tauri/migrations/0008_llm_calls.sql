-- 0008_llm_calls.sql — LLM 调用轨迹（2026-09-11 透明化功能）。
-- 每一次 LLM HTTP 请求落一条完整轨迹（对话流式 / 探索器工具循环每轮 / 结算裁决
-- 含重试每次 / 历法起草），供「LLM 调用轨迹」面板查询与回放。
--
-- 日志性质旁路数据：**不做软删除**——无 deleted_at 列、无软删 / 恢复端口，
-- 全库软删除约定（ADR-009）在此不适用；轨迹保留全量，清理交由后续维护路径。
-- session_id 可空：历法起草（draft）调用发生在会话之外（None）。

CREATE TABLE llm_calls (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        INTEGER REFERENCES sessions (id),   -- 可空：draft 起草调用无会话
    kind              TEXT    NOT NULL CHECK (kind IN ('dialogue', 'explorer', 'director', 'draft')),
    model             TEXT    NOT NULL,                   -- 请求所用模型名
    started_at        INTEGER NOT NULL,                   -- 请求发起时刻（Unix 毫秒）
    duration_ms       INTEGER NOT NULL,                   -- 本次 HTTP 请求墙钟耗时（毫秒）
    prompt_json       TEXT    NOT NULL,                   -- 请求消息数组 JSON（[{role, content, …}]）
    response_text     TEXT,                               -- 响应正文（失败 / 取消为已收到的半条）
    reasoning_text    TEXT,                               -- 思考内容（字段型 reasoning / <think> 拆分）
    tool_calls_json   TEXT,                               -- 本轮模型发起的工具调用 [{name, arguments}] JSON
    prompt_tokens     INTEGER,                            -- usage 可空：网关未回报即 NULL（有则记）
    completion_tokens INTEGER,                            -- 同上
    status            TEXT    NOT NULL CHECK (status IN ('ok', 'error')),
    error_text        TEXT                                -- status = error 时的人类可读原因
);
CREATE INDEX idx_llm_calls_session ON llm_calls (session_id, id);
