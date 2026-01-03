from enum import StrEnum


class Theme(StrEnum):
    def __new__(cls, value: str, label: str):
        obj = str.__new__(cls, value)
        obj._value_ = value
        obj.label = label
        return obj

    LIGHT = "light", "Light"
    # DARK = "dark", "Dark"
