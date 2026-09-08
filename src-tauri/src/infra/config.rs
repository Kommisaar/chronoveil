//! config.rs（TASK-003 / ADR-012 / FR-009）：`~/.chronoveil/config.json` 的装载与原子写。
//!
//! 语义约定：
//! - 文件不存在 → 全默认值（不报错，FR-009「不写配置文件也能用起来」）；
//! - 存在 → serde 解析 + 缺省合并（缺键补默认、未知键忽略）；坏文件快速失败并给出
//!   可读错误，不静默重置（ADR-012）；
//! - 保存 = 校验 + 写同目录临时文件 + 原子改名（中断不产生半写 config.json，ADR-012）；
//! - 读取路径每次读当次值、不长期缓存——改完即生效，含外部手改（ADR-012）。
//!   因此 [`ConfigStore`] 只持有路径，不持有 [`Config`]；消费方（TASK-005 命令层）
//!   每次经 `state.config.load()` 取当次值。
//!
//! 键清单以 FR-009 rev10 为准（含 `ui_theme`；ADR-012 键清单未列该键，以 FR-009 为准）。
//! `director_model`：ADR-012 键清单含此键；FR-009 rev10 已移除导演专用模型配置项，
//! 语义为「空 = 跟随主模型」（INT-003），故保留为可选键、缺省 None。

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 配置文件名（与 chronoveil.db 同住应用主目录，ADR-012）。
pub const CONFIG_FILE_NAME: &str = "config.json";

/// 打字节奏允许范围（ms/字，FR-009：10–160，默认 45）。
pub const RHYTHM_MS_MIN: u32 = 10;
pub const RHYTHM_MS_MAX: u32 = 160;

/// 打字节奏默认值（FR-009）。
pub const DEFAULT_RHYTHM_MS_PER_CHAR: u32 = 45;
/// 动效时长基准默认值（FR-009）。
pub const DEFAULT_ANIM_DURATION_BASE_MS: u32 = 450;

/// 单套 LLM Provider（OpenAI 兼容，FR-009；密钥明文本机，OQ-001 已决）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
}

/// 应用配置（键与类型见 TASK-003 / FR-009 / ADR-012）。
/// 容器级 `#[serde(default)]`：缺键一律回落到 `Config::default()`；未知键 serde 默认忽略。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// 多套 Provider（FR-009「可存多套」）。
    pub providers: Vec<ProviderConfig>,
    /// 全局默认模型指向的 provider id；空 = 未选择（FR-009「全局默认模型」）。
    pub active_provider_id: Option<String>,
    /// 打字节奏 ms/字（10–160，默认 45，FR-009）。
    pub rhythm_ms_per_char: u32,
    /// 标点微停开关（默认 true，FR-009）。
    pub punct_pause_enabled: bool,
    /// 动效时长基准 ms（默认 450，FR-009）。
    pub anim_duration_base: u32,
    /// 界面语言（默认 zh，ADR-011）。
    pub ui_language: String,
    /// 界面主题 system / light / dark（默认 system，FR-009 rev10；ADR-012 键清单未列，以 FR-009 为准）。
    pub ui_theme: String,
    /// 导演专用模型（ADR-012 键清单含；空 = 跟随主模型，INT-003）。
    pub director_model: Option<String>,
}

impl Default for Config {
    /// 默认值唯一出口：serde 缺键合并与「无文件全默认」共用 `new_with_defaults`。
    fn default() -> Self {
        Self::new_with_defaults()
    }
}

impl Config {
    /// 手写默认值（显式列出，便于对照设计文档核对）。
    pub fn new_with_defaults() -> Self {
        Self {
            providers: Vec::new(),
            active_provider_id: None,
            rhythm_ms_per_char: DEFAULT_RHYTHM_MS_PER_CHAR,
            punct_pause_enabled: true,
            anim_duration_base: DEFAULT_ANIM_DURATION_BASE_MS,
            ui_language: "zh".into(),
            ui_theme: "system".into(),
            director_model: None,
        }
    }

