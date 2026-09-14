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

use crate::infra::llm::ProviderApi;

/// 配置文件名（与 chronoveil.db 同住应用主目录，ADR-012）。
pub const CONFIG_FILE_NAME: &str = "config.json";

/// 打字节奏允许范围（ms/字，FR-009：10–160，默认 45）。
/// 与 TS 常量互指（同一约束两端）：`src/features/settings/preferences.ts` 的 `RHYTHM_MIN` / `RHYTHM_MAX`（经 `src/engine/index.ts` 的 `RHYTHM_MIN_MS` / `RHYTHM_MAX_MS` 单一源）。
pub const RHYTHM_MS_MIN: u32 = 10;
pub const RHYTHM_MS_MAX: u32 = 160;

/// 打字节奏默认值（FR-009）。
pub const DEFAULT_RHYTHM_MS_PER_CHAR: u32 = 45;

/// 出场动画风格默认值（2026-09-14 角色卡风格「跟随全局」语义的全局端）。
/// 与 TS 引擎单一事实源同源：`src/engine/anims/index.ts` 的 ANIM_STYLES（'type' 打字机）。
pub const DEFAULT_RENDER_STYLE: &str = "type";

/// 近景场景数允许范围（ADR-004 近景窗口可选化：1 场省 token – 6 场更多逐字上下文）。
/// 与 TS 常量互指（同一约束两端）：`src/features/settings/preferences.ts` 的 `NEAR_SCENES_MIN` / `NEAR_SCENES_MAX` 单一源（api/mock/config.ts 按 api 层不可反向 import 纪律以字面量+注释对齐）。
pub const NEAR_SCENES_MIN: u32 = 1;
pub const NEAR_SCENES_MAX: u32 = 6;

/// 近景场景数默认值（ADR-004 §7.8 原窗口：最近 2 个已结算场整场）。
pub const DEFAULT_NEAR_SCENES: u32 = 2;

/// serde 缺键回落（`#[serde(default = ...)]` 入口；与 [`DEFAULT_NEAR_SCENES`] 同源）。
fn default_near_scenes() -> u32 {
    DEFAULT_NEAR_SCENES
}
/// 动效时长基准默认值（FR-009）。
pub const DEFAULT_ANIM_DURATION_BASE_MS: u32 = 450;

