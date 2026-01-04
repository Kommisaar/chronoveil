from pydantic import BaseModel
from pydantic import Field

from chronoveil.core.enums import LLMAPIFormat


class LLMSettings(BaseModel):
    api_format: LLMAPIFormat | None = Field(default=None)
    base_url: str | None = Field(default=None)
    model_name: str | None = Field(default=None)
    api_key: str | None = Field(default=None)
