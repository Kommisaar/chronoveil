from PySide6.QtWidgets import QHBoxLayout
from PySide6.QtWidgets import QWidget

from chronoveil.views.panels import SessionPanel
from chronoveil.views.panels import SessionsPanel


class ChatView(QWidget):
    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent=parent)
        self.setObjectName("ChatView")

        self._setup_ui()

    def _setup_ui(self):
        self._sessions_panel = SessionsPanel()
        self._session_panel = SessionPanel()

        layout = QHBoxLayout()
        layout.addWidget(self._sessions_panel, 1)
        layout.addWidget(self._session_panel, 4)
        self.setLayout(layout)







