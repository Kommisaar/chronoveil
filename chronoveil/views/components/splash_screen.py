import sys

from PySide6.QtCore import QEasingCurve
from PySide6.QtCore import QEvent
from PySide6.QtCore import QParallelAnimationGroup
from PySide6.QtCore import QRect
from PySide6.QtCore import QRectF
from PySide6.QtCore import QSequentialAnimationGroup
from PySide6.QtCore import QSize
from PySide6.QtCore import Qt
from PySide6.QtCore import Signal
from PySide6.QtCore import Slot
from PySide6.QtGui import QColor
from PySide6.QtGui import QIcon
from PySide6.QtGui import QPainter
from PySide6.QtGui import QResizeEvent
from PySide6.QtWidgets import QGraphicsDropShadowEffect
from PySide6.QtWidgets import QGraphicsOpacityEffect
from PySide6.QtWidgets import QHBoxLayout
from PySide6.QtWidgets import QWidget
from qfluentwidgets import ElevatedCardWidget
from qfluentwidgets import FluentStyleSheet
from qfluentwidgets import IconWidget
from qfluentwidgets import LineEdit
from qfluentwidgets import PrimaryPushButton
from qfluentwidgets import SubtitleLabel
from qfluentwidgets import TitleLabel
from qfluentwidgets import isDarkTheme
from qframelesswindow import TitleBar

from chronoveil.core.state_machines.splash_state_machine import SplashStateMachine
from chronoveil.utils import create_geometry_animation
from chronoveil.utils import create_opacity_geometry_animation_group
from chronoveil.utils.animate import create_blinking_animation


