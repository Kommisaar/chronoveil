import logging
import pytest
from chronoveil.utils.logger import get_logger


def test_get_logger_normal():
    """测试正常获取logger实例"""
    logger = get_logger("test_logger")
    assert isinstance(logger, logging.Logger)
    assert logger.name == "test_logger"
    assert logger.level == logging.DEBUG


def test_get_logger_with_custom_level():
    """测试使用自定义级别获取logger"""
    logger = get_logger("test_logger_with_level", logging.WARNING)
    assert isinstance(logger, logging.Logger)
    assert logger.name == "test_logger_with_level"
    assert logger.level == logging.WARNING


def test_get_logger_reuse_existing():
    """测试获取已存在的logger（Python logging模块的单例特性）"""
    logger1 = get_logger("reuse_test_logger")
    logger2 = get_logger("reuse_test_logger")
    # 由于logging模块的单例特性，相同名称的logger应该是同一个实例
    assert logger1 is logger2
    assert logger1.name == logger2.name == "reuse_test_logger"


@pytest.mark.parametrize("name, level", [
    ("", logging.DEBUG),
    ("simple", logging.INFO),
    ("complex_name_with_underscores", logging.ERROR),
    ("logger123", logging.CRITICAL),
])
def test_get_logger_parametrized(name, level):
    """参数化测试不同名称和级别的logger"""
    logger = get_logger(name, level)
    expected_name = 'root' if name == "" else name
    assert logger.name == expected_name
    assert logger.level == level


def test_get_logger_handler_added():
    """测试logger是否正确添加了处理器"""
    logger = get_logger("handler_test_logger")
    assert len(logger.handlers) >= 1  # 至少有一个处理器（可能之前已存在）
    
    # 验证处理器类型和格式
    stream_handler = None
    for handler in logger.handlers:
        if isinstance(handler, logging.StreamHandler):
            stream_handler = handler
            break
    
    assert stream_handler is not None
    assert isinstance(stream_handler.formatter, logging.Formatter)
    
    # 检查格式器是否正确设置
    expected_format = "[%(asctime)s] - [%(name)s] - [%(levelname)s] - %(message)s"
    assert stream_handler.formatter._fmt == expected_format