from PySide6.QtCore import QObject
from PySide6.QtCore import Signal
from PySide6.QtCore import Slot

from chronoveil.core.enums import Language
from chronoveil.core.enums import Setting
from chronoveil.core.enums import Theme
from chronoveil.core.managers import SettingsManager
from chronoveil.core.models import LLMSettings
from chronoveil.views.settings_view import SettingsView


class SettingsController(QObject):
    llm_settings_changed = Signal(LLMSettings)

    language_selected = Signal(Language)
    theme_selected = Signal(Theme)

    def __init__(
            self,
            settings_view: SettingsView,
            settings_manager: SettingsManager,
            parent: QObject | None = None
    ):
        super().__init__(parent=parent)
        self._settings_view = settings_view
        self._settings_manager = settings_manager

        self._restore_settings()
        self._setup_connections()

    def _restore_settings(self):
        self._restore_llm_settings()
        self._restore_general_settings()

    def _restore_llm_settings(self):
        llm_settings = self._settings_manager.get_llm_setting()
        self._settings_view.llm_setting_panel.set_llm_api_settings(llm_settings)

    def _restore_general_settings(self):
        language = self._settings_manager.get_value(Setting.GENERAL_LANGUAGE)
        if language is not None:
            self._settings_view.general_setting_panel.set_language(language)

        theme = self._settings_manager.get_value(Setting.GENERAL_THEME)
        if theme is not None:
            self._settings_view.general_setting_panel.set_theme(theme)

    def _setup_connections(self):
        self._settings_view.llm_setting_panel.llm_settings_changed.connect(self.on_llm_settings_changed)

        self._settings_view.general_setting_panel.language_selected.connect(self.on_language_selected)
        self._settings_view.general_setting_panel.theme_selected.connect(self.on_theme_selected)

    @Slot(LLMSettings)
    def on_llm_settings_changed(self, llm_settings: LLMSettings):
        self.llm_settings_changed.emit(llm_settings)

    @Slot(Language)
    def on_language_selected(self, language: Language):
        self.language_selected.emit(language)

    @Slot(Theme)
    def on_theme_selected(self, theme: Theme):
        self.theme_selected.emit(theme)
