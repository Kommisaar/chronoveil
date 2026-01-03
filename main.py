import sys

from PySide6.QtWidgets import QApplication

from chronoveil.controllers import MainController
from chronoveil.core.enums import Setting
from chronoveil.core.managers import LanguageManager
from chronoveil.core.managers import SettingsManager
from chronoveil.views import MainWindow

if __name__ == '__main__':
    # noinspection PyUnresolvedReferences
    import chronoveil.resources

    app = QApplication(sys.argv)
    settings_manager = SettingsManager(parent=app)

    language = settings_manager.get_value(Setting.GENERAL_LANGUAGE)
    language_manager = LanguageManager(app=app, language=language, parent=app)
    window = MainWindow()
    controller = MainController(
        main_window=window,
        settings_manager=settings_manager,
        language_manager=language_manager,
        parent=app
    )
    controller.run()
    sys.exit(app.exec())
