from PySide6.QtCore import QLocale
from PySide6.QtCore import QObject
from PySide6.QtCore import QTranslator
from PySide6.QtGui import QGuiApplication

from chronoveil.core.enums import Language
from chronoveil.utils import get_logger


class LanguageManager(QObject):

    def __init__(self, app: QGuiApplication, language: Language | None, parent: QObject | None = None):
        super().__init__(parent)
        self._logger = get_logger(self.__class__.__name__)

        self._app = app
        self._translator = QTranslator(self)
        self._current_language: Language | None = language

        self._setup_translator()

    def _setup_translator(self)-> None:
        sys_language = QLocale.system().name()
        try:
            if self._current_language is not None:
                language = self._current_language
            else:
                language = Language(sys_language)

            self.switch_translator(language)
            self._current_language = language
        except ValueError:
            self._logger.warning(f"Not supported language: {sys_language}, using English instead")
            language = Language.ENGLISH
            self.switch_translator(language)
            self._current_language = language

    def switch_translator(self, language: Language)-> None:
        self._app.removeTranslator(self._translator)
        self._current_language = language
        self._translator.load(f":/translations/{language.value}.qm")
        self._app.installTranslator(self._translator)
