//! 两级模型配置解析（自 generation.rs 本体外置，500 行规范；代码逐字搬移）：
//! 全局默认 (provider, model) 二元组为底，Character.model_config 逐字段覆写
//! （INT-002 / DOM-001 / 验收 4）。生成闭环编排本体见 [`super`]。

use serde::Deserialize;

use crate::domain::models::Character;
use crate::infra::config::{Config as FileConfig, ProviderConfig, TEMPERATURE_MAX, TEMPERATURE_MIN};
use crate::infra::llm::LlmConfig;

// ---------------------------------------------------------------------------
// 两级模型配置（INT-002 / DOM-001 / 验收 4）：全局默认 Provider ← Character.model_config 覆写
// ---------------------------------------------------------------------------

/// Character.model_config 的 JSON 形态（camelCase 键，全部可选；未知键忽略）。
/// `providerId` 切到 config.providers 中的另一套（双层级 2026-09-09：模型取该
/// 服务的 active/first）；其余键直接覆写对应字段（旧数据里的 baseUrl/apiKey
/// 键继续生效；UI 已不再产出这两个键）。`temperature`（2026-09-14 温度覆写）
/// 缺省跟随全局，给出时须在 0–2 值域内（与 infra/config.rs validate 同域拒绝）。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfigOverride {
    provider_id: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    temperature: Option<f64>,
}

/// 解析生效的 LLM 连接配置：全局默认 (provider, model) 二元组（双层级
/// 2026-09-09，见 Config::active_selection）为底，Character.model_config 逐字段
/// 覆写（两级配置，INT-002 / 验收 4）。多角色裁量：覆写源 = 调用方选定的模板卡
/// （命令层取「主持实例」的卡，见 ipc::resolve_llm）；None = 无卡可覆写（动态造人
/// 主持 / 畸形阵容），跟随全局默认。未配置 Provider/模型、字段为空或
/// model_config 非法 JSON → 人类可读错误（快速失败）。
pub fn resolve_effective_llm(
    config: &FileConfig,
    character: Option<&Character>,
) -> Result<LlmConfig, String> {
    let (provider, active_model): (&ProviderConfig, &str) = config
        .active_selection()
        .ok_or_else(|| "未配置全局默认模型：请在设置页选择服务并添加模型".to_string())?;
    let mut base_url = provider.base_url.clone();
    let mut api_key = provider.api_key.clone();
    let mut model = active_model.to_string();
    // 采样温度以全局设置为底（角色温度覆写在其后）。
    let mut temperature = config.temperature;
    // 协议随 provider 走（2026-09-14 三协议）：provider 级属性，请求分派与响应
    // 解析都依赖它，切 provider 时整体跟随。
    let mut api = provider.api;

    if let Some(raw) = character.and_then(|c| c.model_config.as_deref()) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let over: ModelConfigOverride = serde_json::from_str(trimmed)
                .map_err(|e| format!("角色 model_config 解析失败：{e}"))?;
            // 温度覆写（2026-09-14）：值域与 infra validate 同为 0–2，越界快速
            // 失败（可读错误），不静默钳边——坏值在编辑侧保存即被 UI 滑杆挡住，
            // 这里兜手改库/旧数据的底。
            if let Some(t) = over.temperature {
                if !(TEMPERATURE_MIN..=TEMPERATURE_MAX).contains(&t) {
                    return Err(format!(
                        "角色 model_config 的 temperature = {t} 越界（允许 {TEMPERATURE_MIN}–{TEMPERATURE_MAX}）"
                    ));
                }
                temperature = t;
            }
            if let Some(id) = over.provider_id.as_deref().filter(|s| !s.trim().is_empty()) {
                let switched = config
                    .providers
                    .iter()
                    .find(|p| p.id == id)
                    .ok_or_else(|| format!("角色 model_config 指向不存在的 provider：{id}"))?;
                base_url = switched.base_url.clone();
                api_key = switched.api_key.clone();
                // 协议跟随所选 provider（切服务即切 API 形态）。
                api = switched.api;
                // 切服务但未指名模型 → 取该服务第一个模型（active_model 是全局
                // 默认指向，不跟角色切服务走）。
                model = switched
                    .models
                    .first()
                    .map(|s| s.id.clone())
                    .ok_or_else(|| format!("服务「{id}」没有任何模型：请在设置页添加"))?;
            }
            // 旧键 baseUrl/apiKey 覆写不携带协议：协议是 provider 级属性，不在
            // 角色覆写键清单里（沿用所选 provider 的 api），否则会出现「别家的
            // base_url + 本家协议」的畸形组合。
            if let Some(v) = over.base_url {
                base_url = v;
            }
            if let Some(v) = over.api_key {
                api_key = v;
            }
            if let Some(v) = over.model {
                model = v;
            }
        }
    }

    if base_url.trim().is_empty() {
        return Err("LLM base_url 不能为空：请检查 Provider 配置".into());
    }
    if model.trim().is_empty() {
        return Err("LLM model 不能为空：请检查 Provider 配置".into());
    }
    Ok(LlmConfig {
        base_url,
        api_key,
        model,
        api,
        // 采样温度：全局设置为底，角色 model_config.temperature 可覆写。
        temperature,
        ..LlmConfig::default()
    })
}
