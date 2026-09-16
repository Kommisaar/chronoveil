//! 模型元数据（自 config.rs 拆出，2026-09-16 源文件 500 行上限）：
//! 单个模型的展示/裁剪用元数据与旧字符串格式的兼容反序列化。
//! 与 config.json 的持久化键（snake_case）同一形态——这是存储层类型，非 wire DTO。

use serde::{Deserialize, Serialize};

/// 模型输入/输出模态（2026-09-14 模型元数据化；文本恒在，其余可选）。
/// wire 值 snake_case，与前端 ModelModality 联合类型同源（specta 导出）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ModelModality {
    Text,
    Image,
    Video,
    Pdf,
}

/// 单个模型的元数据（2026-09-14 自纯模型名字符串升级）：id 即原模型名（全局
/// 默认 active_model、导演跟随与角色覆写均以 id 字符串流转），其余字段供展示
/// 与未来的调用参数裁剪。上下文窗口/最大输出缺省值与新增对话框预填一致
/// （1M / 128K）；模态缺省 = 仅文本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct ModelSpec {
    pub id: String,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub input_types: Vec<ModelModality>,
    pub output_types: Vec<ModelModality>,
}

impl Default for ModelSpec {
    /// serde 缺键回落与 [`ModelSpec::from_id`] 同源：空 id（非法行由校验层标错）
    /// + 1M 上下文 / 128K 输出 + 仅文本。
    fn default() -> Self {
        Self::from_id(String::new())
    }
}

impl ModelSpec {
    /// 旧字符串模型的等价构造（id 之外全默认）。
    pub fn from_id(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            context_window: 1_000_000,
            max_output_tokens: 128_000,
            input_types: vec![ModelModality::Text],
            output_types: vec![ModelModality::Text],
        }
    }
}

impl From<&str> for ModelSpec {
    fn from(id: &str) -> Self {
        Self::from_id(id)
    }
}

/// 兼容反序列化：历史 config.json 的 models 是纯字符串数组（未发布应用，无
/// 存量迁移义务，但字符串 → ModelSpec 的兜底让旧文件不用手改即可载入）。
/// 仅供 ProviderConfig 的 serde 属性经 `model_spec::` 路径引用（本模块内部实现）。
pub(super) fn deserialize_models<'de, D>(deserializer: D) -> Result<Vec<ModelSpec>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Vec::<serde_json::Value>::deserialize(deserializer)?;
    raw.into_iter()
        .map(|value| {
            if let Some(id) = value.as_str() {
                return Ok(ModelSpec::from_id(id));
            }
            serde_json::from_value::<ModelSpec>(value).map_err(serde::de::Error::custom)
        })
        .collect()
}
