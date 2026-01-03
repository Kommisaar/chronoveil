from enum import StrEnum


class LLMAPIFormat(StrEnum):
    def __new__(cls, value: str, label: str):
        obj = str.__new__(cls, value)
        obj._value_ = value
        obj.label = label
        return obj

    OPENAI = "openai", "OpenAI"
