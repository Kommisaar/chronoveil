from typing import Any
from typing import Callable

from PySide6.QtCore import QObject
from PySide6.QtCore import QRunnable
from PySide6.QtCore import Signal
from sqlalchemy.orm.session import sessionmaker


class DataBaseSignal(QObject):
    finished = Signal(object, str)  # (result, error_message)


class DatabaseTask(QRunnable):
    def __init__(
            self,
            session_maker: sessionmaker,
            func: Callable[..., Any],
            **kwargs
    ):
        super().__init__()
        self.session_maker = session_maker
        self.func = func
        self.kwargs = kwargs
        self.signals = DataBaseSignal()

    def run(self):
        try:
            result = self.func(self.session_maker, **self.kwargs)
            self.signals.finished.emit(result, "")
        except Exception as e:
            self.signals.finished.emit(None, str(e))
