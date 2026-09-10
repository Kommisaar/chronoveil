//! 组合根（ADR-010）：装配应用主目录（ADR-012）、SQLite 存储（CMP-003）与
//! config.json（TASK-003）。

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use crate::domain::error::StorageError;
use crate::infra::config::{ConfigError, ConfigStore};
use crate::infra::llm::EventSink;
use crate::infra::storage::Storage;
use crate::services::generation::GenerationRegistry;

/// 应用主目录下的固定布局（ADR-012）。
pub const APP_DIR_NAME: &str = ".chronoveil";
pub const DB_FILE_NAME: &str = "chronoveil.db";

/// 组合根状态：`lib.rs` 经 `.manage()` 注入，命令层经 `State<AppState>` 取用。
pub struct AppState {
    pub storage: Arc<Storage>,
    /// 应用主目录 `~/.chronoveil/`（根路径可注入，见 `init_with_home`）。
    pub app_home: PathBuf,
    /// config.json 存取句柄（ADR-012）。只持路径不持内容——读取路径每次
    /// `load()` 取当次值，改完即生效（含外部手改），不长期缓存。
    pub config: ConfigStore,
    /// 活跃生成注册表（TASK-006 / FR-007 / ADR-007）：同会话互斥、跨会话并发、
    /// 取消按 session_id 精确打断。
    pub generation: Arc<GenerationRegistry>,
    /// 流式事件通道（INT-001）：`setup` 中以 `TauriEventSink` 注入（AppHandle 在
    /// setup 才可用）；命令层经 [`AppState::sink`] 取用，测试可直接注入替身。
    sink: OnceLock<Arc<dyn EventSink>>,
}

/// 组合根装配错误：`AppState::init*` 的失败路径（home 解析 / 建目录 / 开库 / 配置装载），
/// 启动期快速失败并给出可读原因（ADR-012）。
#[derive(Debug)]
pub enum AppStateError {
    /// 无法解析用户 home 目录。
    HomeNotFound,
    /// 主目录创建失败。
    CreateDir(std::io::Error),
    /// 数据库打开 / 迁移失败。
    Storage(StorageError),
    /// 配置装载失败（坏 config.json 快速失败，ADR-012）。
    Config(ConfigError),
}

impl std::fmt::Display for AppStateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppStateError::HomeNotFound => write!(f, "无法解析用户 home 目录"),
            AppStateError::CreateDir(e) => write!(f, "创建应用主目录失败：{e}"),
            AppStateError::Storage(e) => write!(f, "打开数据库失败：{e}"),
            AppStateError::Config(e) => write!(f, "装载应用配置失败：{e}"),
        }
    }
}

impl std::error::Error for AppStateError {}

impl From<StorageError> for AppStateError {
    fn from(e: StorageError) -> Self {
        AppStateError::Storage(e)
    }
}

impl From<ConfigError> for AppStateError {
    fn from(e: ConfigError) -> Self {
        AppStateError::Config(e)
    }
}

/// 解析应用主目录：`<home>/.chronoveil`，不存在则创建（ADR-012）。
/// `home_override` 供测试与定制注入根路径——测试必须注入临时目录，绝不写真实 home。
pub fn resolve_app_home(home_override: Option<PathBuf>) -> Result<PathBuf, AppStateError> {
    let home = match home_override {
        Some(p) => p,
        None => dirs::home_dir().ok_or(AppStateError::HomeNotFound)?,
    };
    let app_home = home.join(APP_DIR_NAME);
    std::fs::create_dir_all(&app_home).map_err(AppStateError::CreateDir)?;
    Ok(app_home)
}

impl AppState {
    /// 生产装配：真实 home 下的 `~/.chronoveil/chronoveil.db`。
    pub fn init() -> Result<Self, AppStateError> {
        Self::init_with_home(None)
    }

