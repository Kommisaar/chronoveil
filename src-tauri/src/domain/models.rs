//! 领域模型：Character / Session / Message（DOM-001，data_model v1 三表）+
//! Scene / CharacterState（data_model「5b 增量」，TASK-011 数据层地基）。
//! 字段与库表一一对应；时间戳统一为 Unix 毫秒（created_at / updated_at / deleted_at）。
//!
//! 注：messages 表 5b 起已有可空 scene_id / character_id 列（迁移 0002），
//! 本结构体的读写接线随导演 / 结算任务开启，暂不在此展开。

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
    /// 角色卡世界观日历 JSON（FR-013；data_model「日历归属与继承」：
    /// 角色卡是日历的归属地），None = 内置默认历。
    pub calendar_config: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// 软删除墓碑（ADR-009）：None = 在世。
    pub deleted_at: Option<i64>,
}

/// 会话（FR-007）：同一 Character 可开多个；updated_at 每条新消息刷新，列表按其倒序。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub id: i64,
    pub character_id: i64,
    /// 标题，缺省取首条用户消息截断。
    pub title: String,
    /// 会话日历快照（FR-013）：建会话时从 Character 复制，之后各自演进互不回写；
    /// None = 内置默认历。
    pub calendar_config: Option<String>,
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
            render_style: "typewriter".to_string(),
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

/// 新建会话入参。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewSession {
    pub character_id: i64,
    /// 标题，可空串（缺省由调用方取首条用户消息截断后经 update_session_title 回填）。
    pub title: String,
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
}

impl NewMessage {
    /// 便捷构造；生成服务（阶段 3）与存储测试共用。
    #[allow(dead_code)]
    pub fn new(session_id: i64, role: MessageRole, content: impl Into<String>) -> Self {
        Self {
            session_id,
            role,
            content: content.into(),
            reasoning: None,
            think_ms: None,
            tokens: None,
            interrupt_flag: None,
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
    /// 在场 character id 数组（库内以 JSON 文本存储）。
    pub present: Vec<i64>,
    /// 软删除墓碑（ADR-009）。
    pub deleted_at: Option<i64>,
}

/// 人物状态（FR-012）：挂 `(character_id, session_id)`——状态属于「这个会话里的这个角色」，
/// 重开会话不带旧案状态。同键（character_id, session_id, key）在世行唯一（partial unique index）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CharacterState {
    pub id: i64,
    pub character_id: i64,
    pub session_id: i64,
    /// state | relation。
    pub scope: CharacterStateScope,
    /// 状态键：情绪 / 持有 / 约定 / 对某角的态度。
    pub key: String,
    /// 叙事语言的值，非数字。
    pub value: String,
    /// 过期三义透传（BR-002：scene_end / event:xxx / manual；形态由结算层定，存储层不解释）。
    pub expiry: Option<String>,
    /// 来源场景，可空。
    pub source_scene: Option<i64>,
    pub updated_at: i64,
    /// 软删除墓碑（ADR-009）。
    pub deleted_at: Option<i64>,
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
    /// 在场 character id 数组；空数组落库为 NULL。
    pub present: Vec<i64>,
}

/// upsert 人物状态入参：同键（character_id, session_id, key）覆盖 value / expiry / source_scene
/// （scope 是行既有属性，不随覆盖变化）；键不存在则插入新行。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewCharacterState {
    pub character_id: i64,
    pub session_id: i64,
    pub scope: CharacterStateScope,
    pub key: String,
    pub value: String,
    pub expiry: Option<String>,
    pub source_scene: Option<i64>,
}
