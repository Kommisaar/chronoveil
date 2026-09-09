-- 0003：characters 扩列 accent_color（编辑器「强调色」，2026-09-09）。
-- 可空：NULL = 跟随海报（前端按 id 派生的海报渐变主色做右栏渐变背景），
-- 存 #RRGGBB 十六进制串，由用户在角色卡编辑器色板中选定。
ALTER TABLE characters ADD COLUMN accent_color TEXT;
