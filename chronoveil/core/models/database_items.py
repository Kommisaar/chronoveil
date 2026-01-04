from __future__ import annotations

from datetime import datetime
from typing import Iterable

from pydantic import BaseModel

from chronoveil.core.orm import SessionMessage
from chronoveil.core.orm import User
from chronoveil.core.orm import UserSession


class UserItem(BaseModel):
    id: int
    username: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_model(cls, model: User) -> UserItem:
        return cls(
            id=model.id,
            username=model.username,
            created_at=model.created_at,
            updated_at=model.updated_at,
        )

    @classmethod
    def from_models(cls, models: Iterable[User]) -> list[UserItem]:
        return [cls.from_model(model) for model in models]


class UserSessionItem(BaseModel):
    id: int
    user_id: int
    created_at: datetime
    updated_at: datetime

    title: str
    description: str

    @classmethod
    def from_model(cls, model: UserSession) -> UserSessionItem:
        return cls(
            id=model.id,
            user_id=model.user_id,
            created_at=model.created_at,
            updated_at=model.updated_at,
            title=model.title,
            description=model.description,
        )

    @classmethod
    def from_models(cls, models: Iterable[UserSession]) -> list[UserSessionItem]:
        return [cls.from_model(model) for model in models]


class SessionMessageItem(BaseModel):
    id: int
    session_id: int
    created_at: datetime
    updated_at: datetime

    role: str
    visual_role: str
    content: str

    @classmethod
    def from_model(cls, model: SessionMessage) -> SessionMessageItem:
        return cls(
            id=model.id,
            session_id=model.session_id,
            created_at=model.created_at,
            updated_at=model.updated_at,
            role=model.role,
            visual_role=model.visual_role,
            content=model.content,
        )

    @classmethod
    def from_models(cls, models: Iterable[SessionMessage]) -> list[SessionMessageItem]:
        return [cls.from_model(model) for model in models]
