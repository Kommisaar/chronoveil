//! 领域模型：Character / Session / Message（DOM-001，data_model v1 三表）+
//! Scene / CharacterState（data_model「5b 增量」，TASK-011 数据层地基）+
//! CharacterInstance（多角色群像地基，方案《多角色与时间线-最终》§2 第 1 步）。
//! 字段与库表一一对应；时间戳统一为 Unix 毫秒（created_at / updated_at / deleted_at）。

use serde::{Deserialize, Serialize};

use crate::domain::error::StorageError;

/// 消息角色（data_model：role CHECK IN ('user', 'assistant')）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Assistant,
}

impl MessageRole {
    pub fn as_str(self) -> &'static str {
        match self {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
        }
    }

    /// 从库值解析；未知值视为后端数据损坏。
    pub fn from_db(value: &str) -> Result<Self, StorageError> {
        match value {
            "user" => Ok(MessageRole::User),
            "assistant" => Ok(MessageRole::Assistant),
            other => Err(StorageError::Backend(format!("未知消息角色：{other}"))),
        }
    }
}

/// 角色卡（DOM-001）：一等实体——人设、出场方式、模型参数都挂在角色上。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Character {
    pub id: i64,
    pub name: String,
    /// 头像，可空：data URL 或 `~/.chronoveil` 下相对路径（data_model rev 6）。
    pub avatar: Option<String>,
    /// 人设系统提示词（底版，几乎不变）。
    pub persona: String,
    /// 性别（可选展示元数据，自由文本；None = 未设置）。
    pub gender: Option<String>,
    /// 年龄（可选展示元数据，自由文本，允许「数百岁」类表述；None = 未设置）。
    pub age: Option<String>,
    /// 出场动画风格（18 种之一，按角色存；2026-09-14 起可空——None = 跟随
    /// 全局设置 config.json 的 render_style）。
    pub render_style: Option<String>,
    /// 模型覆写三标量（2026-09-15 自 JSON 串列扁平化）：provider id / 模型名 /
    /// 采样温度，NULL = 跟随全局设置——与演出参数三列（anim_*）同族。
    /// provider 存在性与 temperature 范围（0–2）在命令层与解析层校验。
    pub model_provider_id: Option<String>,
    /// 覆写模型名（对齐 config.json `active_model` 的「模型名」词汇）；None = 跟随全局。
    pub model_name: Option<String>,
    /// 覆写采样温度（0–2）；None = 跟随全局。
    pub model_temperature: Option<f64>,
    /// 覆写核采样 top_p（0–1）；None = 跟随全局。2026-09-16 采样参数三列随
    /// 迁移 0018 加入，语义与 model_temperature 同族。
    pub model_top_p: Option<f64>,
    /// 覆写频率惩罚（−2–2）；None = 跟随全局。仅 OpenAI 兼容协议消费（wire 层取舍）。
    pub model_frequency_penalty: Option<f64>,
    /// 覆写存在惩罚（−2–2）；None = 跟随全局。消费域同 model_frequency_penalty。
    pub model_presence_penalty: Option<f64>,
    /// 强调色（编辑器右栏渐变背景等界面着色），#RRGGBB；None = 跟随海报派生色。
    pub accent_color: Option<String>,
    /// 演出参数覆写（2026-09-13 用户定稿）：动效时长 ms（150–1200，命令层
    /// 校验，与 TS 引擎 DUR_MIN_MS/DUR_MAX_MS 互指）；None = 跟随全局设置。
    pub anim_duration_ms: Option<i64>,
    /// 打字节奏 ms/字（10–160，与 TS 引擎 RHYTHM_MIN_MS/RHYTHM_MAX_MS 互指）；
    /// None = 跟随全局设置。
    pub anim_rhythm_ms: Option<i64>,
    /// 标点微停开关；None = 跟随全局设置。
    pub anim_punct_pause: Option<bool>,
    /// 称号集合（2026-09-15）：诨名 / 头衔，可多个（如「布拉维坎的屠夫」）。
    /// 库内单列 JSON 字符串数组存储（真集合形态，与 [`Scene::present`] 同族）；
    /// 写侧恒落 JSON 文本（空数组落 `"[]"` 不落 NULL），读侧 NULL 视作空数组。
    pub titles: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// 软删除墓碑（ADR-009）：None = 在世。
    pub deleted_at: Option<i64>,
}

