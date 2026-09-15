-- 0015 模型覆写扁平化（2026-09-15 数据模型统一）：characters.model_config JSON
--      串列拆为三个可空标量列，NULL = 跟随全局——与演出参数三列（0013）同族；
--      顺带删除恒 NULL 的死列 voice_config（TTS 预留缝 CON-003，零消费方，
--      读 DTO 不含它；TTS 真立项时再加列）。旧 JSON 内键为 camelCase
--      （providerId / model / temperature，前端手写直落的历史形态），迁移时
--      json_extract 平移到新列；baseUrl / apiKey 遗留键 UI 已不产出，随裁剪
--      丢弃；json_valid 守护坏行（坏 JSON 平移不了 → 新列落 NULL 即跟随全局）。
--      取值范围不设 CHECK（跟随 0013 先例：校验在命令层 character_inputs，
--      temperature 与 infra/config.rs 的 TEMPERATURE_MIN/MAX 互指）。
--      两旧列均无外键约束，DROP COLUMN 直接可用（0012 删 calendar_config 同款）。

ALTER TABLE characters ADD COLUMN model_provider_id TEXT;
ALTER TABLE characters ADD COLUMN model_name        TEXT;
ALTER TABLE characters ADD COLUMN model_temperature REAL;

UPDATE characters SET
    model_provider_id = json_extract(model_config, '$.providerId'),
    model_name        = json_extract(model_config, '$.model'),
    model_temperature = json_extract(model_config, '$.temperature')
WHERE model_config IS NOT NULL AND json_valid(model_config);

ALTER TABLE characters DROP COLUMN model_config;
ALTER TABLE characters DROP COLUMN voice_config;
