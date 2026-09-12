-- 0011_session_fork.sql — 时间线分叉地基（方案《多角色与时间线-最终》§2 第 3 步）。
-- sessions 扩两列可空分叉元信息，记「本会话由哪个会话的哪个场景分叉而来」：
--   forked_from_session_id  逻辑上指向源会话 id。刻意**不设外键**：源会话软删
--     （ADR-009 墓碑，行仍在）不应阻断新线的存在与读写，外键在此只添约束不加正确性；
--   fork_anchor_scene_idx   分叉锚场景号（源会话内的 scenes.idx 口径，非 scenes.id）。
--     记号不记 id：idx 是叙事位置（跨会话可读的「从第 3 场分叉」），id 是库内行号，
--     元信息消费方（UI 回显 / 后续按锚续写）关心的是前者。
-- 两列只由分叉写入路径（infra/storage/session_fork.rs）落值，普通建会话为 NULL；
-- 旧行扩列为 NULL = 非分叉会话，无需回填。应用未发布无存量数据（AGENTS.md
-- 「数据迁移兼容性暂不适用」，D8），单迁移单事务由迁移器保证。

ALTER TABLE sessions ADD COLUMN forked_from_session_id INTEGER;
ALTER TABLE sessions ADD COLUMN fork_anchor_scene_idx INTEGER;