/// 单套 LLM Provider（FR-009；密钥明文本机，OQ-001 已决）。
/// 双层级（2026-09-09）：一个 provider 提供多个 model（`models`，模型名字符串
/// 即身份）；`model` 是旧单模型格式的兼容落点——load 时迁移进 `models` 后清空，
/// 保存不再写出（skip_serializing_if）。
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
    /// 该服务可用的模型名列表（至少一个才能用于生成，解析层兜底校验）。
    #[serde(default)]
    pub models: Vec<String>,
    /// API 兼容协议（2026-09-14 三选一）：缺省 openai——旧 config.json 无此键
    /// 零迁移兼容；未知值 serde 反序列化失败 → load 报 [`ConfigError::Parse`]
    /// 快速失败（ADR-012 坏文件语义，不静默回落默认协议）。协议是 provider 级
    /// 属性（同一服务根地址下所有模型共用一种 API 形态），不随角色覆写走。
    #[serde(default)]
    pub api: ProviderApi,
    /// 旧单模型格式遗留键：仅用于反序列化接住旧 config.json，迁移后恒为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl ProviderConfig {
    /// 旧格式迁移 + 规范化（幂等）：`model` 搬入 `models`（去首尾空白、丢空串），
    /// 迁移后 legacy 键清空。load/save 前都会走一遍。
    pub fn migrated(mut self) -> Self {
        if let Some(legacy) = self.model.take() {
            let legacy = legacy.trim();
            if !legacy.is_empty() && !self.models.iter().any(|m| m == legacy) {
                self.models.push(legacy.into());
            }
        }
        self.models = self
            .models
            .iter()
            .map(|m| m.trim())
            .filter(|m| !m.is_empty())
            .map(|m| m.to_string())
            .collect();
        self
    }
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
    /// 全局默认模型名（双层级 2026-09-09：active_provider_id 的 models 之一；
    /// 越界/空回落该 provider 的第一个模型，见 [`Config::active_selection`]）。
    pub active_model: Option<String>,
    /// 打字节奏 ms/字（10–160，默认 45，FR-009）。
    pub rhythm_ms_per_char: u32,
    /// 标点微停开关（默认 true，FR-009）。
    pub punct_pause_enabled: bool,
    /// 动效时长基准 ms（默认 450，FR-009）。
    pub anim_duration_base: u32,
    /// 全局出场动画风格（2026-09-14）：角色卡 render_style 为 NULL 时聊天演出
    /// 回落到此值。18 风格之一由设置页下拉约束（与卡同语义：自由串，引擎对
    /// 表外串回落 fade）。
    pub render_style: String,
    /// 界面语言（默认 zh，ADR-011）。
    pub ui_language: String,
    /// 界面主题 system / light / dark（默认 system，FR-009 rev10；ADR-012 键清单未列，以 FR-009 为准）。
    pub ui_theme: String,
    /// 导演专用模型（ADR-012 键清单含；空 = 跟随主模型，INT-003）。
    pub director_model: Option<String>,
    /// 近景场景数（ADR-004 近景窗口可选化：最近 N 个已结算场整场进近景，
    /// 1–6，默认 2；旧 config.json 无此键零迁移兼容）。装配消费点：
    /// services/prompt::AssembleInputs（经 generation 穿参）。
    #[serde(default = "default_near_scenes")]
    pub near_scenes: u32,
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
            active_model: None,
            rhythm_ms_per_char: DEFAULT_RHYTHM_MS_PER_CHAR,
            punct_pause_enabled: true,
            anim_duration_base: DEFAULT_ANIM_DURATION_BASE_MS,
            render_style: DEFAULT_RENDER_STYLE.into(),
            ui_language: "zh".into(),
            ui_theme: "system".into(),
            director_model: None,
            near_scenes: DEFAULT_NEAR_SCENES,
        }
    }

    /// 值域校验：rhythm_ms_per_char（FR-009：10–160）与 near_scenes（1–6）
    /// 有设计规定的范围；越界快速失败（ConfigError::Invalid），不做静默钳边。
    pub fn validate(&self) -> Result<(), ConfigError> {
        if !(RHYTHM_MS_MIN..=RHYTHM_MS_MAX).contains(&self.rhythm_ms_per_char) {
            return Err(ConfigError::Invalid(format!(
                "rhythm_ms_per_char = {} 越界（允许 {}–{}）",
                self.rhythm_ms_per_char, RHYTHM_MS_MIN, RHYTHM_MS_MAX
            )));
        }
        if !(NEAR_SCENES_MIN..=NEAR_SCENES_MAX).contains(&self.near_scenes) {
            return Err(ConfigError::Invalid(format!(
                "near_scenes = {} 越界（允许 {}–{}）",
                self.near_scenes, NEAR_SCENES_MIN, NEAR_SCENES_MAX
            )));
        }
        Ok(())
    }

    /// 当前生效的全局默认 Provider（active_provider_id 指向者；悬空 id 视为未选择）。
    /// 消费方：生成编排（services/generation，TASK-006）的两级模型配置解析。
    pub fn active_provider(&self) -> Option<&ProviderConfig> {
        let id = self.active_provider_id.as_deref()?;
        self.providers.iter().find(|p| p.id == id)
    }

    /// 当前生效的全局默认 (provider, model) 二元组（双层级 2026-09-09）：
    /// active_model 在该 provider 的 models 里则用之，否则回落第一个模型；
    /// provider 未选/悬空或没有任何模型 → None（调用方报「未配置」级错误）。
    pub fn active_selection(&self) -> Option<(&ProviderConfig, &str)> {
        let provider = self.active_provider()?;
        let explicit = self
            .active_model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty() && provider.models.iter().any(|x| x == m));
        let model = explicit.or_else(|| provider.models.first().map(String::as_str))?;
        Some((provider, model))
    }

    /// 导演调用模型解析（INT-003）：`director_model` 非空用之；否则跟随主模型
    /// （active (provider, model) 二元组，双层级 2026-09-09）。均未配置 → None
    /// （调用方再报「未配置模型」）。
    pub fn effective_director_model(&self) -> Option<&str> {
        let explicit = self
            .director_model
            .as_deref()
            .filter(|s| !s.trim().is_empty());
        if let Some(m) = explicit {
            return Some(m);
        }
        self.active_selection()
            .map(|(_, m)| m)
            .filter(|m| !m.trim().is_empty())
    }

    /// 对全部 provider 做旧格式迁移 + 规范化（幂等；load/save 前调用）。
    fn migrate_legacy(&mut self) {
        self.providers = std::mem::take(&mut self.providers)
            .into_iter()
            .map(ProviderConfig::migrated)
            .collect();
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

    /// 自定义路径构造。当前零调用方（含测试：测试经 `in_app_home` 注入临时目录），
    /// 作为与 `in_app_home` 对称的构造入口保留（审计待确认清单项，勿径删）。
    #[allow(dead_code)]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// 当前配置文件路径（诊断 / 展示用）；目前仅测试消费（state 装配断言 + 配置单测），
    /// 生产调用方接线前按测试专用豁免。
    #[cfg_attr(not(test), allow(dead_code))]
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
        let mut config = serde_json::from_slice::<Config>(&bytes).map_err(|source| {
            ConfigError::Parse {
                path: self.path.clone(),
                source,
            }
        })?;
        config.migrate_legacy(); // 旧单模型格式（providers[].model）迁入 models
        config.validate()?;
        Ok(config)
    }

    /// 保存配置：先校验，再写同目录临时文件并刷盘，最后原子改名覆盖目标
    /// （同目录同卷 rename；任一步失败则清理临时文件，config.json 保持上一次完整内容）。
    pub fn save(&self, config: &Config) -> Result<(), ConfigError> {
        let mut snapshot = config.clone();
        snapshot.migrate_legacy(); // 内存态若带 legacy 键，落盘前一并迁入 models
        snapshot.validate()?;
        let json =
            serde_json::to_string_pretty(&snapshot).map_err(ConfigError::Serialize)?;
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
mod tests;