    /// 值域校验：目前仅 rhythm_ms_per_char 有设计规定的范围（FR-009：10–160）。
    pub fn validate(&self) -> Result<(), ConfigError> {
        if !(RHYTHM_MS_MIN..=RHYTHM_MS_MAX).contains(&self.rhythm_ms_per_char) {
            return Err(ConfigError::Invalid(format!(
                "rhythm_ms_per_char = {} 越界（允许 {}–{}）",
                self.rhythm_ms_per_char, RHYTHM_MS_MIN, RHYTHM_MS_MAX
            )));
        }
        Ok(())
    }

    /// 当前生效的全局默认 Provider（active_provider_id 指向者；悬空 id 视为未选择）。
    // 消费方在 TASK-005（IPC 命令层 / 生成调用）接线后出现；测试已覆盖语义。
    #[allow(dead_code)]
    pub fn active_provider(&self) -> Option<&ProviderConfig> {
        let id = self.active_provider_id.as_deref()?;
        self.providers.iter().find(|p| p.id == id)
    }

    /// 导演调用模型解析（INT-003）：`director_model` 非空用之；否则跟随主模型
    /// （active provider 的 model）。均未配置 → None（调用方再报「未配置模型」）。
    // 消费方在 TASK-005 / 导演服务接线后出现；测试已覆盖语义。
    #[allow(dead_code)]
    pub fn effective_director_model(&self) -> Option<&str> {
        let explicit = self
            .director_model
            .as_deref()
            .filter(|s| !s.trim().is_empty());
        if let Some(m) = explicit {
            return Some(m);
        }
        self.active_provider()
            .map(|p| p.model.as_str())
            .filter(|m| !m.trim().is_empty())
    }
}

/// 配置读写错误（TASK-003 验收 2/3：坏文件可读错误、写失败不落半写文件）。
#[derive(Debug)]
pub enum ConfigError {
    /// config.json 存在但解析失败（坏 JSON / 字段类型不符 / 非 UTF-8）。
    /// 快速失败并提示，不静默重置（ADR-012）。
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
    /// 语法合法但值越界等校验失败。
    Invalid(String),
    /// 保存时序列化失败（当前字段类型理论不可失败，防御保留）。
    #[allow(dead_code)]
    Serialize(serde_json::Error),
    /// 文件读写失败。
    Io(std::io::Error),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::Parse { path, source } => write!(
                f,
                "配置文件 {} 解析失败（坏文件不静默重置，请修复或删除后重试）：{source}",
                path.display()
            ),
            ConfigError::Invalid(msg) => write!(f, "配置校验失败：{msg}"),
            ConfigError::Serialize(e) => write!(f, "配置序列化失败：{e}"),
            ConfigError::Io(e) => write!(f, "配置文件读写失败：{e}"),
        }
    }
}

impl std::error::Error for ConfigError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ConfigError::Parse { source, .. } | ConfigError::Serialize(source) => Some(source),
            ConfigError::Invalid(_) => None,
            ConfigError::Io(e) => Some(e),
        }
    }
}

impl From<std::io::Error> for ConfigError {
    fn from(e: std::io::Error) -> Self {
        ConfigError::Io(e)
    }
}

/// 配置文件存取句柄：只持路径，不缓存内容（ADR-012「读当次值不缓存」）。
#[derive(Debug, Clone)]
pub struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    /// 指向 `<app_home>/config.json`（ADR-012 布局）。
    pub fn in_app_home(app_home: &Path) -> Self {
        Self {
            path: app_home.join(CONFIG_FILE_NAME),
        }
    }

    /// 自定义路径（测试注入临时目录用）。
    #[allow(dead_code)]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// 当前配置文件路径（诊断 / 展示用）。
    // 消费方在 TASK-005 接线后出现；测试已覆盖。
    #[allow(dead_code)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 读取当次配置：缺文件 → 全默认；缺键 → 补默认；未知键 → 忽略；
    /// 坏文件 → [`ConfigError::Parse`] 快速失败。每次调用都重新读盘，不缓存。
    pub fn load(&self) -> Result<Config, ConfigError> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            // 文件不存在 = 未配置过，全默认值，不报错（FR-009）。
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Config::default()),
            Err(e) => return Err(e.into()),
        };
        let config = serde_json::from_slice::<Config>(&bytes).map_err(|source| {
            ConfigError::Parse {
                path: self.path.clone(),
                source,
            }
        })?;
        config.validate()?;
        Ok(config)
    }

    /// 保存配置：先校验，再写同目录临时文件并刷盘，最后原子改名覆盖目标
    /// （同目录同卷 rename；任一步失败则清理临时文件，config.json 保持上一次完整内容）。
    pub fn save(&self, config: &Config) -> Result<(), ConfigError> {
        config.validate()?;
        let json =
            serde_json::to_string_pretty(config).map_err(ConfigError::Serialize)?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = tmp_sibling(&self.path);
        let outcome = (|| -> std::io::Result<()> {
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(json.as_bytes())?;
            file.sync_all()?; // 临时文件先落盘，再改名
            drop(file);
            std::fs::rename(&tmp, &self.path)?; // 原子替换（Windows 下覆盖已存在目标）
            Ok(())
        })();
        if let Err(e) = outcome {
            let _ = std::fs::remove_file(&tmp); // 不留残缺临时文件
            return Err(ConfigError::Io(e));
        }
        Ok(())
    }
}

