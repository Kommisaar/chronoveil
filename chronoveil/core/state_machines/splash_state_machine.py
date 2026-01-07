from PySide6.QtCore import QObject
from PySide6.QtCore import Signal
from PySide6.QtStateMachine import QState
from PySide6.QtStateMachine import QStateMachine


class SplashStateMachine(QObject):
    any_press_pressed = Signal()

    any_press_wait_entered = Signal()
    any_press_wait_exited = Signal()

    start_entered = Signal()
    registered_welcome_entered = Signal()
    unregistered_welcome_entered = Signal()
    input_wait_entered = Signal()
    end_entered = Signal()

    start_animation_finished = Signal()
    registered_welcome_finished = Signal()
    unregistered_welcome_finished = Signal()
    input_finished = Signal()

    def __init__(self, user_exists: bool, parent: QObject | None = None):
        super().__init__(parent)
        self._user_exists = user_exists
        self._machine = QStateMachine(parent=self)

        self._setup_states()
        self._setup_connections()
        self._setup_transitions()

    def _setup_states(self):
        self._start = QState(parent=self._machine)
        self._registered_welcome = QState(parent=self._machine)
        self._unregistered_welcome = QState(parent=self._machine)
        self._wait_input = QState(parent=self._machine)
        self._wait_any_press = QState(parent=self._machine)
        self._end = QState(parent=self._machine)

        states = [
            self._start,
            self._registered_welcome,
            self._unregistered_welcome,
            self._wait_input,
            self._wait_any_press,
            self._end,
        ]

        for state in states:
            self._machine.addState(state)

        self._machine.setInitialState(self._start)

    def _setup_connections(self):
        self._start.entered.connect(self.start_entered.emit)
        self._registered_welcome.entered.connect(self.registered_welcome_entered.emit)
        self._unregistered_welcome.entered.connect(self.unregistered_welcome_entered.emit)
        self._wait_input.entered.connect(self.input_wait_entered.emit)
        self._wait_any_press.entered.connect(self.any_press_wait_entered.emit)
        self._wait_any_press.exited.connect(self.any_press_wait_exited.emit)
        self._end.entered.connect(self.end_entered.emit)

    def _setup_transitions(self):
        if self._user_exists:
            self._start.addTransition(self.start_animation_finished, self._registered_welcome)
            self._registered_welcome.addTransition(self.registered_welcome_finished, self._wait_any_press)
            self._wait_any_press.addTransition(self.any_press_pressed, self._end)
        else:
            self._start.addTransition(self.start_animation_finished, self._unregistered_welcome)
            self._unregistered_welcome.addTransition(self.unregistered_welcome_finished, self._wait_any_press)
            self._wait_any_press.addTransition(self.any_press_pressed, self._wait_input)
            self._wait_input.addTransition(self.input_finished, self._end)

    def start(self):
        self._machine.start()
