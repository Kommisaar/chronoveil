from PySide6.QtCore import Qt
from PySide6.QtGui import QColor
from PySide6.QtGui import QPainter
from PySide6.QtGui import QPainterPath
from PySide6.QtWidgets import QVBoxLayout
from PySide6.QtWidgets import QWidget
from qfluentwidgets import BodyLabel
from qfluentwidgets import CardWidget
from qfluentwidgets import isDarkTheme


class SessionCard(CardWidget):
    def __init__(
            self,
            title: str,
            description: str,
            parent: QWidget | None = None
    ):
        super().__init__(parent=parent)
        self._title = BodyLabel(title, self)
        self._description = BodyLabel(description, self)
        self._setup_ui()

    def _setup_ui(self):
        layout = QVBoxLayout()

        layout.addWidget(self._title)
        layout.addWidget(self._description)
        self.setFixedHeight(60)
        self.setLayout(layout)
        self.setContentsMargins(0, 0, 0, 0)

    def _normalBackgroundColor(self):
        return QColor(0, 0, 0, 0)

    def _hoverBackgroundColor(self):
        if isDarkTheme():
            return QColor(255, 255, 255, 20)
        else:
            return QColor(0, 0, 0, 15)

    def _pressedBackgroundColor(self):
        if isDarkTheme():
            return QColor(255, 255, 255, 30)
        else:
            return QColor(0, 0, 0, 25)

    def _disabledBackgroundColor(self):
        return QColor(0, 0, 0, 0)

    def paintEvent(self, e):
        painter = QPainter(self)
        painter.setRenderHints(QPainter.RenderHint.Antialiasing)

        w, h = self.width(), self.height()
        r = self.borderRadius
        d = 2 * r

        is_dark = isDarkTheme()

        should_draw_border = self.isHover or self.isPressed

        if should_draw_border:
            path = QPainterPath()
            # path.moveTo(1, h - r)
            path.arcMoveTo(1, h - d - 1, d, d, 240)
            path.arcTo(1, h - d - 1, d, d, 225, -60)
            path.lineTo(1, r)
            path.arcTo(1, 1, d, d, -180, -90)
            path.lineTo(w - r, 1)
            path.arcTo(w - d - 1, 1, d, d, 90, -90)
            path.lineTo(w - 1, h - r)
            path.arcTo(w - d - 1, h - d - 1, d, d, 0, -60)

            top_border_color = QColor(0, 0, 0, 20)
            if is_dark:
                if self.isPressed:
                    top_border_color = QColor(255, 255, 255, 18)
                elif self.isHover:
                    top_border_color = QColor(255, 255, 255, 13)
            else:
                top_border_color = QColor(0, 0, 0, 15)

            painter.strokePath(path, top_border_color)

            # draw bottom border
            path = QPainterPath()
            path.arcMoveTo(1, h - d - 1, d, d, 240)
            path.arcTo(1, h - d - 1, d, d, 240, 30)
            path.lineTo(w - r - 1, h - 1)
            path.arcTo(w - d - 1, h - d - 1, d, d, 270, 30)

            bottom_border_color = top_border_color
            if not is_dark and self.isHover and not self.isPressed:
                bottom_border_color = QColor(0, 0, 0, 27)

            painter.strokePath(path, bottom_border_color)

        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(self.backgroundColor)
        painter.drawRoundedRect(self.rect(), r, r)
