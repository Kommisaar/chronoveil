-- 0005：角色卡扩列 gender / age（可选元数据，2026-09-09）。
-- 自由文本（角色扮演语境下年龄可以是「数百岁」等非数字表述）；
-- NULL = 未设置，不参与必填校验，仅作展示元数据。
ALTER TABLE characters ADD COLUMN gender TEXT;
ALTER TABLE characters ADD COLUMN age TEXT;
