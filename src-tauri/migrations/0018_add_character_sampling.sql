-- 0018 采样参数三列（2026-09-16）：characters 加 top_p / frequency_penalty /
--      presence_penalty 可空标量列，NULL = 跟随全局——与模型覆写三列（0015）
--      同族。取值范围不设 CHECK（跟随 0015 先例：校验在命令层 character_inputs，
--      值域常量与 infra/config.rs 的 TOP_P_MIN/MAX、PENALTY_MIN/MAX 互指；
--      TS 侧同值常量在 src/features/settings/preferences.ts）。仅全新库按序
--      建到最新（未发布应用无存量数据，2026-09-12 用户指令）。

ALTER TABLE characters ADD COLUMN model_top_p              REAL;
ALTER TABLE characters ADD COLUMN model_frequency_penalty  REAL;
ALTER TABLE characters ADD COLUMN model_presence_penalty   REAL;
