from unittest.mock import MagicMock

import pytest

from chronoveil.core.tasks import DataBaseSignals
from chronoveil.core.tasks import DatabaseTask


# noinspection PyUnusedLocal
def mock_success_function(session_maker, **kwargs):
    """模拟成功执行的函数"""
    return kwargs.get('value', 42)


# noinspection PyUnusedLocal
def mock_exception_function(session_maker, **kwargs):
    """模拟抛出异常的函数"""
    raise ValueError("Test exception")


class TestDatabaseTask:
    def test_database_task_initialization(self):
        """测试 DatabaseTask 初始化"""
        session_maker = MagicMock()
        task = DatabaseTask(session_maker, mock_success_function, value=100)

        assert task.session_maker == session_maker
        assert task.func == mock_success_function
        assert task.kwargs == {'value': 100}
        assert isinstance(task.signals, DataBaseSignals)

    def test_database_task_run_success(self):
        """测试 DatabaseTask 成功执行"""
        session_maker = MagicMock()
        task = DatabaseTask(session_maker, mock_success_function, value=100)

        # 连接信号以捕获结果
        result_received = []
        error_received = []

        def capture_result(result, error):
            result_received.append(result)
            error_received.append(error)

        task.signals.finished.connect(capture_result)

        # 运行任务
        task.run()

        # 验证结果
        assert len(result_received) == 1
        assert result_received[0] == 100
        assert error_received[0] == ""

    def test_database_task_run_exception(self):
        """测试 DatabaseTask 执行时抛出异常"""
        session_maker = MagicMock()
        task = DatabaseTask(session_maker, mock_exception_function)

        # 连接信号以捕获结果
        result_received = []
        error_received = []

        def capture_result(result, error):
            result_received.append(result)
            error_received.append(error)

        task.signals.finished.connect(capture_result)

        # 运行任务
        task.run()

        # 验证结果
        assert len(result_received) == 1
        assert result_received[0] is None
        assert error_received[0] == "Test exception"

    @pytest.mark.parametrize("input_value,expected_result", [
        (10, 10),
        (0, 0),
        (-5, -5),
        ("test", "test"),
        ([1, 2, 3], [1, 2, 3]),
    ])
    def test_database_task_with_different_values(self, input_value, expected_result):
        """使用参数化测试不同输入值"""
        session_maker = MagicMock()
        task = DatabaseTask(session_maker, mock_success_function, value=input_value)

        result_received = []
        error_received = []

        def capture_result(result, error):
            result_received.append(result)
            error_received.append(error)

        task.signals.finished.connect(capture_result)
        task.run()

        assert len(result_received) == 1
        assert result_received[0] == expected_result
        assert error_received[0] == ""

    def test_database_task_with_empty_kwargs(self):
        """测试 DatabaseTask 无额外参数"""
        session_maker = MagicMock()
        task = DatabaseTask(session_maker, mock_success_function)

        result_received = []
        error_received = []

        def capture_result(result, error):
            result_received.append(result)
            error_received.append(error)

        task.signals.finished.connect(capture_result)
        task.run()

        assert len(result_received) == 1
        assert result_received[0] == 42  # 默认值
        assert error_received[0] == ""

    def test_database_task_with_multiple_kwargs(self):
        """测试 DatabaseTask 多个参数"""
        session_maker = MagicMock()
        task = DatabaseTask(
            session_maker,
            lambda sm, **kw: f"{kw.get('name', 'Unknown')} is {kw.get('age', 0)} years old",
            name="Alice",
            age=30
        )

        result_received = []
        error_received = []

        def capture_result(result, error):
            result_received.append(result)
            error_received.append(error)

        task.signals.finished.connect(capture_result)
        task.run()

        assert len(result_received) == 1
        assert result_received[0] == "Alice is 30 years old"
        assert error_received[0] == ""


class TestDatabaseSignal:
    def test_database_signal_initialization(self):
        """测试 DataBaseSignal 初始化"""
        signal = DataBaseSignals()
        assert hasattr(signal, 'finished')
        # 验证 finished 信号的参数类型 (object, str)
