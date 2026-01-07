from PySide6.QtCore import Signal
from PySide6.QtCore import Slot
from PySide6.QtGui import QGuiApplication
from qfluentwidgets import FluentIcon
from qfluentwidgets import MSFluentWindow
from qfluentwidgets import NavigationItemPosition

from chronoveil.views.chat_view import ChatView
from chronoveil.views.components import SplashScreen
from chronoveil.views.dashboard_view import DashboardView
from chronoveil.views.settings_view import SettingsView


class MainWindow(MSFluentWindow):
    language_changed = Signal()
    theme_changed = Signal()

    def __init__(self):
        super().__init__()
        self._window_scale = 0.5
        self._setup_ui()
        self._setup_connections()

    def set_username(self, username: str) -> None:
        self._splash_screen.set_username(username)

    def start(self) -> None:
        self._splash_screen.start()
        self.show()

    def _setup_ui(self) -> None:
        screen = QGuiApplication.primaryScreen()
        size = screen.size()
        screen_width, screen_height = size.width(), size.height()
        window_width, window_height = screen_width * self._window_scale, screen_height * self._window_scale
        self.setFixedSize(window_width, window_height)
        self.move((screen_width - window_width) / 2, (screen_height - window_height) / 2)

        self._splash_screen = SplashScreen(self)
        self.setWindowTitle("Chronoveil")
        self._setup_dashboard_view()
        self._setup_chat_view()
        self._setup_setting_view()

    def _setup_dashboard_view(self) -> None:
        self._dashboard_view = DashboardView(parent=self)
        self._dashboard_view_button = self.addSubInterface(
            interface=self._dashboard_view,
            icon=FluentIcon.HOME,
            selectedIcon=FluentIcon.HOME,
            text=self.tr("Dashboard"),
            position=NavigationItemPosition.TOP
        )

    def _setup_chat_view(self) -> None:
        self._chat_view = ChatView(parent=self)
        self._chat_view_button = self.addSubInterface(
            interface=self._chat_view,
            icon=FluentIcon.MESSAGE,
            selectedIcon=FluentIcon.MESSAGE,
            text=self.tr("Chat"),
            position=NavigationItemPosition.TOP
        )

    def _setup_setting_view(self) -> None:
        self._settings_view = SettingsView(parent=self)
        self._setting_view_button = self.addSubInterface(
            interface=self._settings_view,
            icon=FluentIcon.SETTING,
            selectedIcon=FluentIcon.SETTING,
            text=self.tr("Settings"),
            position=NavigationItemPosition.BOTTOM
        )

    def _setup_connections(self) -> None:
        self.language_changed.connect(self._dashboard_view.on_language_changed)
        # self.language_changed.connect(self._chat_view.)
        self.language_changed.connect(self._settings_view.on_language_changed)

        self.theme_changed.connect(self._settings_view.on_theme_changed)

    @Slot()
    def on_language_changed(self) -> None:
        self._chat_view_button.setText(self.tr("Chat"))
        self._setting_view_button.setText(self.tr("Settings"))

        self.language_changed.emit()

    @Slot()
    def on_theme_changed(self) -> None:
        self.theme_changed.emit()

    @property
    def chat_view(self) -> ChatView:
        return self._chat_view

    @property
    def setting_view(self) -> SettingsView:
        return self._settings_view