/// 会话（FR-007）：成员由角色实例阵容构成（多角色群像，D1/D2——模板/实例分离后
/// 会话不再挂单一模板卡）；updated_at 每条新消息刷新，列表按其倒序。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub id: i64,
    /// 标题，缺省取首条用户消息截断。
    pub title: String,
    /// 分叉溯源（方案 §2 第 3 步「时间线分叉」）：非 NULL = 本会话是「从此分叉」
    /// 产生的新时间线，值 = 源会话 id。逻辑指向，不设外键——源会话软删不阻断新线
    /// （迁移 0011 注）。普通建会话为 NULL。
    pub forked_from_session_id: Option<i64>,
    /// 分叉锚场景号（源会话内 scenes.idx 口径）：新线从锚点场的下一时刻长自己的
    /// 时间线；与 [`Session::forked_from_session_id`] 成对出现（分叉写入路径同事务落值）。
    pub fork_anchor_scene_idx: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    /// 软删除墓碑（ADR-009）。
    pub deleted_at: Option<i64>,
}

/// 消息（data_model）：存原始 markdown-lite 文本，reasoning 与正文分离落库。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub id: i64,
    pub session_id: i64,
    pub role: MessageRole,
    /// 原始 markdown-lite 正文，显示时才解析（BR-005）。
    pub content: String,
    /// 思考内容，与正文分离（FR-003）。
    pub reasoning: Option<String>,
    /// 思考可见时长（毫秒）。
    pub think_ms: Option<i64>,
    /// 用量统计，可空。
    pub tokens: Option<i64>,
    pub created_at: i64,
    /// 终态落库中断标记（ADR-001：done / error / cancel；具体形态由生成服务决定，存储层透传）。
    pub interrupt_flag: Option<String>,
    /// 库内场景归属（FR-011）：结算 AttachRange 回填的 scenes.id；NULL = 进行中场 /
    /// 结算欠账（场景线已出现但结算未落库）/ 场景特性之前的旧数据。插入恒 NULL
    /// （[`NewMessage`] 不带此字段），结算（commit_settlement）是唯一写入者。
    pub scene_id: Option<i64>,
    /// 说话人实例（多角色群像，方案 §2.2）：user 消息 = 用户位实例，assistant =
    /// 产生它的生成位实例；NULL = 实例特性之前的旧数据。插入路径经 [`NewMessage`] 携带。
    pub instance_id: Option<i64>,
    /// 软删除墓碑（ADR-009：重新生成 / 断流重试替换）。
    pub deleted_at: Option<i64>,
}

/// 新建角色卡入参（FR-006）。Default 派生：全字段缺省即「跟随全局」语义。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NewCharacter {
    pub name: String,
    pub avatar: Option<String>,
    pub persona: String,
    pub gender: Option<String>,
    pub age: Option<String>,
    /// None = 跟随全局设置（2026-09-14；新建卡默认跟随，与演出参数三列同族）。
    pub render_style: Option<String>,
    /// 模型覆写三标量（2026-09-15 扁平化），语义同 [`Character`] 同名字段。
    pub model_provider_id: Option<String>,
    pub model_name: Option<String>,
    pub model_temperature: Option<f64>,
    /// 采样参数三列（2026-09-16），语义同 [`Character`] 同名字段。
    pub model_top_p: Option<f64>,
    pub model_frequency_penalty: Option<f64>,
    pub model_presence_penalty: Option<f64>,
    pub accent_color: Option<String>,
    pub anim_duration_ms: Option<i64>,
    pub anim_rhythm_ms: Option<i64>,
    pub anim_punct_pause: Option<bool>,
    /// 称号集合，语义同 [`Character::titles`]；Default 为空数组。
    pub titles: Vec<String>,
}

