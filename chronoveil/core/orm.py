from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime
from sqlalchemy import ForeignKey
from sqlalchemy import Integer
from sqlalchemy import Text
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.orm import Mapped
from sqlalchemy.orm import mapped_column
from sqlalchemy.orm import relationship


class BaseORM(DeclarativeBase):
    __abstract__ = True

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now, onupdate=datetime.now)


class User(BaseORM):
    __tablename__ = "users"

    username: Mapped[str] = mapped_column(Text, nullable=False, index=True)

    sessions: Mapped[list[UserSession]] = relationship(back_populates="user", cascade="all, delete-orphan", passive_deletes=True)


class UserSession(BaseORM):
    __tablename__ = "session"

    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)

    title: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    description: Mapped[str] = mapped_column(Text, nullable=False, index=True)

    user: Mapped[User] = relationship(back_populates="sessions")
    messages: Mapped[list[SessionMessage]] = relationship(back_populates="session", cascade="all, delete-orphan", passive_deletes=True)


class SessionMessage(BaseORM):
    __tablename__ = "session_message"

    session_id: Mapped[int] = mapped_column(Integer, ForeignKey("session.id", ondelete="CASCADE"), nullable=False, index=True)

    role: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    visual_role: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    content: Mapped[str] = mapped_column(Text, nullable=False, index=True)

    session: Mapped[UserSession] = relationship(back_populates="messages")
