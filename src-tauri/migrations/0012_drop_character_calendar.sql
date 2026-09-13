-- 0012 角色卡历法裁撤（2026-09-13 产品裁剪）：历法不属角色卡，会话历法唯一
--      归属为 sessions.calendar_config（迁移 0002 引入，开局包显式指定或内置
--      默认历）。丢弃 characters.calendar_config（同迁移 0004 丢 greeting 列
--      的产品裁剪先例）。
ALTER TABLE characters DROP COLUMN calendar_config;