/// 更新角色卡入参：整卡覆盖（编辑表单全量提交）；avatar 传 None 即清除头像。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateCharacter {
    pub name: String,
    pub avatar: Option<String>,
    pub persona: String,
    pub gender: Option<String>,
    pub age: Option<String>,
    /// None = 跟随全局设置（2026-09-14）。
    pub render_style: Option<String>,
    /// 传 None 即清除覆写（跟随全局）；语义同 [`Character`] 同名字段。
    pub model_provider_id: Option<String>,
    pub model_name: Option<String>,
    pub model_temperature: Option<f64>,
    /// 采样参数三列（2026-09-16）；传 None 即清除覆写（跟随全局）。
    pub model_top_p: Option<f64>,
    pub model_frequency_penalty: Option<f64>,
    pub model_presence_penalty: Option<f64>,
    pub accent_color: Option<String>,
    /// 传 None 即清除覆写（跟随全局）。
    pub anim_duration_ms: Option<i64>,
    pub anim_rhythm_ms: Option<i64>,
    pub anim_punct_pause: Option<bool>,
    /// 称号集合，语义同 [`Character::titles`]；空数组即清除全部称号。
    pub titles: Vec<String>,
}

// ---------------------------------------------------------------------------
// 世界卡（2026-09-15 世界卡定稿）：与角色卡平级的世界观资产——舞台预设库
// ---------------------------------------------------------------------------

/// 世界卡：可复用的世界观设定（世界观正文 + 历法预设）。消费方式 = 建会话时
/// 实例化为 [`WorldInstance`]（快照冻结，改卡不回写）；角色卡回答「谁在演」，
/// 世界卡回答「舞台是什么」。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct World {
    pub id: i64,
    pub name: String,
    /// 世界观正文（markdown-lite，同人设）：装配注入 system 世界段（人设段
    /// 之前）；空白整段省略。
    pub worldbook: String,
    /// 历法预设（FR-013 语义随 0017 收编至世界）：存储形态 = Rust serde 产出
    /// 的 snake_case JSON（wire camelCase 不入库，与角色 titles 同口径的
    /// 「wire 与存储两种形态」约束）；None = 内置默认历。
    pub calendar_config: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// 软删除墓碑（ADR-009）。
    pub deleted_at: Option<i64>,
}

/// 新建世界卡入参。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewWorld {
    pub name: String,
    pub worldbook: String,
    pub calendar_config: Option<String>,
}

/// 更新世界卡入参：整卡覆盖（编辑表单全量提交）；calendar_config 传 None 即
/// 回落默认历。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateWorld {
    pub name: String,
    pub worldbook: String,
    pub calendar_config: Option<String>,
}

/// 开局包（FR-014；2026-09-15 历法收编世界后收敛）：建会话可选携带的纯剧情位
/// 开场锚。历法不再单独入参——选中世界即定历法（世界实例化快照）；要给某场戏
/// 换历法，建会后编辑世界实例（后续接线）。命令层把 wire DTO 校验后折叠成本
/// 结构；存储层（infra/storage/sessions.rs）在同一事务内落会话行 + 开场场景行。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpeningSeed {
    /// 开场锚：起始「第 N 天」（None = 1）。
    pub fic_day: Option<i64>,
    /// 开场锚：时段六值之一（None = 「夜」）。
    pub fic_part: Option<String>,
    /// 首场景地点原文，可空。
    pub location: Option<String>,
    /// 首场景时间原文，可空。
    pub time_note: Option<String>,
}

/// 建会话阵容位（D2 扮演位 + D1 选卡实例化）：从角色卡实例化的一位成员。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RosterPick {
    /// 模板卡 id（实例化快照的来源；溯源记入实例 character_id）。
    pub character_id: i64,
    /// true = 用户扮演位（D2：全会话恰好 1）；false = LLM 位（D3 逐拍生成的主体）。
    pub is_user: bool,
}