    /// 根路径可注入的装配；测试传 `Some(临时目录)`。
    pub fn init_with_home(home_override: Option<PathBuf>) -> Result<Self, AppStateError> {
        let app_home = resolve_app_home(home_override)?;
        let storage = Storage::open(&app_home.join(DB_FILE_NAME))?;
        let config = ConfigStore::in_app_home(&app_home);
        // 启动期试装载：坏 config.json 在此快速失败（ADR-012），之后读取路径
        // 每次经 `state.config.load()` 取当次值，不在此缓存内容。
        config.load()?;
        Ok(Self {
            storage: Arc::new(storage),
            app_home,
            config,
            generation: Arc::new(GenerationRegistry::new()),
            sink: OnceLock::new(),
        })
    }

    /// 注入流式事件通道（`lib.rs` setup 中调用一次；重复注入忽略首个之后的值）。
    pub fn set_sink(&self, sink: Arc<dyn EventSink>) {
        let _ = self.sink.set(sink);
    }

    /// 取流式事件通道（命令层构造生成任务时使用；未注入即装配顺序错误，快速失败）。
    pub fn sink(&self) -> Arc<dyn EventSink> {
        self.sink.get().cloned().expect("流式事件通道未初始化：lib.rs setup 应先于任何命令执行")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::{Character, NewCharacter};
    use crate::domain::ports::StoragePort;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "chronoveil_state_test_{}_{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed),
            tag
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// 验收 2：注入根路径下创建 `.chronoveil/`；绝不触碰真实 home。
    #[test]
    fn resolve_app_home_creates_injected_dir() {
        let home = temp_home("resolve");
        let app_home = resolve_app_home(Some(home.clone())).unwrap();
        assert_eq!(app_home, home.join(APP_DIR_NAME));
        assert!(app_home.is_dir(), "主目录不存在则创建");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 验收 2：注入根路径装配出的 AppState 可直接读写库（库文件落在主目录内）。
    #[test]
    fn app_state_init_with_temp_home_opens_db() {
        let home = temp_home("init");
        let state = AppState::init_with_home(Some(home.clone())).unwrap();
        assert!(state.app_home.join(DB_FILE_NAME).is_file(), "库文件应在主目录内");

        let character: Character = state
            .storage
            .create_character(&NewCharacter {
                name: "组合根验证".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(state.storage.get_character(character.id).unwrap().name, "组合根验证");
        drop(state);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// TASK-003 装配：config 句柄指向 `<app_home>/config.json`；缺文件装配成功
    /// （全默认），保存 - 重读经同一句柄往返一致。
    #[test]
    fn app_state_config_seam_roundtrip() {
        use crate::infra::config::{Config, ConfigStore, CONFIG_FILE_NAME};

        let home = temp_home("config");
        let state = AppState::init_with_home(Some(home.clone())).unwrap();
        assert_eq!(
            state.config.path(),
            state.app_home.join(CONFIG_FILE_NAME),
            "config.json 与 chronoveil.db 同住主目录（ADR-012）"
        );

        let mut config = Config::new_with_defaults();
        config.ui_theme = "dark".into();
        config.rhythm_ms_per_char = 90;
        state.config.save(&config).unwrap();
        assert_eq!(ConfigStore::in_app_home(&state.app_home).load().unwrap(), config);
        drop(state);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// TASK-003 装配：坏 config.json 在启动装配期快速失败（ADR-012），错误可读。
    #[test]
    fn app_state_bad_config_fails_fast() {
        use crate::infra::config::CONFIG_FILE_NAME;

        let home = temp_home("badcfg");
        let app_home = resolve_app_home(Some(home.clone())).unwrap();
        std::fs::write(app_home.join(CONFIG_FILE_NAME), "{ not json").unwrap();

        // AppState 不可 Debug（含非 Debug 的 Storage），用 match 拿错误。
        let err = match AppState::init_with_home(Some(home.clone())) {
            Ok(_) => panic!("坏 config.json 应使装配失败"),
            Err(e) => e,
        };
        assert!(
            matches!(err, AppStateError::Config(_)),
            "坏配置应归入 Config 变体，实际：{err}"
        );
        assert!(err.to_string().contains("配置"), "错误信息应指向配置：{err}");
        let _ = std::fs::remove_dir_all(&home);
    }
}