/// 同目录同名 + `.tmp` 后缀：保证与目标同卷，rename 才是原子操作。
fn tmp_sibling(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map_or_else(|| CONFIG_FILE_NAME.to_string(), |n| n.to_string_lossy().into_owned());
    path.with_file_name(format!("{name}.tmp"))
}

#[cfg(test)]
mod tests {
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
        assert_eq!(config.rhythm_ms_per_char, 45);
        assert!(config.punct_pause_enabled);
        assert_eq!(config.anim_duration_base, 450);
        assert_eq!(config.ui_language, "zh");
        assert_eq!(config.ui_theme, "system");
        assert_eq!(config.director_model, None);
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
        assert_eq!(config.punct_pause_enabled, true, "缺键补默认");
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
        assert!(err.to_string().contains("不静默重置"), "错误信息需可读：{err}");

        std::fs::write(store.path(), r#"{"rhythm_ms_per_char": "fast"}"#).unwrap();
        let err = store.load().unwrap_err();
        assert!(matches!(err, ConfigError::Parse { .. }), "类型不符也是坏文件：{err:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 验收 3：原子写往返——保存后重新读取内容一致；目录内不留 `.tmp` 残件。
    #[test]
    fn save_load_roundtrip_and_no_tmp_leftover() {
        let dir = temp_dir("roundtrip");
        let store = store_in(&dir);
        let config = Config {
            providers: vec![ProviderConfig {
                id: "p1".into(),
                name: "本地中转".into(),
                base_url: "https://example.invalid/v1".into(),
                api_key: "sk-test".into(),
                model: "test-model".into(),
            }],
            active_provider_id: Some("p1".into()),
            rhythm_ms_per_char: 120,
            punct_pause_enabled: false,
            anim_duration_base: 300,
            ui_language: "zh".into(),
            ui_theme: "light".into(),
            director_model: Some("director-model".into()),
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
            std::fs::write(
                store.path(),
                format!(r#"{{"rhythm_ms_per_char": {bad}}}"#),
            )
            .unwrap();
            let err = store.load().unwrap_err();
            assert!(
                matches!(err, ConfigError::Invalid(_)),
                "{bad} 应越界拒绝，实际：{err:?}"
            );
        }
        for good in [10u32, 45, 160] {
            std::fs::write(
                store.path(),
                format!(r#"{{"rhythm_ms_per_char": {good}}}"#),
            )
            .unwrap();
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

    /// 验收 4 / INT-003：director_model 缺省（None 或空串）跟随主模型；非空则用自身。
    #[test]
    fn director_model_defaults_to_main_model() {
        let provider = ProviderConfig {
            id: "p1".into(),
            name: "主".into(),
            base_url: "https://example.invalid/v1".into(),
            api_key: "sk".into(),
            model: "main-model".into(),
        };
        let base = Config {
            providers: vec![provider],
            active_provider_id: Some("p1".into()),
            ..Config::new_with_defaults()
        };

        // 缺省 None → 跟随主模型。
        assert_eq!(base.effective_director_model(), Some("main-model"));
        // 空串同样视为「跟随主模型」。
        let empty = Config {
            director_model: Some(String::new()),
            ..base.clone()
        };
        assert_eq!(empty.effective_director_model(), Some("main-model"));
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
}
