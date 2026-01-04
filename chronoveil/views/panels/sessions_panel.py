from datetime import datetime

from PySide6.QtCore import Qt
from PySide6.QtCore import Slot
from PySide6.QtWidgets import QHBoxLayout
from PySide6.QtWidgets import QScrollArea
from PySide6.QtWidgets import QVBoxLayout
from PySide6.QtWidgets import QWidget
from qfluentwidgets import FluentIcon
from qfluentwidgets import PushButton
from qfluentwidgets import SmoothScrollArea
from qfluentwidgets import ToolButton

from chronoveil.views.components import SessionCard


class SessionsPanel(QWidget):
    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent=parent)
        self._setup_ui()
        self._setup_connections()

        self._session_cards: {int: SessionCard} = {
        }

    def _setup_ui(self):
        outer_layout = QVBoxLayout()
        outer_layout.setContentsMargins(0, 0, 0, 0)
        outer_layout.setSpacing(5)

        header_layout = QHBoxLayout()
        header_layout.setSpacing(8)

        self._add_session_button = PushButton("New Session")
        self._add_session_button.setFixedHeight(40)
        header_layout.addWidget(self._add_session_button)

        self._search_button = ToolButton(FluentIcon.SEARCH)
        self._search_button.setFixedHeight(40)
        header_layout.addWidget(self._search_button)

        self._hide_button = ToolButton(FluentIcon.LEFT_ARROW)
        self._hide_button.setFixedHeight(40)
        header_layout.addWidget(self._hide_button)

        outer_layout.addLayout(header_layout)
        outer_layout.addSpacing(10)

        self._scroll_area = SmoothScrollArea(parent=self)
        self._scroll_area.setWidgetResizable(True)
        self._scroll_area.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self._scroll_area.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self._scroll_area.setFrameShape(QScrollArea.Shape.NoFrame)
        self._scroll_area.setStyleSheet("QScrollArea{background: transparent; border: none}")

        self._scroll_content = QWidget(parent=self._scroll_area)
        self._scroll_content.setStyleSheet("QWidget{background: transparent}")

        self._cards_layout = QVBoxLayout(self._scroll_content)
        self._cards_layout.setContentsMargins(0, 0, 0, 0)
        self._cards_layout.setSpacing(8)
        self._cards_layout.addStretch()

        self._scroll_area.setWidget(self._scroll_content)
        outer_layout.addWidget(self._scroll_area)

        self.setLayout(outer_layout)

    def _setup_connections(self):
        self._add_session_button.clicked.connect(self.on_new_session_button_clicked)

    @Slot()
    def on_new_session_button_clicked(self):
        card = SessionCard(title="New Session", description=f"Generated at {datetime.now().strftime('%H:%M:%S')}", parent=self._scroll_content)
        self._session_cards[int(datetime.now().timestamp())] = card
        self._cards_layout.insertWidget(0, card)
