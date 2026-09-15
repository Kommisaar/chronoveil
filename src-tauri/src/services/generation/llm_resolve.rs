//! 两级模型配置解析（INT-002 / DOM-001 / 验收 4）：全局默认 (provider, model)
//! 二元组为底，Character 的模型覆写三标量（model_provider_id / model_name /
//! model_temperature，2026-09-15 自 JSON 串列扁平化）逐字段覆写。
//! 生成闭环编排本体见 [`super`]。

use crate::domain::models::Character;
use crate::infra::config::{Config as FileConfig, ProviderConfig, TEMPERATURE_MAX, TEMPERATURE_MIN};
use crate::infra::llm::LlmConfig;

/// trimmed 空串视同未设置：手改库/旧数据里的空字符串不当作有效覆写值。
fn effective_field(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

/// 解析生效的 LLM 连接配置：全局默认 (provider, model) 二元组（双层级
/// 2026-09-09，见 Config::active_selection）为底，Character 模型覆写三标量
/// 逐字段覆盖（两级配置，INT-002 / 验收 4）。多角色裁量：覆写源 = 调用方选定
/// 的模板卡（命令层取「主持实例」的卡，见 ipc::resolve_llm）；None = 无卡可
/// 覆写（动态造人主持 / 畸形阵容），跟随全局默认。未配置 Provider/模型、
/// temperature 越界或 provider id 不存在 → 人类可读错误（快速失败）。
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

    if let Some(character) = character {
        // 温度覆写（2026-09-14）：值域与 infra validate 同为 0–2，越界快速
        // 失败（可读错误），不静默钳边——坏值在编辑侧保存即被命令层校验挡住，
        // 这里兜手改库的底。
        if let Some(t) = character.model_temperature {
            if !(TEMPERATURE_MIN..=TEMPERATURE_MAX).contains(&t) {
                return Err(format!(
                    "角色模型覆写的 temperature = {t} 越界（允许 {TEMPERATURE_MIN}–{TEMPERATURE_MAX}）"
                ));
            }
            temperature = t;
        }
        // 切 provider：base_url / api_key / 协议整体跟随所选服务；未指名模型时
        // 取该服务第一个模型（active_model 是全局默认指向，不跟角色切服务走）。
        if let Some(id) = effective_field(character.model_provider_id.as_deref()) {
            let switched = config
                .providers
                .iter()
                .find(|p| p.id == id)
                .ok_or_else(|| format!("角色模型覆写指向不存在的 provider：{id}"))?;
            base_url = switched.base_url.clone();
            api_key = switched.api_key.clone();
            api = switched.api;
            model = switched
                .models
                .first()
                .map(|s| s.id.clone())
                .ok_or_else(|| format!("服务「{id}」没有任何模型：请在设置页添加"))?;
        }
        // 模型名覆写在 provider 切换结果之上生效。
        if let Some(name) = effective_field(character.model_name.as_deref()) {
            model = name.to_string();
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
        // 采样温度：全局设置为底，角色 model_temperature 可覆写。
        temperature,
        ..LlmConfig::default()
    })
}
