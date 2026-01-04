from collections.abc import Callable
from pathlib import Path

from PySide6.QtCore import QObject
from sqlalchemy import create_engine
from sqlalchemy import event
from sqlalchemy.orm import Session
from sqlalchemy.orm import sessionmaker

from chronoveil.core.orm import BaseORM
from chronoveil.utils import get_logger


class DatabaseManager(QObject):
    def __init__(self, database_path: str, parent: QObject | None = None):
        super().__init__(parent=parent)
        self._logger = get_logger(self.__class__.__name__)
        db_path = Path(database_path).resolve()
        db_path.parent.mkdir(parents=True, exist_ok=True)

        database_url = f"sqlite:///{db_path.as_posix()}"
        self._engine = create_engine(database_url)

        @event.listens_for(self._engine, "connect")
        def set_sqlite_pragma(dbapi_connection, connection_record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

        self._session_maker = sessionmaker(bind=self._engine)
        BaseORM.metadata.create_all(self._engine)


class DatabaseWorker:
    def __init__(self, session_maker: Callable[[], Session]):
        self._session_maker = session_maker
