from PySide6.QtCore import QObject
from PySide6.QtCore import QSettings

from chronoveil.core.enums import Setting
from chronoveil.utils import get_logger

LLM_SETTING = {Setting.LLM_API_FORMAT, Setting.LLM_BASE_URL, Setting.LLM_API_KEY, Setting.LLM_MODEL_NAME}


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

    def set_value(self, setting: Setting, value: str | int | float | bool) -> None:
        old_value = self.get_value(setting)
        if str(old_value) == str(value):
            return

        self._settings.setValue(setting, value)
        self._settings.sync()

    def get_value(self, setting: Setting) -> str | int | float | bool | None:
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
