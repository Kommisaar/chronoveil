from enum import StrEnum

from chronoveil.core.enums import LLMAPIFormat
from chronoveil.core.enums.language import Language
from chronoveil.core.enums.theme import Theme


class Setting(StrEnum):
    def __new__(cls, value: str, value_type: type):
        obj = str.__new__(cls, value)
        obj._value_ = value
        obj.value_type = value_type
        return obj

    # LLM Setting
    LLM_API_FORMAT = "llm/api_format", LLMAPIFormat
    LLM_BASE_URL = "llm/base_url", str
    LLM_API_KEY = "llm/api_key", str
    LLM_MODEL_NAME = "llm/model_name", str

    # General Setting
    GENERAL_LANGUAGE = "general/language", Language
    GENERAL_THEME = "general/theme", Theme
