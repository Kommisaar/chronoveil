import sys

import pytest
from PySide6.QtGui import QImage
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import QApplication

from chronoveil.utils.blur import gaussian_blur_pixmap


@pytest.fixture(scope="session")
def app():
    """提供一个 QApplication 实例用于整个测试会话"""
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv)
    return app


def create_test_pixmap(width=100, height=100):
    """创建一个测试用的Pixmap"""
    image = QImage(width, height, QImage.Format.Format_ARGB32)
    image.fill(0xFFFFFFFF)  # 填充白色
    return QPixmap.fromImage(image)


def test_gaussian_blur_pixmap_normal(app):
    """测试正常输入"""
    pixmap = create_test_pixmap()
    radius = 5

    result = gaussian_blur_pixmap(pixmap, radius)

    # 结果应该是一个QPixmap对象
    assert isinstance(result, QPixmap)
    # 尺寸应该保持不变
    assert result.width() == pixmap.width()
    assert result.height() == pixmap.height()


def test_gaussian_blur_pixmap_default_radius(app):
    """测试默认半径"""
    pixmap = create_test_pixmap()

    result = gaussian_blur_pixmap(pixmap)  # 使用默认半径15

    assert isinstance(result, QPixmap)
    assert result.width() == pixmap.width()
    assert result.height() == pixmap.height()


@pytest.mark.parametrize("radius", [1, 5, 10, 20])
def test_gaussian_blur_pixmap_different_radii(radius, app):
    """测试不同半径值"""
    pixmap = create_test_pixmap()

    result = gaussian_blur_pixmap(pixmap, radius)

    assert isinstance(result, QPixmap)
    assert result.width() == pixmap.width()
    assert result.height() == pixmap.height()


def test_gaussian_blur_pixmap_radius_zero(app):
    """测试半径为0的情况"""
    pixmap = create_test_pixmap()
    radius = 0

    result = gaussian_blur_pixmap(pixmap, radius)

    # 当半径 <= 0 时，应返回原始 pixmap
    assert result == pixmap


def test_gaussian_blur_pixmap_negative_radius(app):
    """测试负半径的情况"""
    pixmap = create_test_pixmap()
    radius = -5

    result = gaussian_blur_pixmap(pixmap, radius)

    # 当半径 <= 0 时，应返回原始 pixmap
    assert result == pixmap


@pytest.mark.parametrize("width, height", [
    (50, 50),
    (100, 200),
    (300, 150),
    (1, 1),  # 最小尺寸
    (1000, 1000),  # 大尺寸
])
def test_gaussian_blur_pixmap_different_sizes(width, height, app):
    """测试不同图像尺寸"""
    pixmap = create_test_pixmap(width, height)

    result = gaussian_blur_pixmap(pixmap, radius=5)

    assert isinstance(result, QPixmap)
    assert result.width() == width
    assert result.height() == height


def test_gaussian_blur_pixmap_various_formats(app):
    """测试不同图像格式"""
    # 创建不同格式的图像
    image_argb32 = QImage(100, 100, QImage.Format.Format_ARGB32)
    image_argb32.fill(0xFFFF0000)  # 红色
    pixmap_argb32 = QPixmap.fromImage(image_argb32)

    result = gaussian_blur_pixmap(pixmap_argb32, radius=5)

    assert isinstance(result, QPixmap)
    assert result.width() == pixmap_argb32.width()
    assert result.height() == pixmap_argb32.height()
