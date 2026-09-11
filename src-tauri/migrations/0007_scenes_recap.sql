-- 0007：scenes 扩列 recap（Task-03 桥场加厚，2026-09-11）。
-- 可空：两三句加厚回顾，由导演结算对刚收束的上一场景产出（summary 保持一行，
-- recap 为细节更全的两三句）；远景编年史渲染两档——刚滑出窗口的桥场有 recap 时
-- 渲染加厚形态，更古老的场保持一行 summary。旧数据 / 新结算未产出时为 NULL，
-- 渲染回退单行。
ALTER TABLE scenes ADD COLUMN recap TEXT;
