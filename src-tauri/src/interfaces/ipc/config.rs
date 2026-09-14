//! 配置域（FR-009 / ADR-012 / TASK-003）：config.json 读取/保存与 wire DTO。

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::infra::config::{Config as FileConfig, ModelModality, ModelSpec};
use crate::infra::config::ProviderConfig as FileProvider;
use crate::infra::llm::ProviderApi;
use crate::state::AppState;

use super::error::IpcError;

/// 单个模型的元数据 wire 形态（2026-09-14 模型元数据化；存储侧 infra 的
/// ModelSpec snake_case，此处 camelCase 直出前端）。字段语义见 infra/config.rs。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpecDto {
    pub id: String,
    pub context_window: u32,
    pub max_output_tokens: u32,
    pub input_types: Vec<ModelModality>,
    pub output_types: Vec<ModelModality>,
}

impl From<ModelSpec> for ModelSpecDto {
    fn from(m: ModelSpec) -> Self {
        Self::from(&m)
    }
}

impl From<&ModelSpec> for ModelSpecDto {
    fn from(m: &ModelSpec) -> Self {
        Self {
            id: m.id.clone(),
            context_window: m.context_window,
            max_output_tokens: m.max_output_tokens,
            input_types: m.input_types.clone(),
            output_types: m.output_types.clone(),
        }
    }
}

impl From<ModelSpecDto> for ModelSpec {
    fn from(dto: ModelSpecDto) -> Self {
        Self {
            id: dto.id,
            context_window: dto.context_window,
            max_output_tokens: dto.max_output_tokens,
            input_types: dto.input_types,
            output_types: dto.output_types,
        }
    }
}

/// 单套 LLM Provider（FR-009）。双层级（2026-09-09）：一个服务
/// 提供多个模型（`models`，模型 id 字符串即身份）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDto {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    /// 该服务可用的模型列表；至少一个才能用于生成。
    pub models: Vec<ModelSpecDto>,
    /// API 兼容协议（2026-09-14 三选一，wire 值 snake_case）；
    /// 缺省 openai（存储侧 serde default，DTO 侧为必填键）。
    pub api: ProviderApi,
}

/// 应用配置（FR-009 / ADR-012；wire 形态 camelCase，落盘文件仍为 infra 的 snake_case 键）。
/// 不再派生 Eq：temperature 为 f64（f64 无 Eq）；等值断言走 PartialEq。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDto {
    pub providers: Vec<ProviderDto>,
    /// 全局默认模型指向的 provider id；null = 未选择。
    pub active_provider_id: Option<String>,
    /// 全局默认模型名（双层级 2026-09-09）：active_provider_id 的 models 之一；
    /// null = 未显式选择（解析回落该服务第一个模型）。
    pub active_model: Option<String>,
    /// 打字节奏 ms/字（10–160，FR-009）。
    pub rhythm_ms_per_char: u32,
    pub punct_pause_enabled: bool,
    /// 动效时长基准 ms。
    pub anim_duration_base: u32,
    /// 全局出场动画风格（2026-09-14）：角色卡 renderStyle 为 null 时的演出回落值。
    pub render_style: String,
    pub ui_language: String,
    /// system / light / dark。
    pub ui_theme: String,
    /// 导演专用模型；null / 空 = 跟随主模型（INT-003）。
    pub director_model: Option<String>,
    /// 近景场景数（近景窗口可选化：最近 N 个已结算场整场进近景，1–6，默认 2）。
    pub near_scenes: u32,
    /// 采样温度（0–2，默认 0.7）：chat 请求的 temperature 参数（三协议下发，
    /// Anthropic 侧超 1.0 由协议适配钳制）。
    pub temperature: f64,
}

impl From<&FileConfig> for ConfigDto {
    fn from(c: &FileConfig) -> Self {
        Self {
            providers: c
                .providers
                .iter()
                .map(|p| ProviderDto {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    base_url: p.base_url.clone(),
                    api_key: p.api_key.clone(),
                    models: p.models.iter().map(ModelSpecDto::from).collect(),
                    api: p.api,
                })
                .collect(),
            active_provider_id: c.active_provider_id.clone(),
            active_model: c.active_model.clone(),
            rhythm_ms_per_char: c.rhythm_ms_per_char,
            punct_pause_enabled: c.punct_pause_enabled,
            anim_duration_base: c.anim_duration_base,
            render_style: c.render_style.clone(),
            ui_language: c.ui_language.clone(),
            ui_theme: c.ui_theme.clone(),
            director_model: c.director_model.clone(),
            near_scenes: c.near_scenes,
            temperature: c.temperature,
        }
    }
}

