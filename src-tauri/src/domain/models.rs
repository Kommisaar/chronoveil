//! 领域模型：Character / Session / Message（DOM-001，data_model v1 三表）。
//! 字段与库表一一对应；时间戳统一为 Unix 毫秒（created_at / updated_at / deleted_at）。
//! Scene / CharacterState / 虚拟日历为 5b 增量，本阶段不含。

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

/// 角色卡（DOM-001）：一等实体——人设、开场白、出场方式、模型参数都挂在角色上。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Character {
    pub id: i64,
    pub name: String,
    /// 头像，可空：data URL 或 `~/.chronoveil` 下相对路径（data_model rev 6）。
    pub avatar: Option<String>,
    /// 人设系统提示词（底版，几乎不变）。
    pub persona: String,
    /// 开场白，markdown-lite，与聊天正文走同一渲染管线。
    pub greeting: String,
    /// 出场动画风格（18 种之一，按角色存而非全局）。
    pub render_style: String,
    /// 角色专属模型覆写 JSON，可空。
    pub model_config: Option<String>,
    /// TTS 预留缝（CON-003），恒 None。
    pub voice_config: Option<String>,
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
    pub greeting: String,
    pub render_style: String,
    pub model_config: Option<String>,
    pub voice_config: Option<String>,
}

impl Default for NewCharacter {
    fn default() -> Self {
        Self {
            name: String::new(),
            avatar: None,
            persona: String::new(),
            greeting: String::new(),
            render_style: "typewriter".to_string(),
            model_config: None,
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
    pub greeting: String,
    pub render_style: String,
    pub model_config: Option<String>,
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
