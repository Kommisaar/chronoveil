from sqlalchemy import delete
from sqlalchemy import select
from sqlalchemy import update
from sqlalchemy.orm import sessionmaker

from chronoveil.core.models import SessionMessageItem
from chronoveil.core.models import UserItem
from chronoveil.core.models import UserSessionItem
from chronoveil.core.orm import SessionMessage
from chronoveil.core.orm import User
from chronoveil.core.orm import UserSession


def add_user(session_maker: sessionmaker, username: str) -> int:
    with session_maker() as session:
        user = User(username=username)
        session.add(user)
        session.commit()
        return user.id


def delete_user(session_maker: sessionmaker, user_id: int) -> bool:
    with session_maker() as session:
        stmt = delete(User).where(User.id == user_id)
        delete_count = session.execute(stmt).rowcount
        session.commit()
        return delete_count > 0


def update_user(session_maker: sessionmaker, user_id: int, **kwargs) -> bool:
    if not kwargs:
        return False

    with session_maker() as session:
        stmt = update(User).where(User.id == user_id).values(**kwargs)
        result = session.execute(stmt)
        session.commit()
        return result.rowcount > 0


def get_user(session_maker: sessionmaker, user_id: int) -> UserItem | None:
    with session_maker() as session:
        stmt = select(User).where(User.id == user_id)
        model = session.execute(stmt).scalar_one_or_none()
        return UserItem.from_model(model) if model else None


def get_all_users(session_maker: sessionmaker) -> list[UserItem]:
    with session_maker() as session:
        stmt = select(User)
        models = session.execute(stmt).scalars().all()
        return UserItem.from_models(models)


def add_user_session(session_maker: sessionmaker, user_id: int, title: str, description: str) -> int:
    with session_maker() as session:
        user_session = UserSession(user_id=user_id, title=title, description=description)
        session.add(user_session)
        session.commit()
        return user_session.id


def delete_user_session(session_maker: sessionmaker, session_id: int) -> bool:
    with session_maker() as session:
        stmt = delete(UserSession).where(UserSession.id == session_id)
        delete_count = session.execute(stmt).rowcount
        session.commit()
        return delete_count > 0


def update_user_session(session_maker: sessionmaker, session_id: int, **kwargs) -> bool:
    if not kwargs:
        return False

    with session_maker() as session:
        stmt = update(UserSession).where(UserSession.id == session_id).values(**kwargs)
        result = session.execute(stmt)
        session.commit()
        return result.rowcount > 0


def get_user_session_by_user_id(session_maker: sessionmaker, user_id: int) -> list[UserSessionItem]:
    with session_maker() as session:
        stmt = select(UserSession).where(UserSession.user_id == user_id)
        models = session.execute(stmt).scalars().all()
        return UserSessionItem.from_models(models)


def add_session_message(session_maker: sessionmaker, session_id: int, role: str, visual_role: str, content: str) -> int:
    with session_maker() as session:
        session_message = SessionMessage(session_id=session_id, role=role, visual_role=visual_role, content=content)
        session.add(session_message)
        session.commit()
        return session_message.id


def delete_session_message(session_maker: sessionmaker, session_message_id: int) -> bool:
    with session_maker() as session:
        stmt = delete(SessionMessage).where(SessionMessage.id == session_message_id)
        delete_count = session.execute(stmt).rowcount
        session.commit()
        return delete_count > 0


def update_session_message(session_maker: sessionmaker, session_message_id: int, **kwargs) -> bool:
    if not kwargs:
        return False

    with session_maker() as session:
        stmt = update(SessionMessage).where(SessionMessage.id == session_message_id).values(**kwargs)
        result = session.execute(stmt)
        session.commit()
        return result.rowcount > 0


def get_session_message_by_session_id(session_maker: sessionmaker, session_id: int) -> list[SessionMessageItem]:
    with session_maker() as session:
        stmt = select(SessionMessage).where(SessionMessage.session_id == session_id)
        models = session.execute(stmt).scalars().all()
        return SessionMessageItem.from_models(models)
