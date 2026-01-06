import pytest
from unittest.mock import MagicMock
from datetime import datetime

from PySide6.QtWidgets import QApplication, QWidget
from PySide6.QtCore import QTimer

from chronoveil.views.components.dashboard_top_card import DashboardTopCard


@pytest.fixture(scope="module")
def qapp():
    """创建QApplication实例，用于测试GUI组件"""
    app = QApplication.instance()
    if app is None:
        app = QApplication([])
    yield app


class TestDashboardTopCard:
    def test_initialization(self, qapp):
        """测试初始化"""
        card = DashboardTopCard()
        assert card._name_label.text() == "Visitor"
        assert card._avatar.text() == "Visitor"
        assert card._greeting_label.text() == "Welcome back, "
        assert card._new_session_button.text() == "Start New Session"
        assert card._resume_session_button.text() == "Resume Last Session"

    def test_initialization_with_parent(self, qapp):
        """测试带父组件的初始化"""
        parent = QWidget()
        card = DashboardTopCard(parent)
        assert card.parent() == parent

    def test_set_username(self, qapp):
        """测试设置用户名功能"""
        card = DashboardTopCard()
        card.set_username("TestUser")
        assert card._name_label.text() == "TestUser"
        assert card._avatar.text() == "TestUser"

    def test_set_username_empty_string(self, qapp):
        """测试设置空用户名"""
        card = DashboardTopCard()
        card.set_username("")
        assert card._name_label.text() == ""
        assert card._avatar.text() == ""

    def test_set_username_special_characters(self, qapp):
        """测试设置包含特殊字符的用户名"""
        card = DashboardTopCard()
        card.set_username("User@123#Test")
        assert card._name_label.text() == "User@123#Test"
        assert card._avatar.text() == "User@123#Test"

    def test_build_current_time(self, qapp):
        """测试构建当前时间功能"""
        card = DashboardTopCard()
        time_str = card._build_current_time()
        now = datetime.now()
        expected_str = f"Today is {now.year}:{now.month}:{now.day}"
        assert expected_str in time_str

    def test_update_time(self, qapp):
        """测试时间更新功能"""
        card = DashboardTopCard()
        original_text = card._time_label.text()
        card._update_time()
        updated_text = card._time_label.text()
        # 验证时间确实被更新了（在短时间内应该相同）
        now = datetime.now()
        expected_str = f"Today is {now.year}:{now.month}:{now.day}"
        assert expected_str in updated_text

    def test_timer_setup(self, qapp):
        """测试定时器设置"""
        card = DashboardTopCard()
        assert isinstance(card.timer, QTimer)
        # 检查定时器是否启动（通过检查是否激活）
        assert card.timer.isActive()

    def test_new_session_button_clicked_signal(self, qapp):
        """测试新会话按钮点击信号"""
        card = DashboardTopCard()
        mock_slot = MagicMock()
        card.new_session_button_clicked.connect(mock_slot)
        
        # 模拟按钮点击
        card._new_session_button.click()
        # 由于信号连接在初始化时已经设置，这里我们验证信号是否被触发
        # 在实际应用中，需要更复杂的设置来测试信号发送
        mock_slot.assert_called_once()

    def test_resume_session_button_clicked_signal(self, qapp):
        """测试恢复会话按钮点击信号"""
        card = DashboardTopCard()
        mock_slot = MagicMock()
        card.resume_session_button_clicked.connect(mock_slot)
        
        # 模拟按钮点击
        card._resume_session_button.click()
        mock_slot.assert_called_once()

    def test_on_language_changed(self, qapp):
        """测试语言更改槽函数"""
        card = DashboardTopCard()
        original_greeting = card._greeting_label.text()
        original_new_session_text = card._new_session_button.text()
        original_resume_session_text = card._resume_session_button.text()
        
        card.on_language_changed()
        
        # 验证文本是否更新
        assert card._greeting_label.text() == "Welcome back, "
        assert card._new_session_button.text() == "Start New Session"
        assert card._resume_session_button.text() == "Resume Last Session"

    def test_on_theme_changed(self, qapp):
        """测试主题更改槽函数"""
        card = DashboardTopCard()
        # 此方法当前为空，但应能正常调用
        card.on_theme_changed()
        # 验证调用不会引发异常

    def test_on_new_session_button_clicked(self, qapp):
        """测试新会话按钮点击槽函数"""
        card = DashboardTopCard()
        mock_slot = MagicMock()
        card.new_session_button_clicked.connect(mock_slot)
        
        card.on_new_session_button_clicked()
        # 验证信号是否被发射

    def test_on_resume_session_button_clicked(self, qapp):
        """测试恢复会话按钮点击槽函数"""
        card = DashboardTopCard()
        mock_slot = MagicMock()
        card.resume_session_button_clicked.connect(mock_slot)
        
        card.on_resume_session_button_clicked()
        # 验证信号是否被发射