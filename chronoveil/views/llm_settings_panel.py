from PySide6.QtCore import Signal
from PySide6.QtCore import Slot
from qfluentwidgets import ComboBox
from qfluentwidgets import FluentIcon
from qfluentwidgets import GroupHeaderCardWidget
from qfluentwidgets import LineEdit
from qfluentwidgets import PasswordLineEdit
from qfluentwidgets import PushButton

from chronoveil.core.enums import LLMAPIFormat
from chronoveil.core.models import LLMSettings


class LLMSettingsPanel(GroupHeaderCardWidget):
    llm_settings_changed = Signal(LLMSettings)

    def __init__(self):
        super().__init__()
        self._setup_ui()
        self._setup_connections()

    def _setup_ui(self) -> None:
        self.setTitle(self.tr("LLM Settings"))
        self.setBorderRadius(8)

        self._setup_api_format_setting()
        self._setup_base_url_setting()
        self._setup_model_name_setting()
        self._setup_api_key_setting()
        self._setup_test_setting()

    def _setup_api_format_setting(self) -> None:
        self._api_format_setting = ComboBox(self)
        self._api_format_setting.setMinimumWidth(150)
        for llm_format in LLMAPIFormat:
            self._api_format_setting.addItem(text=llm_format.label, userData=llm_format)

        self._api_format_setting_card = self.addGroup(
            icon=FluentIcon.APPLICATION,
            title=self.tr("API Format"),
            content=self.tr("Request format used to communicate with the LLM backend"),
            widget=self._api_format_setting,
        )

    def _setup_base_url_setting(self) -> None:
        self._base_url_setting = LineEdit(self)
        self._base_url_setting.setMinimumWidth(300)

        self._base_url_setting_card = self.addGroup(
            icon=FluentIcon.GLOBE,
            title=self.tr("Base URL"),
            content=self.tr("API endpoint base URL (e.g., https://api.openai.com/v1)"),
            widget=self._base_url_setting,
        )

    def _setup_model_name_setting(self) -> None:
        self._model_name_setting = LineEdit(self)
        self._model_name_setting.setMinimumWidth(300)

        self._model_name_setting_card = self.addGroup(
            icon=FluentIcon.ROBOT,
            title=self.tr("Model Name"),
            content=self.tr("Name of the model to use (e.g., gpt-4o, qwen-max)"),
            widget=self._model_name_setting,
        )

    def _setup_api_key_setting(self) -> None:
        self._api_key_setting = PasswordLineEdit(self)
        self._api_key_setting.setMinimumWidth(300)

        self._api_key_setting_card = self.addGroup(
            icon=FluentIcon.VPN,
            title=self.tr("API Key"),
            content=self.tr("Authentication key for the LLM service"),
            widget=self._api_key_setting,
        )

    def _setup_test_setting(self) -> None:
        self._test_setting = PushButton(self)
        self._test_setting.setMinimumWidth(150)
        self._test_setting.setText(self.tr("Test Connection"))

        self._test_setting_card = self.addGroup(
            icon=FluentIcon.PLAY,
            title=self.tr("Test"),
            content=self.tr("Validate your settings by sending a test request"),
            widget=self._test_setting,
        )

    def _setup_connections(self) -> None:
        self._api_format_setting.currentIndexChanged.connect(self.on_llm_settings_changed)
        self._base_url_setting.textEdited.connect(self.on_llm_settings_changed)
        self._model_name_setting.textEdited.connect(self.on_llm_settings_changed)
        self._api_key_setting.textEdited.connect(self.on_llm_settings_changed)

    def set_llm_api_settings(self, llm_settings: LLMSettings) -> None:
        if llm_settings.api_format is not None:
            self._api_format_setting.setCurrentIndex(self._api_format_setting.findData(llm_settings.api_format))

        if llm_settings.base_url is not None:
            self._base_url_setting.setText(llm_settings.base_url)

        if llm_settings.model_name is not None:
            self._model_name_setting.setText(llm_settings.model_name)

        if llm_settings.api_key is not None:
            self._api_key_setting.setText(llm_settings.api_key)

    @Slot()
    def on_llm_settings_changed(self):
        print("LLM settings changed")
        llm_settings = LLMSettings(
            api_format=self._api_format_setting.currentData(),
            base_url=self._base_url_setting.text(),
            model_name=self._model_name_setting.text(),
            api_key=self._api_key_setting.text(),
        )
        self.llm_settings_changed.emit(llm_settings)

    @Slot()
    def on_language_changed(self):
        self.setTitle(self.tr("LLM Settings"))

        self._api_format_setting_card.setTitle(self.tr("API Format"))
        self._api_format_setting_card.setContent(self.tr("Request format used to communicate with the LLM backend"))

        self._base_url_setting_card.setTitle(self.tr("Base URL"))
        self._base_url_setting_card.setContent(self.tr("API endpoint base URL (e.g., https://api.openai.com/v1)"))

        self._model_name_setting_card.setTitle(self.tr("Model Name"))
        self._model_name_setting_card.setContent(self.tr("Name of the model to use (e.g., gpt-4o, qwen-max)"))

        self._api_key_setting_card.setTitle(self.tr("API Key"))
        self._api_key_setting_card.setContent(self.tr("Authentication key for the LLM service"))

        self._test_setting.setText(self.tr("Test Connection"))
        self._test_setting_card.setTitle(self.tr("Test"))
        self._test_setting_card.setContent(self.tr("Validate your settings by sending a test request"))

    @Slot()
    def on_theme_changed(self):
        pass
