from PySide6.QtCore import Signal
from PySide6.QtCore import Slot
from PySide6.QtWidgets import QHBoxLayout
from PySide6.QtWidgets import QVBoxLayout
from PySide6.QtWidgets import QWidget

from chronoveil.views.general_settings_panel import GeneralSettingsPanel
from chronoveil.views.llm_settings_panel import LLMSettingsPanel


class SettingsView(QWidget):
    language_changed = Signal()
    theme_changed = Signal()

    def __init__(self):
        super().__init__()
        self.setObjectName("SettingView")

        self._llm_setting_panel = LLMSettingsPanel()
        self._general_setting_panel = GeneralSettingsPanel()

        self._setup_ui()
        self._setup_connections()

    def _setup_ui(self) -> None:
        layout = QHBoxLayout()

        left_layout = QVBoxLayout()
        left_layout.addWidget(self._llm_setting_panel)
        left_layout.addStretch(stretch=1)

        right_layout = QVBoxLayout()
        right_layout.addWidget(self._general_setting_panel)
        right_layout.addStretch(stretch=1)

        layout.addLayout(left_layout, stretch=5)
        layout.addLayout(right_layout, stretch=3)

        self.setLayout(layout)

    def _setup_connections(self) -> None:
        self.language_changed.connect(self._general_setting_panel.on_language_changed)
        self.language_changed.connect(self._llm_setting_panel.on_language_changed)

        self.theme_changed.connect(self._general_setting_panel.on_theme_changed)
        self.theme_changed.connect(self._llm_setting_panel.on_theme_changed)

    @Slot()
    def on_language_changed(self) -> None:
        self.language_changed.emit()

    @Slot()
    def on_theme_changed(self) -> None:
        self.theme_changed.emit()

    @property
    def llm_setting_panel(self) -> LLMSettingsPanel:
        return self._llm_setting_panel

    @property
    def general_setting_panel(self) -> GeneralSettingsPanel:
        return self._general_setting_panel
