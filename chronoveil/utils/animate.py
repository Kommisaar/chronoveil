from PySide6.QtCore import QEasingCurve
from PySide6.QtCore import QParallelAnimationGroup
from PySide6.QtCore import QPropertyAnimation
from PySide6.QtCore import QRectF
from PySide6.QtCore import QSequentialAnimationGroup
from PySide6.QtWidgets import QGraphicsOpacityEffect
from PySide6.QtWidgets import QWidget


def create_opacity_animation(
        opacity_effect: QGraphicsOpacityEffect,
        duration: int,
        start_value: float,
        end_value: float,
        easing_curve: QEasingCurve
) -> QPropertyAnimation:
    anim = QPropertyAnimation(opacity_effect, b"opacity")
    anim.setDuration(duration)
    anim.setStartValue(start_value)
    anim.setEndValue(end_value)
    anim.setEasingCurve(easing_curve)
    return anim


def create_geometry_animation(
        widget: QWidget,
        duration: int,
        start_value: QRectF,
        end_value: QRectF,
        easing_curve: QEasingCurve
) -> QPropertyAnimation:
    anim = QPropertyAnimation(widget, b"geometry")
    anim.setDuration(duration)
    anim.setStartValue(start_value)
    anim.setEndValue(end_value)
    anim.setEasingCurve(easing_curve)
    return anim


def create_opacity_geometry_animation_group(
        widget: QWidget,
        opacity_effect: QGraphicsOpacityEffect,
        duration: int,
        start_opacity: float,
        end_opacity: float,
        start_rect: QRectF,
        end_rect: QRectF,
        easing_curve: QEasingCurve
) -> QParallelAnimationGroup:
    opacity_anim = create_opacity_animation(opacity_effect, duration, start_opacity, end_opacity, easing_curve)
    geometry_anim = create_geometry_animation(widget, duration, start_rect, end_rect, easing_curve)
    anim_group = QParallelAnimationGroup()
    anim_group.addAnimation(opacity_anim)
    anim_group.addAnimation(geometry_anim)

    return anim_group

def create_blinking_animation(
        opacity_effect: QGraphicsOpacityEffect,
        duration: int = 1000,
        start_opacity: float = 1,
        end_opacity: float = 0.6,
        easing_curve: QEasingCurve = QEasingCurve.Type.InOutSine
) -> QParallelAnimationGroup:
    opacity_anim = create_opacity_animation(opacity_effect, duration, start_opacity, end_opacity, easing_curve)
    reversed_opacity_anim = create_opacity_animation(opacity_effect, duration, end_opacity, start_opacity, easing_curve)
    anim_group = QSequentialAnimationGroup()
    anim_group.addAnimation(opacity_anim)
    anim_group.addAnimation(reversed_opacity_anim)
    anim_group.setLoopCount(-1)
    return anim_group