/// 新建会话入参（多角色阵容形态）：成员 = 用户扮演位 1 张卡 + LLM 位 N 张卡
/// （N ≥ 1，存储层校验；本切片只落建会话时选定的阵容，运行中加人属第 3 步后能力）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewSession {
    /// 世界卡 id（2026-09-15 起必选）：事务内实例化为会话恰一世界实例（快照
    /// name/worldbook/calendar_config，改卡不回写）；卡不存在 / 已软删 → NotFound
    /// 整体回滚。
    pub world_id: i64,
    /// 阵容：逐卡实例化为会话内角色实例（快照 name/persona/render_style，D1）。
    pub roster: Vec<RosterPick>,
    /// 标题，可空串（缺省由调用方取首条用户消息截断后经 update_session_title 回填）。
    pub title: String,
    /// 全局出场动画风格（2026-09-14）：卡 render_style 为 NULL 的成员实例化时
    /// 以此回落，快照仍落具体值（D1 冻结，改全局不回写旧会话）。命令层从
    /// config.json 读当次值传入。
    pub default_render_style: String,
    /// 开局包（FR-014）；None = 降级路径——同样无条件 seed 默认锚开场行
    /// （day=1 / part=夜 / date_label 走内置默认历），保证 latest_scene 存在。
    pub opening: Option<OpeningSeed>,
}

/// 插入消息入参：携带终态落库全部字段（ADR-001）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewMessage {
    pub session_id: i64,
    pub role: MessageRole,
    pub content: String,
    pub reasoning: Option<String>,
    pub think_ms: Option<i64>,
    pub tokens: Option<i64>,
    pub interrupt_flag: Option<String>,
    /// 说话人实例（多角色群像）：user 消息 = 用户位实例，assistant = 生成位实例；
    /// None = 旧形态/未指认（存储层透传，列可空）。
    pub instance_id: Option<i64>,
}

impl NewMessage {
    /// 便捷构造；命令层、生成服务与存储测试共用（instance_id 由调用方按需补挂）。
    pub fn new(session_id: i64, role: MessageRole, content: impl Into<String>) -> Self {
        Self {
            session_id,
            role,
            content: content.into(),
            reasoning: None,
            think_ms: None,
            tokens: None,
            interrupt_flag: None,
            instance_id: None,
        }
    }
}

// ---------------------------------------------------------------------------
// 5b 增量：场景与人物状态（FR-011 / FR-012 数据地基，data_model「5b 增量」）
// ---------------------------------------------------------------------------

/// 人物状态 scope（FR-012 三层拆解：底版 persona 之外的两层——状态与关系）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CharacterStateScope {
    /// 随戏变有时效：情绪 / 健康 / 持有物 / 衣着。
    State,
    /// 缓慢演化：对你 / 他角的态度、约定、知情。
    Relation,
}

impl CharacterStateScope {
    pub fn as_str(self) -> &'static str {
        match self {
            CharacterStateScope::State => "state",
            CharacterStateScope::Relation => "relation",
        }
    }

    /// 从库值解析；未知值视为后端数据损坏。
    pub fn from_db(value: &str) -> Result<Self, StorageError> {
        match value {
            "state" => Ok(CharacterStateScope::State),
            "relation" => Ok(CharacterStateScope::Relation),
            other => Err(StorageError::Backend(format!("未知状态 scope：{other}"))),
        }
    }
}

/// 场景（FR-011）：同会话 `idx` 单调自增，消息经 `messages.scene_id` 归属；
/// 记账层（fic_day / fic_part）是唯一事实源，date_label 是虚拟日历命名缓存（FR-013）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Scene {
    pub id: i64,
    pub session_id: i64,
    /// 同会话内单调自增（含墓碑行一并计序），场景顺序即叙事顺序。
    pub idx: i64,
    /// 场景地点，可空（由导演结算填充）。
    pub location: Option<String>,
    /// 叙事层时间原文（自由书写），可空。
    pub time_note: Option<String>,
    /// 记账层：第几天，可空。
    pub fic_day: Option<i64>,
    /// 记账层：时段，可空。
    pub fic_part: Option<String>,
    /// 虚拟日历命名缓存（如「白蜡月·晨露日」），可空。
    pub date_label: Option<String>,
    /// 本场一句话（远景压缩单元），可空。
    pub summary: Option<String>,
    /// 桥场加厚回顾（Task-03）：两三句、细节比 summary 全，由导演结算对刚收束的
    /// 场景产出；远景编年史只对刚滑出窗口的桥场渲染，更古老的场保持一行 summary。
    /// 可空：旧数据 / 新结算未产出时为 NULL，渲染回退单行。
    pub recap: Option<String>,
    /// 在场实例 id 数组（库内以 JSON 文本存储；迁移 0009 起内容语义 = 会话角色实例
    /// id，原为 character id，列不变——方案 §2.2「scenes.present 真语义」）。
    pub present: Vec<i64>,
    /// 软删除墓碑（ADR-009）。
    pub deleted_at: Option<i64>,
}

