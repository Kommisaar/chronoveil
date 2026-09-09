-- 0004：角色卡移除开场白（产品裁剪：角色不需要开场白，2026-09-09）。
-- 历史会话里已发出的开场消息本体存于 messages 表，不随本列删除受影响；
-- 此后新会话由用户先开口，prompt 装配不再注入 assistant 开场回合。
ALTER TABLE characters DROP COLUMN greeting;
