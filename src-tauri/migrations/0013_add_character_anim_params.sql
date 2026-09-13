-- 0013 角色卡演出参数（2026-09-13 用户定稿）：输出动画的动效时长 / 打字节奏 /
--      标点微停升级为角色卡可覆写项——NULL = 跟随全局设置（config.json 的
--      anim_duration_base / rhythm_ms_per_char / punct_pause_enabled，其默认值
--      即模板值 450 / 45 / 开）。取值范围校验在命令层（character_inputs），
--      与 TS 引擎常量互指：src/engine/anims/index.ts DUR_MIN_MS/DUR_MAX_MS、
--      src/engine/index.ts RHYTHM_MIN_MS/RHYTHM_MAX_MS。
--      会话实例不快照这三项：聊天流按卡现值实时读取（改卡即生效），区别于
--      name/persona/render_style 的建会话快照（D1）。
ALTER TABLE characters ADD COLUMN anim_duration_ms INTEGER;
ALTER TABLE characters ADD COLUMN anim_rhythm_ms INTEGER;
ALTER TABLE characters ADD COLUMN anim_punct_pause INTEGER;
