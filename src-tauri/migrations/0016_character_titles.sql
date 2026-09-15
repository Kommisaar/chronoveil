-- 角色「称号」多值字段（2026-09-15）：诨名 / 头衔集合，如「布拉维坎的屠夫」。
-- 真集合 → 单列 JSON 字符串数组（形态规则，与 scenes.present 同族）：
--   写侧恒落 JSON 文本（空数组落 "[]" 不落 NULL），读侧 NULL 视作空数组。
-- 无存量义务（应用未发布）：新语义，无需回填；取值不做 CHECK（自由文本，
-- 与 gender/age 同定位，空项过滤属 UI 职责）。
ALTER TABLE characters ADD COLUMN titles TEXT;
