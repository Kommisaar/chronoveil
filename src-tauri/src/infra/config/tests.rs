//! `config.json` 契约测试（自 config.rs 外置，源文件 500 行上限）：
//! 缺文件全默认、缺键合并 / 未知键忽略、坏文件快速失败、原子写往返、
//! 值域校验、双层级迁移、不缓存读取。
use super::*;

static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// 每个测试独享的临时目录；绝不写真实 home（ADR-012）。
fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "chronoveil_config_test_{}_{}_{}",
        std::process::id(),
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        tag
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn store_in(dir: &Path) -> ConfigStore {
    ConfigStore::in_app_home(dir)
}

/// 验收 2：文件不存在返回全默认值，不报错。
#[test]
fn missing_file_returns_defaults() {
    let dir = temp_dir("missing");
    let config = store_in(&dir).load().unwrap();
    assert_eq!(config, Config::new_with_defaults());
    assert!(config.providers.is_empty());
    assert_eq!(config.active_provider_id, None);
    assert_eq!(config.active_model, None);
    assert_eq!(config.rhythm_ms_per_char, 45);
    assert!(config.punct_pause_enabled);
    assert_eq!(config.anim_duration_base, 450);
    assert_eq!(config.ui_language, "zh");
    assert_eq!(config.ui_theme, "system");
    assert_eq!(config.director_model, None);
    assert_eq!(config.near_scenes, 2, "近景场景数默认 2（ADR-004 原窗口）");
    assert_eq!(config.temperature, 0.7, "采样温度默认 0.7");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 验收 2/4：存在时缺键补默认、未知键忽略、已给键取当次值。
#[test]
fn missing_keys_merge_and_unknown_keys_ignored() {
    let dir = temp_dir("merge");
    std::fs::write(
        store_in(&dir).path(),
        r#"{
                "rhythm_ms_per_char": 80,
                "ui_theme": "dark",
                "unknown_future_key": {"nested": true}
            }"#,
    )
    .unwrap();
    let config = store_in(&dir).load().unwrap();
    assert_eq!(config.rhythm_ms_per_char, 80, "已给键取文件值");
    assert_eq!(config.ui_theme, "dark");
    assert!(config.punct_pause_enabled, "缺键补默认");
    assert_eq!(config.anim_duration_base, 450);
    assert_eq!(config.ui_language, "zh");
    assert!(config.providers.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

/// 验收 2：坏 JSON / 字段类型不符 → 快速失败（Parse），不静默重置成默认。
#[test]
fn bad_file_fails_loudly() {
    let dir = temp_dir("bad");
    let store = store_in(&dir);
    std::fs::write(store.path(), "{ not json").unwrap();
    let err = store.load().unwrap_err();
    assert!(matches!(err, ConfigError::Parse { .. }), "实际：{err:?}");
    assert!(
        err.to_string().contains("不静默重置"),
        "错误信息需可读：{err}"
    );

    std::fs::write(store.path(), r#"{"rhythm_ms_per_char": "fast"}"#).unwrap();
    let err = store.load().unwrap_err();
    assert!(
        matches!(err, ConfigError::Parse { .. }),
        "类型不符也是坏文件：{err:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// 验收 3：原子写往返——保存后重新读取内容一致；目录内不留 `.tmp` 残件。
#[test]
fn save_load_roundtrip_and_no_tmp_leftover() {
    let dir = temp_dir("roundtrip");
    let store = store_in(&dir);
    let config = Config {
        render_style: crate::infra::config::DEFAULT_RENDER_STYLE.into(),
        providers: vec![ProviderConfig {
            id: "p1".into(),
            name: "本地中转".into(),
            base_url: "https://example.invalid/v1".into(),
            api_key: "sk-test".into(),
            models: vec!["test-model".into(), "test-model-2".into()],
            api: ProviderApi::OpenAi,
            model: None,
        }],
        active_provider_id: Some("p1".into()),
        active_model: Some("test-model".into()),
        rhythm_ms_per_char: 120,
        punct_pause_enabled: false,
        anim_duration_base: 300,
        ui_language: "zh".into(),
        ui_theme: "light".into(),
        director_model: Some("director-model".into()),
        near_scenes: 4,
        system_prompt: "用中文写短句".into(),
        temperature: 0.8,
        top_p: 1.0,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
    };
    store.save(&config).unwrap();

    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n != CONFIG_FILE_NAME)
        .collect();
    assert!(leftovers.is_empty(), "不应残留临时文件：{leftovers:?}");

    assert_eq!(store.load().unwrap(), config, "保存后重读内容一致");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 验收 4：rhythm 越界（<10 或 >160）读取与保存都拒绝；边界值 10/160 放行。
#[test]
fn rhythm_out_of_range_rejected() {
    let dir = temp_dir("range");
    let store = store_in(&dir);
    for bad in [0u32, 5, 161, 999] {
        std::fs::write(store.path(), format!(r#"{{"rhythm_ms_per_char": {bad}}}"#)).unwrap();
        let err = store.load().unwrap_err();
        assert!(
            matches!(err, ConfigError::Invalid(_)),
            "{bad} 应越界拒绝，实际：{err:?}"
        );
    }
    for good in [10u32, 45, 160] {
        std::fs::write(store.path(), format!(r#"{{"rhythm_ms_per_char": {good}}}"#)).unwrap();
        assert_eq!(store.load().unwrap().rhythm_ms_per_char, good);
    }
    // 保存路径同样先校验：越界配置不允许落盘。
    let bad = Config {
        rhythm_ms_per_char: 200,
        ..Config::new_with_defaults()
    };
    let err = store.save(&bad).unwrap_err();
    assert!(matches!(err, ConfigError::Invalid(_)), "实际：{err:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 验收 4 / INT-003：director_model 缺省（None 或空串）跟随主模型
/// （active (provider, model) 二元组）；非空则用自身。
#[test]
fn director_model_defaults_to_main_model() {
    let provider = ProviderConfig {
        id: "p1".into(),
        name: "主".into(),
        base_url: "https://example.invalid/v1".into(),
        api_key: "sk".into(),
        models: vec!["main-model".into(), "second-model".into()],
        api: ProviderApi::OpenAi,
        model: None,
    };
    let base = Config {
        providers: vec![provider],
        active_provider_id: Some("p1".into()),
        active_model: None,
        ..Config::new_with_defaults()
    };

    // 缺省 None → 跟随主模型（active_model 未选回落第一个模型）。
    assert_eq!(base.effective_director_model(), Some("main-model"));
    // 空串同样视为「跟随主模型」。
    let empty = Config {
        director_model: Some(String::new()),
        ..base.clone()
    };
    assert_eq!(empty.effective_director_model(), Some("main-model"));
    // active_model 选中第二个模型 → 跟随之。
    let second = Config {
        active_model: Some("second-model".into()),
        ..base.clone()
    };
    assert_eq!(second.effective_director_model(), Some("second-model"));
    // 显式指定 → 用指定值。
    let explicit = Config {
        director_model: Some("director-only".into()),
        ..base.clone()
    };
    assert_eq!(explicit.effective_director_model(), Some("director-only"));
    // 未配置任何主模型 → 无可用导演模型。
    let bare = Config::new_with_defaults();
    assert_eq!(bare.effective_director_model(), None);
}

/// 双层级迁移（2026-09-09）：旧单模型格式（providers[].model，无 models 键）
/// load 时迁入 models、legacy 键清空；保存只写新形态（不再出现 "model" 键）。
#[test]
fn legacy_model_json_migrates_into_models() {
    let dir = temp_dir("legacy");
    let store = store_in(&dir);
    std::fs::write(
        store.path(),
        r#"{
                "providers": [{
                    "id": "p1",
                    "name": "旧格式",
                    "base_url": "https://example.invalid/v1",
                    "api_key": "sk",
                    "model": "old-model"
                }],
                "active_provider_id": "p1"
            }"#,
    )
    .unwrap();
    let config = store.load().unwrap();
    assert_eq!(config.providers[0].models, vec![ModelSpec::from_id("old-model")]);
    assert_eq!(config.providers[0].model, None, "legacy 键迁移后清空");
    assert_eq!(config.active_model, None, "旧文件无 active_model → 缺省");

    // active_model 越界回落第一个模型。
    assert_eq!(
        config.active_selection().map(|(_, m)| m.to_string()),
        Some("old-model".to_string())
    );

    // 保存只写新形态：JSON 中不再出现 legacy "model" 键。
    let provider = config.providers[0].clone();
    store.save(&config).unwrap();
    let on_disk = std::fs::read_to_string(store.path()).unwrap();
    assert!(on_disk.contains("\"models\""), "新形态落盘：{on_disk}");
    assert!(
        !on_disk.contains("\"model\""),
        "legacy 键不再写出：{on_disk}"
    );
    assert_eq!(store.load().unwrap().providers[0], provider);
    let _ = std::fs::remove_dir_all(&dir);
}

/// models 元数据化的向后兼容（2026-09-14）：旧字符串数组 → ModelSpec（id 迁入、
/// 元数据取缺省 1M / 128K / 仅文本）；新对象数组原样载入。未发布应用无存量
/// 迁移义务，此兼容仅为免手改本地 config.json。
#[test]
fn legacy_string_models_and_object_models_both_load() {
    let dir = temp_dir("string-models");
    let store = store_in(&dir);
    std::fs::write(
        store.path(),
        r#"{
                "providers": [{
                    "id": "p1",
                    "name": "旧字符串数组",
                    "base_url": "https://example.invalid/v1",
                    "api_key": "sk",
                    "models": ["deepseek-chat", "deepseek-reasoner"]
                }],
                "active_provider_id": "p1",
                "active_model": "deepseek-reasoner"
            }"#,
    )
    .unwrap();
    let config = store.load().unwrap();
    assert_eq!(
        config.providers[0].models,
        vec![ModelSpec::from_id("deepseek-chat"), ModelSpec::from_id("deepseek-reasoner")]
    );
    assert_eq!(
        config.active_selection().map(|(_, m)| m.to_string()),
        Some("deepseek-reasoner".to_string())
    );
    let _ = std::fs::remove_dir_all(&dir);

    // 新对象数组：元数据原样保留（含非缺省值）。
    let dir = temp_dir("object-models");
    let store = store_in(&dir);
    std::fs::write(
        store.path(),
        r#"{
                "providers": [{
                    "id": "p1",
                    "name": "对象数组",
                    "base_url": "https://example.invalid/v1",
                    "api_key": "sk",
                    "models": [{
                        "id": "vision-model",
                        "context_window": 256000,
                        "max_output_tokens": 8192,
                        "input_types": ["text", "image"],
                        "output_types": ["text"]
                    }]
                }]
            }"#,
    )
    .unwrap();
    let config = store.load().unwrap();
    assert_eq!(
        config.providers[0].models,
        vec![ModelSpec {
            id: "vision-model".into(),
            context_window: 256_000,
            max_output_tokens: 8_192,
            input_types: vec![ModelModality::Text, ModelModality::Image],
            output_types: vec![ModelModality::Text],
        }]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// 双层级解析：active_model 选中/越界/缺省三分支，provider 无模型 → None。
#[test]
fn active_selection_resolution_and_fallback() {
    let provider = ProviderConfig {
        id: "p1".into(),
        name: "主".into(),
        base_url: "https://example.invalid/v1".into(),
        api_key: "sk".into(),
        models: vec!["m1".into(), "m2".into()],
        api: ProviderApi::OpenAi,
        model: None,
    };
    let base = Config {
        providers: vec![provider],
        active_provider_id: Some("p1".into()),
        active_model: None,
        ..Config::new_with_defaults()
    };
    // 缺省 → 第一个模型。
    assert_eq!(
        base.active_selection().map(|(_, m)| m.to_string()),
        Some("m1".to_string())
    );
    // 显式选中 → 该模型。
    let picked = Config {
        active_model: Some("m2".into()),
        ..base.clone()
    };
    assert_eq!(
        picked.active_selection().map(|(_, m)| m.to_string()),
        Some("m2".to_string())
    );
    // 越界/空串 → 回落第一个模型。
    for stale in [Some("stale".to_string()), Some(String::new())] {
        let c = Config {
            active_model: stale,
            ..base.clone()
        };
        assert_eq!(
            c.active_selection().map(|(_, m)| m.to_string()),
            Some("m1".to_string())
        );
    }
    // 悬空 provider id → 未选择。
    let dangling = Config {
        active_provider_id: Some("ghost".into()),
        ..base.clone()
    };
    assert_eq!(dangling.active_selection(), None);
    // provider 无任何模型 → None。
    let mut no_models = base.clone();
    no_models.providers[0].models.clear();
    assert_eq!(no_models.active_selection(), None);
}

/// 验收 5：读取路径不缓存——保存（含外部手写）后立即可读到新值。
#[test]
fn reload_picks_up_external_edit() {
    let dir = temp_dir("nocache");
    let store = store_in(&dir);
    assert_eq!(store.load().unwrap().ui_theme, "system");
    std::fs::write(store.path(), r#"{"ui_theme": "dark"}"#).unwrap();
    assert_eq!(store.load().unwrap().ui_theme, "dark", "外部手改立即生效");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 近景场景数（ADR-004 窗口可选化）：旧 config.json 无此键 → serde 缺省 2
/// （零迁移兼容）；越界（0 / 7）读取与保存都拒绝（从众 rhythm 的校验风格，
/// 不静默钳边）；边界值 1 / 6 放行。
#[test]
fn near_scenes_defaults_and_range_rejected() {
    let dir = temp_dir("near");
    let store = store_in(&dir);
    // 缺键 → 默认 2（旧 config.json 兼容）。
    std::fs::write(store.path(), r#"{"ui_theme": "dark"}"#).unwrap();
    assert_eq!(store.load().unwrap().near_scenes, 2, "缺键补默认");
    // 边界值放行。
    for good in [1u32, 6] {
        std::fs::write(store.path(), format!(r#"{{"near_scenes": {good}}}"#)).unwrap();
        assert_eq!(store.load().unwrap().near_scenes, good);
    }
    // 越界读取拒绝（快速失败，不静默归一）。
    for bad in [0u32, 7, 999] {
        std::fs::write(store.path(), format!(r#"{{"near_scenes": {bad}}}"#)).unwrap();
        let err = store.load().unwrap_err();
        assert!(
            matches!(err, ConfigError::Invalid(_)),
            "{bad} 应越界拒绝，实际：{err:?}"
        );
        assert!(err.to_string().contains("near_scenes"), "错误可读：{err}");
    }
    // 越界保存同样拒绝（save 前先 validate），文件保持上次内容（上轮写入的
    // 999 仍是坏值 → 再读仍是 Invalid，证明 7 未被落盘）。
    let bad = Config {
        near_scenes: 7,
        ..Config::new_with_defaults()
    };
    let err = store.save(&bad).unwrap_err();
    assert!(matches!(err, ConfigError::Invalid(_)), "实际：{err:?}");
    assert!(matches!(store.load().unwrap_err(), ConfigError::Invalid(_)));
    let _ = std::fs::remove_dir_all(&dir);
}

/// 采样温度（0–2）：缺键 → serde 缺省 0.7（旧 config.json 零迁移兼容）；越界
/// 读取与保存都拒绝（从众 rhythm 的校验风格，不静默钳边）；边界值 0.0 / 2.0 放行。
#[test]
fn temperature_defaults_and_range_rejected() {
    let dir = temp_dir("temp");
    let store = store_in(&dir);
    // 缺键 → 默认 0.7（旧 config.json 兼容）。
    std::fs::write(store.path(), r#"{"ui_theme": "dark"}"#).unwrap();
    let loaded = store.load().unwrap();
    assert_eq!(loaded.temperature, 0.7, "缺键补默认");
    // 边界值放行。
    for good in [0.0, 0.7, 2.0] {
        std::fs::write(store.path(), format!(r#"{{"temperature": {good}}}"#)).unwrap();
        assert_eq!(store.load().unwrap().temperature, good);
    }
    // 越界读取拒绝（快速失败，不静默归一）。
    for bad in [-0.1, 2.1, 99.0] {
        std::fs::write(store.path(), format!(r#"{{"temperature": {bad}}}"#)).unwrap();
        let err = store.load().unwrap_err();
        assert!(
            matches!(err, ConfigError::Invalid(_)),
            "{bad} 应越界拒绝，实际：{err:?}"
        );
        assert!(err.to_string().contains("temperature"), "错误可读：{err}");
    }
    // 越界保存同样拒绝（save 前先 validate）。
    let bad = Config {
        temperature: 2.5,
        top_p: 1.0,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
        ..Config::new_with_defaults()
    };
    let err = store.save(&bad).unwrap_err();
    assert!(matches!(err, ConfigError::Invalid(_)), "实际：{err:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 采样参数三键（2026-09-16）：top_p（0–1）与惩罚（−2–2）缺键 → serde 缺省
///（1.0 / 0 / 0，旧 config.json 零迁移兼容，同 temperature 口径）；越界读取
/// 与保存都拒绝（快速失败，不静默钳边）。
#[test]
fn sampling_top_p_and_penalties_defaults_and_ranges_rejected() {
    let dir = temp_dir("sampling");
    let store = store_in(&dir);
    // 缺键 → 默认（旧 config.json 兼容）。
    std::fs::write(store.path(), r#"{"ui_theme": "dark"}"#).unwrap();
    let loaded = store.load().unwrap();
    assert_eq!(loaded.top_p, 1.0, "缺键补默认");
    assert_eq!(loaded.frequency_penalty, 0.0, "缺键补默认");
    assert_eq!(loaded.presence_penalty, 0.0, "缺键补默认");
    // 边界值放行。
    std::fs::write(
        store.path(),
        r#"{"top_p": 1.0, "frequency_penalty": -2.0, "presence_penalty": 2.0}"#,
    )
    .unwrap();
    let loaded = store.load().unwrap();
    assert_eq!(loaded.top_p, 1.0);
    assert_eq!(loaded.frequency_penalty, -2.0);
    assert_eq!(loaded.presence_penalty, 2.0);
    // 越界读取拒绝（三键各取一例，错误信息可读）。
    for bad in [
        r#"{"top_p": 1.5}"#,
        r#"{"top_p": -0.1}"#,
        r#"{"frequency_penalty": -2.5}"#,
        r#"{"presence_penalty": 2.5}"#,
    ] {
        std::fs::write(store.path(), bad).unwrap();
        let err = store.load().unwrap_err();
        assert!(
            matches!(err, ConfigError::Invalid(_)),
            "{bad} 应越界拒绝，实际：{err:?}"
        );
    }
    // 越界保存同样拒绝（save 前先 validate）。
    let bad = Config {
        top_p: -0.1,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
        ..Config::new_with_defaults()
    };
    let err = store.save(&bad).unwrap_err();
    assert!(matches!(err, ConfigError::Invalid(_)), "实际：{err:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 全局系统提示词（2026-09-15）：缺键 → serde 缺省空串（旧 config.json 零迁移兼容，
/// 空串 = 不注入）；自由文本不校验，长文本落盘往返无损。
#[test]
fn system_prompt_defaults_empty_and_roundtrips() {
    let dir = temp_dir("sysprompt");
    let store = store_in(&dir);
    // 缺键 → 空串（旧 config.json 兼容）。
    std::fs::write(store.path(), r#"{"ui_theme": "dark"}"#).unwrap();
    let loaded = store.load().unwrap();
    assert_eq!(loaded.system_prompt, "", "缺键补空串");
    // 多行文本往返无损。
    let config = Config {
        system_prompt: "用中文写短句。\n保持冷峻克制的文风。".into(),
        ..Config::new_with_defaults()
    };
    store.save(&config).unwrap();
    assert_eq!(store.load().unwrap().system_prompt, config.system_prompt);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Provider.api（2026-09-14 三协议）：缺键回落 openai（旧 config.json 零迁移兼容）、
/// 三值 JSON 往返无损、未知值 load 报 ConfigError::Parse 快速失败（ADR-012 坏文件
/// 语义，不静默回落默认协议）。
#[test]
fn provider_api_defaults_roundtrips_and_rejects_unknown() {
    // wire 值形态：snake_case 三值往返。
    for (api, wire) in [
        (ProviderApi::OpenAi, "openai"),
        (ProviderApi::Anthropic, "anthropic"),
        (ProviderApi::OpenAiResponses, "openai_responses"),
    ] {
        let json = serde_json::to_string(&api).unwrap();
        assert_eq!(json, format!(r#""{wire}""#), "wire 值 {wire}");
        assert_eq!(serde_json::from_str::<ProviderApi>(&json).unwrap(), api);
    }

    // 缺键 → 缺省 openai（serde default，无文件/旧文件兼容）。
    let dir = temp_dir("api_default");
    let store = store_in(&dir);
    std::fs::write(
        store.path(),
        r#"{"providers": [{"id": "p1", "base_url": "https://example.invalid/v1"}]}"#,
    )
    .unwrap();
    let config = store.load().unwrap();
    assert_eq!(config.providers.len(), 1);
    assert_eq!(config.providers[0].api, ProviderApi::OpenAi, "缺 api 键回落 openai");

    // 三值落盘往返：load 读回的 api 与写入一致。
    let mut config = Config::new_with_defaults();
    config.providers = vec![
        ProviderConfig {
            id: "p1".into(),
            name: "OpenAI 兼容".into(),
            base_url: "https://a.example.invalid/v1".into(),
            api_key: "k".into(),
            models: vec!["m".into()],
            api: ProviderApi::OpenAi,
            model: None,
        },
        ProviderConfig {
            id: "p2".into(),
            name: "Claude".into(),
            base_url: "https://b.example.invalid".into(),
            api_key: "k".into(),
            models: vec!["m".into()],
            api: ProviderApi::Anthropic,
            model: None,
        },
        ProviderConfig {
            id: "p3".into(),
            name: "Responses".into(),
            base_url: "https://c.example.invalid/v1".into(),
            api_key: "k".into(),
            models: vec!["m".into()],
            api: ProviderApi::OpenAiResponses,
            model: None,
        },
    ];
    store.save(&config).unwrap();
    assert_eq!(store.load().unwrap().providers, config.providers, "三值往返无损");
    let _ = std::fs::remove_dir_all(&dir);

    // 未知值 → Parse 快速失败（不静默回落 openai）。
    let dir = temp_dir("api_unknown");
    let store = store_in(&dir);
    std::fs::write(
        store.path(),
        r#"{"providers": [{"id": "p1", "api": "gemini"}]}"#,
    )
    .unwrap();
    let err = store.load().unwrap_err();
    assert!(matches!(err, ConfigError::Parse { .. }), "未知协议应坏文件拒绝：{err:?}");
    let _ = std::fs::remove_dir_all(&dir);
}
