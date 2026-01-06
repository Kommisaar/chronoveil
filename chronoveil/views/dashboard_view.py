from PySide6.QtCore import Signal
from PySide6.QtCore import Slot
from PySide6.QtWidgets import QVBoxLayout
from PySide6.QtWidgets import QWidget

from chronoveil.views.components import DashboardTopCard


class DashboardView(QWidget):
    language_changed = Signal()

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent=parent)
        self.setObjectName("DashboardView")

        self._dashboard_top_card = DashboardTopCard()

        self._setup_ui()
        self._setup_connections()

    def _setup_ui(self):
        layout = QVBoxLayout()
        layout.addWidget(self._dashboard_top_card, stretch=1)

        layout.addStretch(stretch=6)
        self.setLayout(layout)

    def _setup_connections(self):
        self.language_changed.connect(self._dashboard_top_card.on_language_changed)

    @Slot()
    def on_language_changed(self) -> None:
        self.language_changed.emit()
