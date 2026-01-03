from PySide6.QtCore import Signal
from PySide6.QtCore import Slot
from qfluentwidgets import CardGroupWidget
from qfluentwidgets import ComboBox
from qfluentwidgets import FluentIcon
from qfluentwidgets import GroupHeaderCardWidget
from qfluentwidgets import Theme

from chronoveil.core.enums import Language
from chronoveil.core.enums.theme import Theme


class GeneralSettingsPanel(GroupHeaderCardWidget):
    language_selected = Signal(Language)
    language_changed = Signal()

    theme_selected = Signal(Theme)
    theme_changed = Signal()

    def __init__(self):
        super().__init__()
        self._language_setting: ComboBox | None = None
        self._language_setting_card: CardGroupWidget | None = None

        self._theme_setting: ComboBox | None = None
        self._theme_setting_card: CardGroupWidget | None = None

        self._setup_ui()
        self._setup_connections()

    def _setup_ui(self):
        self.setTitle(self.tr("General Settings"))
        self.setBorderRadius(8)

        self._setup_language_setting()
        self._setup_theme_setting()

    def _setup_language_setting(self):
        self._language_setting = ComboBox(self)
        self._language_setting.setMinimumWidth(100)
        for language in Language:
            self._language_setting.addItem(text=language.label, userData=language)

        self._language_setting_card = self.addGroup(
            icon=FluentIcon.LANGUAGE,
            title=self.tr("Language"),
            content=self.tr("Select the display language of the application"),
            widget=self._language_setting,
        )

    def _setup_theme_setting(self):
        self._theme_setting = ComboBox(self)
        self._theme_setting.setMinimumWidth(100)
        for theme in Theme:
            self._theme_setting.addItem(text=theme.label, userData=theme)

        self._theme_setting_card = self.addGroup(
            icon=FluentIcon.BRUSH,
            title=self.tr("Theme"),
            content=self.tr("Choose the visual style of the interface"),
            widget=self._theme_setting,
        )

    def _setup_connections(self):
        self._language_setting.currentIndexChanged.connect(self.on_language_selected)
        self._theme_setting.currentIndexChanged.connect(self.on_theme_selected)

    def set_language(self, language: Language):
        self._language_setting.setCurrentIndex(self._language_setting.findData(language))

    def set_theme(self, theme: Theme):
        self._theme_setting.setCurrentIndex(self._theme_setting.findData(theme))

    @Slot(int)
    def on_language_selected(self, index: int):
        if index == -1:
            return

        language = self._language_setting.itemData(index)
        self.language_selected.emit(language)

    @Slot()
    def on_language_changed(self):
        self.setTitle(self.tr("General Settings"))

        self._language_setting_card.setTitle(self.tr("Language"))
        self._language_setting_card.setContent(self.tr("Select the display language of the application"))
        self._theme_setting_card.setTitle(self.tr("Theme"))
        self._theme_setting_card.setContent(self.tr("Choose the visual style of the interface"))

    @Slot(int)
    def on_theme_selected(self, index: int):
        if index == -1:
            return

        theme = self._theme_setting.itemData(index)
        self.theme_selected.emit(theme)

    @Slot()
    def on_theme_changed(self):
        pass
