from PySide6.QtWidgets import QWidget


class ChatView(QWidget):
    def __init__(self):
        super().__init__()
        self.setObjectName("ChatView")
