-- 0006：render_style 遗留默认值订正（Task-10，2026-09-11）。
-- 0001 起的默认串 'typewriter' 从未存在于引擎 18 风格表（打字机的 id 是 'type'），
-- 表外串在渲染端静默回落 fade。本迁移把存量行订正为真实风格 id；
-- 引擎端渲染逻辑无任何变化。
UPDATE characters SET render_style = 'type' WHERE render_style = 'typewriter';