class SplashScreen(QWidget):
    any_press_pressed = Signal()

    def __init__(self,parent: QWidget | None = None):
        super().__init__(parent=parent)

        self._username: str | None = None

        if parent:
            parent.installEventFilter(self)

        self._setup_ui()
        self._setup_state_machine()

    def set_username(self, username: str):
        if username :
            registered_welcome_text = self.tr("欢迎回来！{username}").format(username=self._username)
            self._username = username
            self._registered_welcome_label.setText(registered_welcome_text)

    def _setup_ui(self):
        self._create_title_bar()
        self._create_icon()
        self._create_labels()
        self._create_input_area()
        self._create_continue_label()

    def _create_title_bar(self):
        self._title_bar = TitleBar(self)
        FluentStyleSheet.FLUENT_WINDOW.apply(self._title_bar)
        if sys.platform == "darwin":
            self._title_bar.hide()

    def _create_icon(self):
        self._icon_size = QSize(160, 160)
        self._icon_widget = IconWidget(QIcon(":/icons/bot.png"), self)
        self._icon_widget.resize(self._icon_size)

        shadow = QGraphicsDropShadowEffect(self)
        shadow.setColor(QColor(0, 0, 0, 50))
        shadow.setBlurRadius(15)
        shadow.setOffset(0, 4)
        self._icon_widget.setGraphicsEffect(shadow)

    def _create_labels(self):

        registered_welcome_text = self.tr("欢迎回来！{username}").format(username=self._username)
        self._registered_welcome_label = TitleLabel(registered_welcome_text, self)
        self._unregistered_welcome_label = TitleLabel(self.tr("哔哔！检测到新用户，准备开启愉快的探索之旅～"), self)
        self._prompt_label = TitleLabel(self.tr("哔哔！请告诉我您的名字吧～"), self)

        for label in [self._registered_welcome_label, self._unregistered_welcome_label, self._prompt_label]:
            effect = QGraphicsOpacityEffect(label)
            label.setGraphicsEffect(effect)
            effect.setOpacity(0)

        self._register_welcome_opacity_effect: QGraphicsOpacityEffect = self._registered_welcome_label.graphicsEffect()
        self._unregister_welcome_opacity_effect: QGraphicsOpacityEffect = self._unregistered_welcome_label.graphicsEffect()
        self._prompt_opacity_effect: QGraphicsOpacityEffect = self._prompt_label.graphicsEffect()

    def _create_input_area(self):
        self._input_line = LineEdit(self)
        self._input_line.setPlaceholderText("请输入您的名字")
        self._confirm_button = PrimaryPushButton("确定", self)

        self._input_area = ElevatedCardWidget(self)
        self._input_area.resize(400, 60)
        layout = QHBoxLayout(self._input_area)
        layout.addWidget(self._input_line)
        layout.addWidget(self._confirm_button)

        self._input_area_opacity_effect = QGraphicsOpacityEffect()
        self._input_area.setGraphicsEffect(self._input_area_opacity_effect)
        self._input_area_opacity_effect.setOpacity(0)
        self._input_area.move(-100, -100)

    def _create_continue_label(self):
        self._continue_label = SubtitleLabel(self.tr("按任意键继续"), self)
        self._continue_opacity_effect = QGraphicsOpacityEffect(self._continue_label)
        self._continue_label.setGraphicsEffect(self._continue_opacity_effect)
        self._continue_opacity_effect.setOpacity(0)

    def _setup_state_machine(self):
        username_exists = self._username is not None

        self._state_machine = SplashStateMachine(username_exists, parent=self)
        self._state_machine.start_entered.connect(self.on_start_entered)
        self._state_machine.registered_welcome_entered.connect(self.on_registered_welcome_entered)
        self._state_machine.unregistered_welcome_entered.connect(self.on_unregistered_welcome_entered)
        self._state_machine.input_wait_entered.connect(self.on_wait_input_entered)
        self._state_machine.end_entered.connect(self.on_end_entered)

        self._state_machine.any_press_wait_entered.connect(self.on_wait_any_press_entered)
        self._state_machine.any_press_wait_exited.connect(self.on_wait_any_press_finished)

        self.any_press_pressed.connect(self._state_machine.any_press_pressed)

    def _setup_animations(self):
        self._continue_blink_anim = create_blinking_animation(self._continue_opacity_effect)

        self._start_entered_anim = self._create_start_entered_animation()
        self._registered_welcome_entered_anim = self._create_registered_welcome_entered_animation()
        self._unregistered_welcome_entered_anim = self._create_unregistered_welcome_entered_animation()
        self._wait_input_entered_anim = self._create_wait_input_entered_animation()
        self._end_anim = self._create_end_animation()

    def _create_start_entered_animation(self):
        icon_anim = self._create_icon_animation()

        anim_group = QSequentialAnimationGroup()
        anim_group.addAnimation(icon_anim)
        return anim_group

    def _create_registered_welcome_entered_animation(self):
        show_registered_welcome_anim = self._create_fade_slide_animation(self._registered_welcome_label, self._register_welcome_opacity_effect)
        show_continue_anim = self._create_fade_slide_animation(self._continue_label, self._continue_opacity_effect, offset=2)

        anim_group = QSequentialAnimationGroup()
        anim_group.addAnimation(show_registered_welcome_anim)
        anim_group.addAnimation(show_continue_anim)
        return anim_group

    def _create_unregistered_welcome_entered_animation(self):
        show_unregistered_welcome_anim = self._create_fade_slide_animation(self._unregistered_welcome_label, self._unregister_welcome_opacity_effect)
        show_continue_anim = self._create_fade_slide_animation(self._continue_label, self._continue_opacity_effect, offset=2)

        anim_group = QSequentialAnimationGroup()
        anim_group.addAnimation(show_unregistered_welcome_anim)
        anim_group.addAnimation(show_continue_anim)
        return anim_group

    def _create_wait_input_entered_animation(self):
        hide_unregistered_welcome_anim = self._create_fade_slide_animation(self._unregistered_welcome_label, self._unregister_welcome_opacity_effect,
                                                                           reverse=True)
        hide_continue_anim = self._create_fade_slide_animation(self._continue_label, self._continue_opacity_effect, offset=2, reverse=True)
        show_input_anim = self._create_fade_slide_animation(self._input_area, self._input_area_opacity_effect, offset=1)
        show_prompt_anim = self._create_fade_slide_animation(self._prompt_label, self._prompt_opacity_effect)

        anim_group = QSequentialAnimationGroup()
        anim_group.addAnimation(hide_continue_anim)
        anim_group.addAnimation(hide_unregistered_welcome_anim)
        anim_group.addAnimation(show_prompt_anim)
        anim_group.addAnimation(show_input_anim)
        return anim_group

    def _create_end_animation(self):
        width = self.width()
        height = self.height()
        start_rect = QRect(0, 0, width, height)
        end_rect = QRect(0, - height, width, height)
        self_slide_anim = create_geometry_animation(self, 1500, start_rect, end_rect, QEasingCurve.Type.OutBounce)
        anim_group = QSequentialAnimationGroup()
        anim_group.addAnimation(self_slide_anim)
        return anim_group

    @Slot()
    def on_start_entered(self):
        self._start_entered_anim.finished.connect(self._state_machine.start_animation_finished)
        self._start_entered_anim.start()

    @Slot()
    def on_registered_welcome_entered(self):
        self._registered_welcome_entered_anim.finished.connect(self._state_machine.registered_welcome_finished)
        self._registered_welcome_entered_anim.start()

    @Slot()
    def on_unregistered_welcome_entered(self):
        self._unregistered_welcome_entered_anim.finished.connect(self._state_machine.unregistered_welcome_finished)
        self._unregistered_welcome_entered_anim.start()

    @Slot()
    def on_wait_input_entered(self):
        self._wait_input_entered_anim.finished.connect(self._state_machine.input_finished)
        self._wait_input_entered_anim.start()

    @Slot()
    def on_wait_any_press_entered(self):
        self.setFocus()
        self._continue_blink_anim.start()

    @Slot()
    def on_end_entered(self):
        self._end_anim.finished.connect(self.on_finished)
        self._end_anim.start()

    @Slot()
    def on_wait_any_press_finished(self):
        self.clearFocus()
        self._continue_blink_anim.stop()

    @Slot()
    def on_finished(self):
        self.close()

    def _create_icon_animation(self) -> QParallelAnimationGroup:
        center_x, center_y = self.width() // 2, self.height() // 2
        iw, ih = self._icon_size.width(), self._icon_size.height()
        start_rect = QRectF(center_x - iw // 2, 0, iw, ih)
        end_rect = QRectF(center_x - ih // 2, center_y - ih // 2, iw, ih)

        easing_curve = QEasingCurve(QEasingCurve.Type.OutElastic)
        easing_curve.setAmplitude(2)
        easing_curve.setPeriod(0.5)
        scale_anim = create_geometry_animation(self._icon_widget, 1500, start_rect, end_rect, easing_curve)

        move_up_distance = ih * 3 // 4
        final_rect = QRectF(center_x - iw // 2, center_y - ih // 2 - move_up_distance, iw, ih)

        move_anim = create_geometry_animation(self._icon_widget, 1000, end_rect, final_rect, QEasingCurve.Type.OutCubic)

        icon_anim = QSequentialAnimationGroup()
        icon_anim.addAnimation(scale_anim)
        icon_anim.addAnimation(move_anim)

        return icon_anim

    def _create_fade_slide_animation(
            self,
            widget: QWidget,
            opacity_effect: QGraphicsOpacityEffect,
            duration: int = 1000,
            dy: float = 0.5,
            offset: float = 0,
            easing_curve: QEasingCurve.Type = QEasingCurve.Type.OutCubic,
            reverse: bool = False
    ):
        center_x, center_y = self.width() // 2, self.height() // 2
        width, height = widget.width(), widget.height()

        start_y = center_y + (offset + (dy if not reverse else -dy)) * height
        end_y = center_y + (offset + (-dy if not reverse else dy)) * height

        start_rect = QRectF(center_x - width // 2, start_y, width, height)
        end_rect = QRectF(center_x - width // 2, end_y, width, height)

        start_opacity, end_opacity = (0, 1) if not reverse else (1, 0)

        return create_opacity_geometry_animation_group(
            widget, opacity_effect, duration, start_opacity, end_opacity, start_rect, end_rect, easing_curve
        )

    def start(self):
        self._setup_animations()
        self._setup_state_machine()
        self._state_machine.start()

    def eventFilter(self, obj, e: QEvent):
        if obj is self.parent():
            if e.type() == QEvent.Type.Resize:
                if isinstance(e, QResizeEvent):
                    self.resize(e.size())
            elif e.type() == QEvent.Type.ChildAdded:
                self.raise_()

        return super().eventFilter(obj, e)

    def resizeEvent(self, e):
        self._title_bar.resize(self.width(), self._title_bar.height())

    def paintEvent(self, e):
        painter = QPainter(self)
        painter.setPen(Qt.PenStyle.NoPen)

        c = 32 if isDarkTheme() else 255
        painter.setBrush(QColor(c, c, c))
        painter.drawRect(self.rect())

    def keyPressEvent(self, event):
        if event.isAutoRepeat():
            return

        key = event.key()

        modifier_keys = {
            Qt.Key.Key_Shift,
            Qt.Key.Key_Control,
            Qt.Key.Key_Alt,
            Qt.Key.Key_Meta,
            Qt.Key.Key_CapsLock,
            Qt.Key.Key_NumLock,
            Qt.Key.Key_ScrollLock,
            Qt.Key.Key_Tab,
            Qt.Key.Key_Escape,
        }

        if key not in modifier_keys:
            self.any_press_pressed.emit()
        else:
            super().keyPressEvent(event)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.any_press_pressed.emit()
        super().mousePressEvent(event)
