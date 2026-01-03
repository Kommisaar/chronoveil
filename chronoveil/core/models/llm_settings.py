from pydantic import BaseModel

from chronoveil.core.enums import LLMAPIFormat


class LLMSettings(BaseModel):
    api_format: LLMAPIFormat | None
    base_url: str | None
    model_name: str | None
    api_key: str | None
