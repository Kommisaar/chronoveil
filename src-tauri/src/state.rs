//! 组合根（ADR-010）：装配应用主目录（ADR-012）与 SQLite 存储（CMP-003）。
//! 本阶段只做主目录解析 + chronoveil.db 打开；config.json 装载由「应用配置」任务负责，
//! 接缝即 `app_home`（config.json 与 chronoveil.db 同住 `~/.chronoveil/`）。

use std::path::PathBuf;
use std::sync::Arc;

use crate::domain::error::StorageError;
use crate::infra::storage::Storage;

/// 应用主目录下的固定布局（ADR-012）。
pub const APP_DIR_NAME: &str = ".chronoveil";
pub const DB_FILE_NAME: &str = "chronoveil.db";

/// 组合根状态：`lib.rs` 经 `.manage()` 注入，命令层经 `State<AppState>` 取用。
// 字段消费方在 TASK-005（IPC 命令层）接线后出现。
#[allow(dead_code)]
pub struct AppState {
    pub storage: Arc<Storage>,
    /// 应用主目录 `~/.chronoveil/`（根路径可注入，见 `init_with_home`）。
    pub app_home: PathBuf,
    // 接缝（ADR-012）：config.json 装载任务在此追加 `pub config: Config`。
}

#[derive(Debug)]
pub enum AppStateError {
    /// 无法解析用户 home 目录。
    HomeNotFound,
    /// 主目录创建失败。
    CreateDir(std::io::Error),
    /// 数据库打开 / 迁移失败。
    Storage(StorageError),
}

impl std::fmt::Display for AppStateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppStateError::HomeNotFound => write!(f, "无法解析用户 home 目录"),
            AppStateError::CreateDir(e) => write!(f, "创建应用主目录失败：{e}"),
            AppStateError::Storage(e) => write!(f, "打开数据库失败：{e}"),
        }
    }
}

impl std::error::Error for AppStateError {}

impl From<StorageError> for AppStateError {
    fn from(e: StorageError) -> Self {
        AppStateError::Storage(e)
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
        Ok(Self {
            storage: Arc::new(storage),
            app_home,
        })
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
}
