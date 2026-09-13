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
    /// 出场动画风格（18 种之一，按角色存而非全局）。
    pub render_style: String,
    /// 角色专属模型覆写 JSON，可空。
    pub model_config: Option<String>,
    /// 强调色（编辑器右栏渐变背景等界面着色），#RRGGBB；None = 跟随海报派生色。
    pub accent_color: Option<String>,
    /// TTS 预留缝（CON-003），恒 None。
    pub voice_config: Option<String>,
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
    /// 会话日历快照（FR-013）：建会话时由开局包显式指定（None = 内置默认历），
    /// 落库后归属本会话行——角色卡不持有历法（2026-09-13 产品裁剪），会话行是
    /// 会话历法唯一归属。
    pub calendar_config: Option<String>,
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

/// 新建角色卡入参（FR-006）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewCharacter {
    pub name: String,
    pub avatar: Option<String>,
    pub persona: String,
    pub gender: Option<String>,
    pub age: Option<String>,
    pub render_style: String,
    pub model_config: Option<String>,
    pub accent_color: Option<String>,
    pub voice_config: Option<String>,
}

impl Default for NewCharacter {
    fn default() -> Self {
        Self {
            name: String::new(),
            avatar: None,
            persona: String::new(),
            gender: None,
            age: None,
            render_style: "type".to_string(),
            model_config: None,
            accent_color: None,
            voice_config: None,
        }
    }
}

/// 更新角色卡入参：整卡覆盖（编辑表单全量提交）；avatar 传 None 即清除头像。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateCharacter {
    pub name: String,
    pub avatar: Option<String>,
    pub persona: String,
    pub gender: Option<String>,
    pub age: Option<String>,
    pub render_style: String,
    pub model_config: Option<String>,
    pub accent_color: Option<String>,
    pub voice_config: Option<String>,
}

/// 开局包（FR-014）：建会话可选携带的「显式日历 + 开场锚」。
/// 命令层（interfaces/ipc.rs）把 wire DTO 校验后折叠成本结构；存储层
/// （infra/storage/sessions.rs）在同一事务内落会话行 + 开场场景行。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpeningSeed {
    /// 显式指定会话日历（FR-014）；None = 内置默认历。
    pub calendar: Option<crate::domain::fiction_time::CalendarConfig>,
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
    /// 阵容：逐卡实例化为会话内角色实例（快照 name/persona/render_style，D1）。
    pub roster: Vec<RosterPick>,
    /// 标题，可空串（缺省由调用方取首条用户消息截断后经 update_session_title 回填）。
    pub title: String,
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
    /// 在场实例 id 数组（迁移 0009 起语义，见 [`Scene::present`]）；空数组落库为 NULL。
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

// ---------------------------------------------------------------------------
// LLM 调用轨迹（透明化功能）：llm_calls 表投影，一次 HTTP 请求一条记录
// ---------------------------------------------------------------------------

/// LLM 调用类别（llm_calls.kind CHECK 三值）：主对话流式 / 记忆探索器工具循环 /
/// 导演结算裁决。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LlmCallKind {
    /// 主对话流式生成（generation）。
    Dialogue,
    /// 记忆探索器工具循环（explorer，每轮一次请求）。
    Explorer,
    /// 导演结算裁决（director，含修正重试的每次尝试）。
    Director,
}

impl LlmCallKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LlmCallKind::Dialogue => "dialogue",
            LlmCallKind::Explorer => "explorer",
            LlmCallKind::Director => "director",
        }
    }

    /// 从库值解析；未知值视为后端数据损坏。历史「draft」值（历法起草 2026-09-13
    /// 裁撤）不再识别——应用未发布、无存量数据要保护。
    pub fn from_db(value: &str) -> Result<Self, StorageError> {
        match value {
            "dialogue" => Ok(LlmCallKind::Dialogue),
            "explorer" => Ok(LlmCallKind::Explorer),
            "director" => Ok(LlmCallKind::Director),
            other => Err(StorageError::Backend(format!("未知 LLM 调用类别：{other}"))),
        }
    }
}

/// LLM 调用终态（llm_calls.status CHECK 二值）。取消按 error 落（error_text = 已取消）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LlmCallStatus {
    Ok,
    Error,
}

impl LlmCallStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            LlmCallStatus::Ok => "ok",
            LlmCallStatus::Error => "error",
        }
    }

    /// 从库值解析；未知值视为后端数据损坏。
    pub fn from_db(value: &str) -> Result<Self, StorageError> {
        match value {
            "ok" => Ok(LlmCallStatus::Ok),
            "error" => Ok(LlmCallStatus::Error),
            other => Err(StorageError::Backend(format!("未知 LLM 调用终态：{other}"))),
        }
    }
}

/// LLM 调用轨迹（透明化功能）：每次 LLM HTTP 请求的完整可回放记录。
/// 日志性质旁路数据——**不做软删除**（无墓碑列，ADR-009 在此不适用），只插不改不删。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LlmCall {
    pub id: i64,
    /// 所属会话；历史起草调用（2026-09-13 裁撤）曾为 None，现行写入方恒 Some。
    pub session_id: Option<i64>,
    pub kind: LlmCallKind,
    pub model: String,
    /// 请求发起时刻（Unix 毫秒）。
    pub started_at: i64,
    /// 本次 HTTP 请求墙钟耗时（毫秒）。
    pub duration_ms: i64,
    /// 请求消息数组 JSON（[{role, content, …}]；工具轮含 tool 角色与 tool_calls 回传）。
    pub prompt_json: String,
    /// 响应正文；失败 / 取消路径为已收到的半条（None = 零内容）。
    pub response_text: Option<String>,
    /// 思考内容（字段型 reasoning / 内联 <think> 拆分产物）。
    pub reasoning_text: Option<String>,
    /// 本轮模型发起的工具调用 [{name, arguments}] JSON；非工具轮为 None。
    pub tool_calls_json: Option<String>,
    /// usage（网关未回报即 None：流式不做请求侧 include_usage 追加，有则记）。
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub status: LlmCallStatus,
    /// status = error 时的人类可读原因。
    pub error_text: Option<String>,
}

/// 插入调用轨迹入参（id / 落库时刻由存储层分配）。
#[derive(Debug, Clone, PartialEq)]
pub struct NewLlmCall {
    pub session_id: Option<i64>,
    pub kind: LlmCallKind,
    pub model: String,
    pub started_at: i64,
    pub duration_ms: i64,
    pub prompt_json: String,
    pub response_text: Option<String>,
    pub reasoning_text: Option<String>,
    pub tool_calls_json: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub status: LlmCallStatus,
    pub error_text: Option<String>,
}
