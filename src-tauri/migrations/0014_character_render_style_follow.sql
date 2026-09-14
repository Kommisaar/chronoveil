-- 0014 角色动画风格跟随全局（2026-09-14 用户定稿）：characters.render_style
--      改为可空——NULL = 跟随全局设置（config.json 新键 render_style，默认
--      'type'），存量值原样保留（语义即「自定义」）；新建卡默认 NULL（跟随）。
--      与演出参数三列（0013，NULL = 跟随全局）同一语义家族。
--      会话实例快照（D1）在建会话时解析为「卡 NULL → 全局」的具体值落库，
--      character_instances.render_style 保持 NOT NULL——实例冻结具体风格，
--      改全局不回写旧会话（D1「卡死人活」）。
-- 实现说明（SQLite 限制）：无法 ALTER 去除 NOT NULL，须整表重建。采用
-- 「建 characters_new（render_style 可空）→ 逐行平移 → DROP 原表 → RENAME」
-- 顺序：DROP 父表时 character_instances.character_id 的外键引用在迁移器
-- FK=OFF 包络内不触发强制/级联，RENAME 回原名后子表按表名引用的 FK 重新
-- 指向新表（迁移 0009 同款机制）；主键 id 平移不断号，AUTOINCREMENT 序列
-- 由显式 id 插入自动续接。
CREATE TABLE characters_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    avatar       TEXT,                               -- 可空：data URL 或 ~/.chronoveil 相对路径
    persona      TEXT    NOT NULL DEFAULT '',        -- 人设系统提示词
    render_style TEXT,                               -- 18 种风格之一（FR-005）；NULL = 跟随全局设置
    model_config TEXT,                               -- JSON 角色专属模型覆写，可空
    accent_color TEXT,                               -- 强调色 #RRGGBB，可空：None = 跟随海报派生色
    gender       TEXT,                               -- 可选展示元数据，自由文本
    age          TEXT,                               -- 可选展示元数据，自由文本
    anim_duration_ms INTEGER,                         -- 动效时长覆写（0013），NULL = 跟随全局
    anim_rhythm_ms   INTEGER,                         -- 打字节奏覆写（0013），NULL = 跟随全局
    anim_punct_pause INTEGER,                         -- 标点微停覆写（0013），NULL = 跟随全局
    voice_config TEXT,                               -- TTS 预留缝，恒 NULL（CON-003）
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER                             -- 软删除墓碑（ADR-009）
);
INSERT INTO characters_new (
    id, name, avatar, persona, render_style, model_config, accent_color,
    gender, age, anim_duration_ms, anim_rhythm_ms, anim_punct_pause,
    voice_config, created_at, updated_at, deleted_at
)
SELECT
    id, name, avatar, persona, render_style, model_config, accent_color,
    gender, age, anim_duration_ms, anim_rhythm_ms, anim_punct_pause,
    voice_config, created_at, updated_at, deleted_at
FROM characters;
DROP TABLE characters;
ALTER TABLE characters_new RENAME TO characters;
