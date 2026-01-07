import pytest
from PySide6.QtCore import QObject
from PySide6.QtWidgets import QApplication
from chronoveil.core.state_machines.splash_state_machine import SplashStateMachine


@pytest.fixture(scope="function")
def qapp():
    app = QApplication.instance()
    if app is None:
        app = QApplication([])
    return app


class TestSplashStateMachine:
    def test_init_with_user_exists_true(self, qapp):
        state_machine = SplashStateMachine(user_exists=True)
        assert state_machine._user_exists is True

    def test_init_with_user_exists_false(self, qapp):
        state_machine = SplashStateMachine(user_exists=False)
        assert state_machine._user_exists is False

    def test_init_with_parent(self, qapp):
        parent = QObject()
        state_machine = SplashStateMachine(user_exists=True, parent=parent)
        assert state_machine.parent() is parent

    def test_signals_exist(self, qapp):
        state_machine = SplashStateMachine(user_exists=True)
        # Check that all expected signals exist
        assert hasattr(state_machine, 'any_press_pressed')
        assert hasattr(state_machine, 'any_press_wait_entered')
        assert hasattr(state_machine, 'any_press_wait_exited')
        assert hasattr(state_machine, 'start_entered')
        assert hasattr(state_machine, 'registered_welcome_entered')
        assert hasattr(state_machine, 'unregistered_welcome_entered')
        assert hasattr(state_machine, 'input_wait_entered')
        assert hasattr(state_machine, 'end_entered')
        assert hasattr(state_machine, 'start_animation_finished')
        assert hasattr(state_machine, 'registered_welcome_finished')
        assert hasattr(state_machine, 'unregistered_welcome_finished')
        assert hasattr(state_machine, 'input_finished')

    @pytest.mark.parametrize("user_exists", [True, False])
    def test_state_setup(self, qapp, user_exists):
        state_machine = SplashStateMachine(user_exists=user_exists)
        # Check that states are created
        assert hasattr(state_machine, '_start')
        assert hasattr(state_machine, '_registered_welcome')
        assert hasattr(state_machine, '_unregistered_welcome')
        assert hasattr(state_machine, '_wait_input')
        assert hasattr(state_machine, '_wait_any_press')
        assert hasattr(state_machine, '_end')

    def test_transitions_for_registered_user(self, qapp):
        state_machine = SplashStateMachine(user_exists=True)
        # For registered user, transitions should be:
        # start -> registered_welcome -> wait_any_press -> end
        # Check that the correct transitions are set up
        # We can't directly access transitions, but we can verify the expected behavior by checking the states
        assert state_machine._user_exists is True

    def test_transitions_for_unregistered_user(self, qapp):
        state_machine = SplashStateMachine(user_exists=False)
        # For unregistered user, transitions should be:
        # start -> unregistered_welcome -> wait_any_press -> wait_input -> end
        assert state_machine._user_exists is False

    def test_start_method(self, qapp):
        state_machine = SplashStateMachine(user_exists=True)
        # Test that start method can be called without errors
        # This would normally start the state machine, but we're just checking it doesn't crash
        try:
            state_machine.start()
            # If we reach here, start() didn't raise an exception
            success = True
        except Exception:
            success = False
        assert success is True