impl From<ConfigDto> for FileConfig {
    fn from(d: ConfigDto) -> Self {
        Self {
            providers: d
                .providers
                .into_iter()
                .map(|p| FileProvider {
                    id: p.id,
                    name: p.name,
                    base_url: p.base_url,
                    api_key: p.api_key,
                    models: p.models.into_iter().map(ModelSpec::from).collect(),
                    api: p.api,
                    model: None,
                })
                .collect(),
            active_provider_id: d.active_provider_id,
            active_model: d.active_model,
            rhythm_ms_per_char: d.rhythm_ms_per_char,
            punct_pause_enabled: d.punct_pause_enabled,
            anim_duration_base: d.anim_duration_base,
            render_style: d.render_style,
            ui_language: d.ui_language,
            ui_theme: d.ui_theme,
            director_model: d.director_model,
            near_scenes: d.near_scenes,
            temperature: d.temperature,
        }
    }
}

// ---- 配置（FR-009 / ADR-012 / TASK-003）----

fn get_config_impl(app: &AppState) -> Result<ConfigDto, IpcError> {
    // 读当次值不缓存（ADR-012）：每次 load()，外部手改立即生效。
    Ok(ConfigDto::from(&app.config.load()?))
}

#[tauri::command]
#[specta::specta]
pub fn get_config(state: State<'_, AppState>) -> Result<ConfigDto, IpcError> {
    get_config_impl(&state)
}

fn save_config_impl(app: &AppState, config: ConfigDto) -> Result<(), IpcError> {
    // save = 校验 + 原子写（ADR-012）；越界值（如 rhythm 10–160 外）在此被拒。
    app.config.save(&FileConfig::from(config))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn save_config(state: State<'_, AppState>, config: ConfigDto) -> Result<(), IpcError> {
    save_config_impl(&state, config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interfaces::ipc::test_support::temp_state;

    #[test]
    fn config_dto_roundtrip_through_file_config() {
        let dto = ConfigDto {
            render_style: "type".into(),
            providers: vec![ProviderDto {
                id: "p1".into(),
                name: "本地中转".into(),
                base_url: "https://example.invalid/v1".into(),
                api_key: "sk-test".into(),
                models: vec![ModelSpec::from_id("m1").into(), ModelSpec::from_id("m2").into()],
                api: ProviderApi::OpenAi,
            }],
            active_provider_id: Some("p1".into()),
            active_model: Some("m2".into()),
            rhythm_ms_per_char: 90,
            punct_pause_enabled: false,
            anim_duration_base: 300,
            ui_language: "zh".into(),
            ui_theme: "dark".into(),
            director_model: None,
            near_scenes: 4,
            temperature: 0.9,
        };
        let wire = serde_json::to_value(&dto).unwrap();
        assert_eq!(wire["activeProviderId"], "p1", "wire camelCase");
        assert_eq!(wire["activeModel"], "m2", "wire camelCase");
        assert_eq!(wire["providers"][0]["baseUrl"], "https://example.invalid/v1");
        assert_eq!(
            wire["providers"][0]["models"],
            serde_json::json!([
                { "id": "m1", "contextWindow": 1_000_000, "maxOutputTokens": 128_000, "inputTypes": ["text"], "outputTypes": ["text"] },
                { "id": "m2", "contextWindow": 1_000_000, "maxOutputTokens": 128_000, "inputTypes": ["text"], "outputTypes": ["text"] },
            ])
        );
        assert_eq!(wire["rhythmMsPerChar"], 90);
        assert_eq!(wire["nearScenes"], 4, "近景场景数 camelCase 透传");
        assert_eq!(wire["temperature"], 0.9, "采样温度 camelCase 透传");

        let file: FileConfig = dto.clone().into();
        let back: ConfigDto = (&file).into();
        assert_eq!(dto, back, "DTO ↔ 落盘结构往返无损");
        assert_eq!(file.rhythm_ms_per_char, 90);
        assert_eq!(file.near_scenes, 4);
        assert_eq!(
            file.providers[0].models,
            vec![ModelSpec::from_id("m1"), ModelSpec::from_id("m2")]
        );
    }

    #[test]
    fn config_commands_load_save_and_validate() {
        let (app, dir) = temp_state("config");

        let defaults = get_config_impl(&app).unwrap();
        assert_eq!(defaults.rhythm_ms_per_char, 45, "无文件 → 全默认（FR-009）");
        assert_eq!(defaults.temperature, 0.7, "采样温度默认 0.7");

        let mut next = defaults.clone();
        next.ui_theme = "dark".into();
        next.rhythm_ms_per_char = 120;
        save_config_impl(&app, next).unwrap();
        assert_eq!(get_config_impl(&app).unwrap().ui_theme, "dark");
        assert_eq!(get_config_impl(&app).unwrap().rhythm_ms_per_char, 120);

        // 越界值被 infra 校验拒绝（FR-009：10–160），以可序列化 Config 错误返回。
        let bad = ConfigDto {
            rhythm_ms_per_char: 999,
            ..get_config_impl(&app).unwrap()
        };
        assert!(matches!(save_config_impl(&app, bad), Err(IpcError::Config { .. })));
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
