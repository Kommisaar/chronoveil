from PySide6.QtCore import QObject
from PySide6.QtCore import QSettings

from chronoveil.core.enums import Setting
from chronoveil.core.models import LLMSettings
from chronoveil.utils import get_logger


class SettingsManager(QObject):

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)

        self._logger = get_logger(self.__class__.__name__)

        self._settings = QSettings(
            QSettings.Format.IniFormat,
            QSettings.Scope.UserScope,
            "Chronoveil",
            application="Chronoveil",
        )

    def set_value(self, setting: Setting, value: any, sync: bool = True) -> None:
        old_value = self.get_value(setting)
        if str(old_value) == str(value):
            return

        self._settings.setValue(setting, value)
        if sync:
            self._settings.sync()

    def get_value(self, setting: Setting) -> any:
        try:
            value: str | None = self._settings.value(setting)
            if value is None:
                return None

            if setting.value_type == bool:
                return value == "true"
            else:
                parsed_value = setting.value_type(value)
                return parsed_value
        except (ValueError, TypeError):
            self._logger.error(f"Failed to parse value for setting {setting}")
            self._settings.remove(setting)
            return None

    def set_llm_setting(self, llm_settings: LLMSettings) -> None:
        self.set_value(Setting.LLM_PROVIDER, llm_settings.provider, sync=False)
        self.set_value(Setting.LLM_BASE_URL, llm_settings.base_url, sync=False)
        self.set_value(Setting.LLM_API_KEY, llm_settings.api_key, sync=False)
        self.set_value(Setting.LLM_MODEL_NAME, llm_settings.model_name, sync=False)
        self._settings.sync()

    def get_llm_setting(self) -> LLMSettings:
        return LLMSettings(
            provider=self.get_value(Setting.LLM_PROVIDER),
            base_url=self.get_value(Setting.LLM_BASE_URL),
            api_key=self.get_value(Setting.LLM_API_KEY),
            model_name=self.get_value(Setting.LLM_MODEL_NAME),
        )

    def get_settings_file(self) -> str:
        return self._settings.fileName()
