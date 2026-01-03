from enum import StrEnum


class Language(StrEnum):
    def __new__(cls, value: str, label: str):
        obj = str.__new__(cls, value)
        obj._value_ = value
        obj.label = label
        return obj

    ENGLISH = "en_US", "English"
    SIMPLIFIED_CHINESE = "zh_CN", "简体中文"
