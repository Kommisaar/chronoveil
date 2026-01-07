from PySide6.QtCore import QObject
from PySide6.QtCore import Signal
from PySide6.QtCore import Slot

from chronoveil.controllers.settings_controller import SettingsController
from chronoveil.core.enums import Language
from chronoveil.core.enums import Setting
from chronoveil.core.enums import Theme
from chronoveil.core.managers import LanguageManager
from chronoveil.core.managers import SettingsManager
from chronoveil.core.managers.database_manager import DatabaseManager
from chronoveil.core.models import LLMSettings
from chronoveil.views import MainWindow


class MainController(QObject):
    language_changed = Signal()
    theme_changed = Signal()

    def __init__(
            self,
            main_window: MainWindow,
            settings_manager: SettingsManager,
            language_manager: LanguageManager,
            database_manager: DatabaseManager,
            parent: QObject | None = None
    ):
        super().__init__(parent=parent)
        self._main_window = main_window
        self._settings_manager = settings_manager
        self._language_manager = language_manager
        self._database_manager = database_manager

        self._setup_controllers()
        self._setup_connections()

    def run(self):
        username = self._settings_manager.get_value(Setting.CURRENT_USER)
        self._main_window.set_username(username)
        self._main_window.start()

    def _setup_controllers(self) -> None:
        self._settings_controller = SettingsController(
            settings_view=self._main_window.setting_view,
            settings_manager=self._settings_manager,
            parent=self
        )

    def _setup_connections(self) -> None:
        self._settings_controller.llm_settings_changed.connect(self.on_llm_settings_changed)

        self.language_changed.connect(self._main_window.on_language_changed)
        self._settings_controller.language_selected.connect(self.on_language_selected)

        self.theme_changed.connect(self._main_window.on_theme_changed)
        self._settings_controller.theme_selected.connect(self.on_theme_selected)

    @Slot(LLMSettings)
    def on_llm_settings_changed(self, llm_settings: LLMSettings) -> None:
        self._settings_manager.set_llm_setting(llm_settings)

    @Slot(Language)
    def on_language_selected(self, language: Language) -> None:
        self._settings_manager.set_value(Setting.GENERAL_LANGUAGE, language)
        self._language_manager.switch_translator(language)
        self.language_changed.emit()

    @Slot(Theme)
    def on_theme_selected(self, theme: Theme) -> None:
        self._settings_manager.set_value(Setting.GENERAL_THEME, theme)
        self.theme_changed.emit()
