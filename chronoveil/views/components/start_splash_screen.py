import sys

from PySide6.QtCore import QEasingCurve
from PySide6.QtCore import QEvent
from PySide6.QtCore import QParallelAnimationGroup
from PySide6.QtCore import QPauseAnimation
from PySide6.QtCore import QPropertyAnimation
from PySide6.QtCore import QRectF
from PySide6.QtCore import QSequentialAnimationGroup
from PySide6.QtCore import QSize
from PySide6.QtCore import Qt
from PySide6.QtCore import Slot
from PySide6.QtGui import QColor
from PySide6.QtGui import QIcon
from PySide6.QtGui import QPainter
from PySide6.QtGui import QResizeEvent
from PySide6.QtWidgets import QGraphicsDropShadowEffect
from PySide6.QtWidgets import QGraphicsOpacityEffect
from PySide6.QtWidgets import QWidget
from qfluentwidgets import FluentStyleSheet
from qfluentwidgets import IconWidget
from qfluentwidgets import LineEdit
from qfluentwidgets import PushButton
from qfluentwidgets import TitleLabel
from qfluentwidgets import isDarkTheme
from qframelesswindow import TitleBar


class StartSplashScreen(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent=parent)
        self._title_bar = TitleBar(self)
        self._icon_widget = IconWidget(QIcon(":/icons/bot.png"), self)
        self._icon_size = QSize(160, 160)
        self._icon_shadow_effect = QGraphicsDropShadowEffect(self._icon_widget)

        self._welcome_label = TitleLabel("哔哔！检测到新用户，准备开启愉快的探索之旅～", self)
        self._welcome_opacity_effect = QGraphicsOpacityEffect(self._welcome_label)

        self._prompt_label = TitleLabel("哔哔！请告诉我您的名字吧～", self)
        self._prompt_opacity_effect = QGraphicsOpacityEffect(self._prompt_label)

        self._input_line = LineEdit(self)
        self._input_line_opacity_effect = QGraphicsOpacityEffect(self._input_line)

        self._confirm_button = PushButton("确定", self)
        self._confirm_button_opacity_effect = QGraphicsOpacityEffect(self._confirm_button)

        self._animation_started = False

        FluentStyleSheet.FLUENT_WINDOW.apply(self._title_bar)

        if parent:
            parent.installEventFilter(self)

        self._setup_ui()

    def _setup_ui(self):
        self._icon_widget.resize(self._icon_size)

        self._icon_shadow_effect.setColor(QColor(0, 0, 0, 50))
        self._icon_shadow_effect.setBlurRadius(15)
        self._icon_shadow_effect.setOffset(0, 4)
        self._icon_widget.setGraphicsEffect(self._icon_shadow_effect)

        self._welcome_label.setGraphicsEffect(self._welcome_opacity_effect)
        self._welcome_opacity_effect.setOpacity(0)

        self._prompt_label.setGraphicsEffect(self._prompt_opacity_effect)
        self._prompt_opacity_effect.setOpacity(0)

        self._input_line.setPlaceholderText("请输入您的名字")
        self._input_line.setFixedSize(QSize(300, 40))
        self._input_line.setGraphicsEffect(self._input_line_opacity_effect)
        self._input_line_opacity_effect.setOpacity(0)

        self._confirm_button.setFixedSize(QSize(100, 40))
        self._confirm_button.setGraphicsEffect(self._confirm_button_opacity_effect)
        self._confirm_button_opacity_effect.setOpacity(0)

        if sys.platform == "darwin":
            self._title_bar.hide()

    def _start_icon_animation(self):
        center_x, center_y = self.width() // 2, self.height() // 2
        iw, ih = self._icon_size.width(), self._icon_size.height()
        start_rect = QRectF(center_x - iw // 2, 0, iw, ih)
        end_rect = QRectF(center_x - ih // 2, center_y - ih // 2, iw, ih)

        self._scale_anim = QPropertyAnimation(self._icon_widget, b"geometry")
        self._scale_anim.setDuration(3000)
        self._scale_anim.setStartValue(start_rect)
        self._scale_anim.setEndValue(end_rect)
        self._scale_anim.setEasingCurve(QEasingCurve.Type.OutElastic)

        move_up_distance = ih * 3 // 4
        final_rect = QRectF(center_x - iw // 2, center_y - ih // 2 - move_up_distance, iw, ih)

        self._move_anim = QPropertyAnimation(self._icon_widget, b"geometry")
        self._move_anim.setDuration(500)
        self._move_anim.setStartValue(end_rect)
        self._move_anim.setEndValue(final_rect)
        self._move_anim.setEasingCurve(QEasingCurve.Type.OutBack)

        self._icon_anim_group = QSequentialAnimationGroup()
        self._icon_anim_group.addAnimation(self._scale_anim)
        self._icon_anim_group.addAnimation(self._move_anim)
        self._icon_anim_group.finished.connect(self._start_welcome_animation)
        self._icon_anim_group.start()

    def _start_welcome_animation(self):
        center_x, center_y = self.width() // 2, self.height() // 2
        lw, lh = self._welcome_label.width(), self._welcome_label.height()

        start_rect = QRectF(center_x - lw // 2, center_y + lh // 2, lw, lh)
        end_rect = QRectF(center_x - lw // 2, center_y - lh // 2, lw, lh)

        move_in_anim = QPropertyAnimation(self._welcome_label, b"geometry")
        move_in_anim.setDuration(2000)
        move_in_anim.setStartValue(start_rect)
        move_in_anim.setEndValue(end_rect)
        move_in_anim.setEasingCurve(QEasingCurve.Type.OutCubic)

        # 4. 淡入动画（作用于 effect 的 opacity）
        fade_in_anim = QPropertyAnimation(self._welcome_opacity_effect, b"opacity")
        fade_in_anim.setDuration(2000)
        fade_in_anim.setStartValue(0.0)
        fade_in_anim.setEndValue(1.0)
        fade_in_anim.setEasingCurve(QEasingCurve.Type.OutCubic)

        in_anim_group = QParallelAnimationGroup()
        in_anim_group.addAnimation(move_in_anim)
        in_anim_group.addAnimation(fade_in_anim)

        move_out_anim = QPropertyAnimation(self._welcome_label, b"geometry")
        move_out_anim.setDuration(2000)
        move_out_anim.setStartValue(end_rect)
        move_out_anim.setEndValue(start_rect)
        move_out_anim.setEasingCurve(QEasingCurve.Type.OutCubic)

        fade_out_anim = QPropertyAnimation(self._welcome_opacity_effect, b"opacity")
        fade_out_anim.setDuration(2000)
        fade_out_anim.setStartValue(1.0)
        fade_out_anim.setEndValue(0.0)
        fade_out_anim.setEasingCurve(QEasingCurve.Type.OutCubic)

        out_anim_group = QParallelAnimationGroup()
        out_anim_group.addAnimation(move_out_anim)
        out_anim_group.addAnimation(fade_out_anim)

        self._welcome_anim_group = QSequentialAnimationGroup()
        self._welcome_anim_group.addAnimation(in_anim_group)
        self._welcome_anim_group.addAnimation(QPauseAnimation(2000))
        self._welcome_anim_group.addAnimation(out_anim_group)

        self._welcome_anim_group.finished.connect(self._start_prompt_animation)
        self._welcome_anim_group.start()

    def _start_prompt_animation(self):
        center_x, center_y = self.width() // 2, self.height() // 2
        lw, lh = self._prompt_label.width(), self._prompt_label.height()

        start_rect = QRectF(center_x - lw // 2, center_y + lh // 2, lw, lh)
        end_rect = QRectF(center_x - lw // 2, center_y - lh // 2, lw, lh)

        move_in_anim = QPropertyAnimation(self._prompt_label, b"geometry")
        move_in_anim.setDuration(2000)
        move_in_anim.setStartValue(start_rect)
        move_in_anim.setEndValue(end_rect)
        move_in_anim.setEasingCurve(QEasingCurve.Type.OutCubic)

        # 4. 淡入动画（作用于 effect 的 opacity）
        fade_in_anim = QPropertyAnimation(self._prompt_opacity_effect, b"opacity")
        fade_in_anim.setDuration(2000)
        fade_in_anim.setStartValue(0.0)
        fade_in_anim.setEndValue(1.0)
        fade_in_anim.setEasingCurve(QEasingCurve.Type.OutCubic)

        in_anim_group = QParallelAnimationGroup()
        in_anim_group.addAnimation(move_in_anim)
        in_anim_group.addAnimation(fade_in_anim)

        move_out_anim = QPropertyAnimation(self._prompt_label, b"geometry")
        move_out_anim.setDuration(2000)
        move_out_anim.setStartValue(end_rect)
        move_out_anim.setEndValue(start_rect)
        move_out_anim.setEasingCurve(QEasingCurve.Type.OutCubic)

        fade_out_anim = QPropertyAnimation(self._prompt_opacity_effect, b"opacity")
        fade_out_anim.setDuration(2000)
        fade_out_anim.setStartValue(1.0)
        fade_out_anim.setEndValue(0.0)
        fade_out_anim.setEasingCurve(QEasingCurve.Type.OutCubic)

        out_anim_group = QParallelAnimationGroup()
        out_anim_group.addAnimation(move_out_anim)
        out_anim_group.addAnimation(fade_out_anim)

        self._prompt_anim_group = QSequentialAnimationGroup()
        self._prompt_anim_group.addAnimation(in_anim_group)

        self._prompt_anim_group.finished.connect(self._start_show_input_line_animation)
        self._prompt_anim_group.start()

    def _start_show_input_line_animation(self):
        center_x, center_y = self.width() // 2, self.height() // 2
        lw, lh = self._prompt_label.width(), self._prompt_label.height()

        start_rect = QRectF(center_x - lw // 2, center_y + lh * 2, lw, lh)
        end_rect = QRectF(center_x - lw // 2, center_y + lh, lw, lh)

        move_in_anim = QPropertyAnimation(self._input_line, b"geometry")
        move_in_anim.setDuration(2000)
        move_in_anim.setStartValue(start_rect)
        move_in_anim.setEndValue(end_rect)
        move_in_anim.setEasingCurve(QEasingCurve.Type.OutCubic)

        fade_in_anim = QPropertyAnimation(self._input_line_opacity_effect, b"opacity")
        fade_in_anim.setDuration(2000)
        fade_in_anim.setStartValue(0.0)
        fade_in_anim.setEndValue(1.0)
        fade_in_anim.setEasingCurve(QEasingCurve.Type.OutCubic)

        self._in_anim_group = QParallelAnimationGroup()
        self._in_anim_group.addAnimation(move_in_anim)
        self._in_anim_group.addAnimation(fade_in_anim)
        self._in_anim_group.finished.connect(self.on_input_line_shown)
        self._in_anim_group.start()

    def showEvent(self, event, /):
        super().showEvent(event)
        if not self._animation_started:
            self._start_icon_animation()
            self._animation_started = True

    def eventFilter(self, obj, e: QEvent):
        if obj is self.parent():
            if e.type() == QEvent.Type.Resize:
                if isinstance(e, QResizeEvent):
                    self.resize(e.size())
            elif e.type() == QEvent.Type.ChildAdded:
                self.raise_()

        return super().eventFilter(obj, e)

    def resizeEvent(self, e):
        iw, ih = self._icon_size.width(), self._icon_size.height()
        self._icon_widget.move(self.width() // 2 - iw // 2, self.height() // 2 - ih // 2)
        self._title_bar.resize(self.width(), self._title_bar.height())

    def finish(self):
        self.close()

    def paintEvent(self, e):
        painter = QPainter(self)
        painter.setPen(Qt.PenStyle.NoPen)

        c = 32 if isDarkTheme() else 255
        painter.setBrush(QColor(c, c, c))
        painter.drawRect(self.rect())

    @Slot()
    def on_input_line_shown(self):
        self._input_line.setFocus()