/// 人物状态（FR-012）：挂会话内角色实例（多角色群像换挂，迁移 0009——会话隶属由
/// 实例携带，不再单列 session_id）。迁移 0010 状态历史化后同键（instance_id, key）
/// 演进为 append-only 行链，「当前生效行」唯一（partial unique index 只约束生效行）；
/// Q5/D9「对XX」关系约定走 key 文本，不加列。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CharacterState {
    pub id: i64,
    /// 状态所属的角色实例（运行时身份，非模板卡）。
    pub instance_id: i64,
    /// state | relation。
    pub scope: CharacterStateScope,
    /// 状态键：情绪 / 持有 / 约定 / 对某实例的态度。
    pub key: String,
    /// 叙事语言的值，非数字。
    pub value: String,
    /// 过期三义透传（BR-002：scene_end / event:xxx / manual；形态由结算层定，存储层不解释）。
    pub expiry: Option<String>,
    /// 来源场景，可空。导演结算约定记「被收束的场景」，该状态自下一场起生效——
    /// 时间点还原（as_of）查询据此锚定行的时间位置。
    pub source_scene: Option<i64>,
    pub updated_at: i64,
    /// 软删除墓碑（ADR-009）：clear 语义的删除标记，可还原。
    pub deleted_at: Option<i64>,
    /// 被取代时刻（迁移 0010 状态历史化）：非 NULL = 同键已插入新行，本行退居历史链。
    /// 与 deleted_at 语义区分——superseded_at 是正常演进的取代（值演进，非删除），
    /// deleted_at 是墓碑清除；「当前生效行」判定 = 两者皆 NULL（与迁移 0010 的
    /// partial unique index 及 infra/storage/character_states.rs 的查询过滤互指）。
    pub superseded_at: Option<i64>,
}

/// 插入场景入参；`idx` 由存储层按会话单调自增分配，调用方不指定。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewScene {
    pub session_id: i64,
    pub location: Option<String>,
    pub time_note: Option<String>,
    pub fic_day: Option<i64>,
    pub fic_part: Option<String>,
    pub date_label: Option<String>,
    pub summary: Option<String>,
    /// 桥场加厚回顾（Task-03），可空；随 summary 同路径回写上一行；新行不预填
    /// （2026-09-12 裁决：边界快照只属于被收束的场景），进行中 header 行恒 None。
    pub recap: Option<String>,
    /// 在场实例 id 数组（迁移 0009 起语义，见 [`Scene::present`]）；写侧恒落
    /// JSON 文本（空数组落 `"[]"` 不落 NULL），读侧 NULL 视作空数组（历史行）。
    pub present: Vec<i64>,
}

/// 追加式状态变更入参（迁移 0010 状态历史化）：同键（instance_id, key）存在生效行时
/// 旧行打 superseded_at、本条作为新行追加（append-only 历史链）；无生效行则直接插入。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewCharacterState {
    pub instance_id: i64,
    pub scope: CharacterStateScope,
    pub key: String,
    pub value: String,
    pub expiry: Option<String>,
    pub source_scene: Option<i64>,
}

// ---------------------------------------------------------------------------
// 多角色群像：会话角色实例（方案《多角色与时间线-最终》§2 第 1 步，D1/D2/D6）
// ---------------------------------------------------------------------------

