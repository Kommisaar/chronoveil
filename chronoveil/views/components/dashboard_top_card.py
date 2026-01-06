from datetime import datetime

from PySide6.QtCore import QTimer
from PySide6.QtCore import Signal
from PySide6.QtCore import Slot
from PySide6.QtGui import QColor
from PySide6.QtWidgets import QHBoxLayout
from PySide6.QtWidgets import QVBoxLayout
from PySide6.QtWidgets import QWidget
from qfluentwidgets import AvatarWidget
from qfluentwidgets import BodyLabel
from qfluentwidgets import ElevatedCardWidget
from qfluentwidgets import PrimaryPushButton
from qfluentwidgets import PushButton
from qfluentwidgets import TitleLabel


class DashboardTopCard(ElevatedCardWidget):
    new_session_button_clicked = Signal()
    resume_session_button_clicked = Signal()

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent=parent)

        self._avatar = AvatarWidget()
        self._greeting_label = TitleLabel(self.tr("Welcome back, "))
        self._name_label = TitleLabel("Visitor")
        self._time_label = BodyLabel(self._build_current_time())
        self._new_session_button = PrimaryPushButton(self.tr("Start New Session"))
        self._resume_session_button = PushButton(self.tr("Resume Last Session"))

        self._setup_ui()
        self._setup_connections()

        self.timer = QTimer(self)
        self.timer.start(1000 * 60)
        self.timer.timeout.connect(self._update_time)

    def _setup_ui(self):
        self._avatar.setFixedSize(96, 96)
        self._avatar.setText("Visitor")
        self._avatar.setBackgroundColor(QColor("#e6f5f7"), QColor("#e6f5f7"))

        self._time_label.setTextColor(QColor("#666"))

        main_layout = QHBoxLayout(self)
        main_layout.setContentsMargins(24, 24, 24, 24)
        main_layout.setSpacing(24)

        main_layout.addWidget(self._avatar, stretch=2)

        middle_layout = QVBoxLayout()
        middle_layout.setSpacing(8)

        title_layout = QHBoxLayout()
        title_layout.setSpacing(0)
        title_layout.addWidget(self._greeting_label)
        title_layout.addWidget(self._name_label)
        title_layout.addStretch()

        middle_layout.addLayout(title_layout)
        middle_layout.addWidget(self._time_label)
        middle_layout.addStretch()

        main_layout.addLayout(middle_layout, stretch=8)

        button_layout = QVBoxLayout()
        button_layout.setContentsMargins(16, 0, 16, 0)
        button_layout.setSpacing(8)

        self._new_session_button.setFixedHeight(40)
        self._resume_session_button.setFixedHeight(40)

        button_layout.addWidget(self._new_session_button)
        button_layout.addWidget(self._resume_session_button)

        main_layout.addLayout(button_layout, stretch=2)

    def _setup_connections(self):
        self._new_session_button.clicked.connect(self.on_new_session_button_clicked)
        self._resume_session_button.clicked.connect(self.on_resume_session_button_clicked)

    def _build_current_time(self) -> str:
        now = datetime.now()
        weekday_names = [
            self.tr("Monday"),
            self.tr("Tuesday"),
            self.tr("Wednesday"),
            self.tr("Thursday"),
            self.tr("Friday"),
            self.tr("Saturday"),
            self.tr("Sunday")
        ]

        year = now.year
        month = now.month
        day = now.day
        weekday = weekday_names[now.weekday()]

        return self.tr("Today is {year}:{month}:{day} {weekday}").format(
            year=year,
            month=month,
            day=day,
            weekday=weekday
        )

    def _update_time(self) -> None:
        self._time_label.setText(self._build_current_time())

    def set_username(self, username: str) -> None:
        self._name_label.setText(username)
        self._avatar.setText(username)

    @Slot()
    def on_language_changed(self) -> None:
        self._greeting_label.setText(self.tr("Welcome back, "))
        self._new_session_button.setText(self.tr("Start New Session"))
        self._resume_session_button.setText(self.tr("Resume Last Session"))
        self._time_label.setText(self._build_current_time())

    @Slot()
    def on_theme_changed(self) -> None:
        pass

    @Slot()
    def on_new_session_button_clicked(self) -> None:
        self.new_session_button_clicked.emit()

    @Slot()
    def on_resume_session_button_clicked(self) -> None:
        self.resume_session_button_clicked.emit()
