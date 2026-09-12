-- 0010_character_state_history.sql — 状态历史化（方案《多角色与时间线-最终》§2 第 2 步，方案 A）。
-- character_state 从 upsert 覆盖改为 append-only 历史：
--   1) 扩可空列 superseded_at：非 NULL = 该行已被同键（instance_id, key）新行取代，
--      仅存历史链；NULL = 当前生效行。与 deleted_at 语义区分——superseded_at 是
--      「正常演进的取代」（值演进，第 3 步时间线分叉靠它还原任意时点状态），deleted_at
--      是「墓碑清除」（ADR-009，clear 语义）。两列独立：生效行判定 =
--      deleted_at IS NULL AND superseded_at IS NULL（与 infra/storage/character_states.rs
--      的查询过滤互为单一事实源的两处出现，改动须同步）。
--   2) 唯一索引重建：约束对象从「在世行」收窄为「当前生效行」——同键历史行不再互相
--      冲突，append 合法；墓碑 / 被取代行都不阻塞新行插入。
-- 旧行不回填（superseded_at 全 NULL = 全部仍生效）；应用未发布无存量数据
-- （AGENTS.md「数据迁移兼容性暂不适用」，D8），单迁移单事务由迁移器保证。

ALTER TABLE character_state ADD COLUMN superseded_at INTEGER;

DROP INDEX uq_character_state_live;
CREATE UNIQUE INDEX uq_character_state_live
    ON character_state (instance_id, "key")
    WHERE deleted_at IS NULL AND superseded_at IS NULL;