/// 会话内角色实例：角色卡的一次性快照身份（D1「卡是死的，人是活的」）——运行时
/// 一切身份（装配人设、状态归属、消息归属、在场名单）都挂在实例上；改卡不回写。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CharacterInstance {
    pub id: i64,
    pub session_id: i64,
    /// 模板溯源（D1）：选卡实例化记卡 id；None = 动态造人（D6，只活在会话实例内）。
    pub character_id: Option<i64>,
    /// 设定快照（D1：值拷贝，改卡不回写）。
    pub name: String,
    pub persona: String,
    pub render_style: String,
    /// 扮演位标记（D2）：true = 用户亲自扮演的「你」，全会话恰好 1。
    pub is_user: bool,
    pub created_at: i64,
    /// 软删除墓碑（ADR-009）。
    pub deleted_at: Option<i64>,
}

/// 新建实例入参（建会话阵容逐卡实例化；动态造人〔第 3 步后〕复用同一入口）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewCharacterInstance {
    pub session_id: i64,
    /// 模板溯源；None = 动态造人（D6）。
    pub character_id: Option<i64>,
    pub name: String,
    pub persona: String,
    pub render_style: String,
    pub is_user: bool,
}

/// 会话内世界实例（2026-09-15 世界卡定稿）：[`World`] 的一次性快照——恰一
/// （迁移 0017 部分唯一索引库级保证）；name / worldbook / calendar_config 值
/// 拷贝，改卡不回写（D1 冻结语义同 [`CharacterInstance`]）。**会话历法唯一
/// 归属**（0017 自 sessions 移入）：生成 / 结算 / 装配的历法 parse 源。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorldInstance {
    pub id: i64,
    pub session_id: i64,
    /// 溯源：实例化时的世界卡 id（卡只软删不物删，指向恒有效）。
    pub world_id: i64,
    pub name: String,
    pub worldbook: String,
    pub calendar_config: Option<String>,
    pub created_at: i64,
    /// 软删除墓碑（ADR-009）。
    pub deleted_at: Option<i64>,
}

/// 新建世界实例入参（建会话事务内实例化专用；会话内编辑属后续接线）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewWorldInstance {
    pub session_id: i64,
    pub world_id: i64,
    pub name: String,
    pub worldbook: String,
    pub calendar_config: Option<String>,
}

// ---------------------------------------------------------------------------
// 测试：枚举 ↔ SQLite CHECK 字面量双向映射（约束耦合点的稳定性回归）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// MessageRole ↔ messages.role（迁移 0001 建立，0009 重建表字面量不变）：
    /// `CHECK (role IN ('user', 'assistant'))`。
    #[test]
    fn message_role_roundtrip_matches_check_literals() {
        // 全变体精确字面量：与 CHECK 约束逐字一致，手滑改写即此处爆红。
        assert_eq!(MessageRole::User.as_str(), "user");
        assert_eq!(MessageRole::Assistant.as_str(), "assistant");
        // 合法字面量回读恒等（as_str → from_db 往返）。
        assert_eq!(
            MessageRole::from_db(MessageRole::User.as_str()),
            Ok(MessageRole::User)
        );
        assert_eq!(
            MessageRole::from_db(MessageRole::Assistant.as_str()),
            Ok(MessageRole::Assistant)
        );
        // 未知库值判后端数据损坏，禁止默认落变体装成功。
        assert!(matches!(
            MessageRole::from_db("system"),
            Err(StorageError::Backend(_))
        ));
    }

    /// CharacterStateScope ↔ character_states.scope（迁移 0002 建立，0009 重建表
    /// 字面量不变）：`CHECK (scope IN ('state', 'relation'))`。
    #[test]
    fn character_state_scope_roundtrip_matches_check_literals() {
        assert_eq!(CharacterStateScope::State.as_str(), "state");
        assert_eq!(CharacterStateScope::Relation.as_str(), "relation");
        assert_eq!(
            CharacterStateScope::from_db(CharacterStateScope::State.as_str()),
            Ok(CharacterStateScope::State)
        );
        assert_eq!(
            CharacterStateScope::from_db(CharacterStateScope::Relation.as_str()),
            Ok(CharacterStateScope::Relation)
        );
        assert!(matches!(
            CharacterStateScope::from_db("mood"),
            Err(StorageError::Backend(_))
        ));
    }
}
