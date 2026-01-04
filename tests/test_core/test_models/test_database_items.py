from datetime import datetime

import pytest

from chronoveil.core.models import SessionMessageItem
from chronoveil.core.models import UserItem
from chronoveil.core.models import UserSessionItem
from chronoveil.core.orm import SessionMessage
from chronoveil.core.orm import User
from chronoveil.core.orm import UserSession


def test_user_item_from_model():
    # 创建ORM模型实例
    user_model = User(
        id=1,
        username="test_user",
        created_at=datetime(2023, 1, 1, 12, 0, 0),
        updated_at=datetime(2023, 1, 1, 12, 0, 0)
    )

    # 转换为Item
    user_item = UserItem.from_model(user_model)

    # 验证转换结果
    assert user_item.id == 1
    assert user_item.username == "test_user"
    assert user_item.created_at == datetime(2023, 1, 1, 12, 0, 0)
    assert user_item.updated_at == datetime(2023, 1, 1, 12, 0, 0)


def test_user_item_from_models():
    # 创建多个ORM模型实例
    user_models = [
        User(id=1, username="user1", created_at=datetime(2023, 1, 1), updated_at=datetime(2023, 1, 1)),
        User(id=2, username="user2", created_at=datetime(2023, 1, 2), updated_at=datetime(2023, 1, 2))
    ]

    # 转换为Item列表
    user_items = UserItem.from_models(user_models)

    # 验证转换结果
    assert len(user_items) == 2
    assert user_items[0].id == 1
    assert user_items[0].username == "user1"
    assert user_items[1].id == 2
    assert user_items[1].username == "user2"


def test_user_session_item_from_model():
    # 创建ORM模型实例
    session_model = UserSession(
        id=1,
        user_id=1,
        created_at=datetime(2023, 1, 1, 12, 0, 0),
        updated_at=datetime(2023, 1, 1, 12, 0, 0),
        title="Test Session",
        description="Test Description"
    )

    # 转换为Item
    session_item = UserSessionItem.from_model(session_model)

    # 验证转换结果
    assert session_item.id == 1
    assert session_item.user_id == 1
    assert session_item.title == "Test Session"
    assert session_item.description == "Test Description"
    assert session_item.created_at == datetime(2023, 1, 1, 12, 0, 0)
    assert session_item.updated_at == datetime(2023, 1, 1, 12, 0, 0)


def test_user_session_item_from_models():
    # 创建多个ORM模型实例
    session_models = [
        UserSession(
            id=1,
            user_id=1,
            created_at=datetime(2023, 1, 1),
            updated_at=datetime(2023, 1, 1),
            title="Session 1",
            description="Description 1"
        ),
        UserSession(
            id=2,
            user_id=2,
            created_at=datetime(2023, 1, 2),
            updated_at=datetime(2023, 1, 2),
            title="Session 2",
            description="Description 2"
        )
    ]

    # 转换为Item列表
    session_items = UserSessionItem.from_models(session_models)

    # 验证转换结果
    assert len(session_items) == 2
    assert session_items[0].id == 1
    assert session_items[0].title == "Session 1"
    assert session_items[1].id == 2
    assert session_items[1].title == "Session 2"


def test_session_message_item_from_model():
    # 创建ORM模型实例
    message_model = SessionMessage(
        id=1,
        session_id=1,
        created_at=datetime(2023, 1, 1, 12, 0, 0),
        updated_at=datetime(2023, 1, 1, 12, 0, 0),
        role="user",
        visual_role="User",
        content="Test message content"
    )

    # 转换为Item
    message_item = SessionMessageItem.from_model(message_model)

    # 验证转换结果
    assert message_item.id == 1
    assert message_item.session_id == 1
    assert message_item.role == "user"
    assert message_item.visual_role == "User"
    assert message_item.content == "Test message content"
    assert message_item.created_at == datetime(2023, 1, 1, 12, 0, 0)
    assert message_item.updated_at == datetime(2023, 1, 1, 12, 0, 0)


def test_session_message_item_from_models():
    # 创建多个ORM模型实例
    message_models = [
        SessionMessage(
            id=1,
            session_id=1,
            created_at=datetime(2023, 1, 1),
            updated_at=datetime(2023, 1, 1),
            role="user",
            visual_role="User",
            content="Message 1"
        ),
        SessionMessage(
            id=2,
            session_id=2,
            created_at=datetime(2023, 1, 2),
            updated_at=datetime(2023, 1, 2),
            role="assistant",
            visual_role="Assistant",
            content="Message 2"
        )
    ]

    # 转换为Item列表
    message_items = SessionMessageItem.from_models(message_models)

    # 验证转换结果
    assert len(message_items) == 2
    assert message_items[0].id == 1
    assert message_items[0].role == "user"
    assert message_items[0].content == "Message 1"
    assert message_items[1].id == 2
    assert message_items[1].role == "assistant"
    assert message_items[1].content == "Message 2"


@pytest.mark.parametrize("user_id, username, title, description", [
    (1, "user1", "Session 1", "Description 1"),
    (2, "user2", "Session 2", "Description 2"),
    (0, "", "", ""),  # 边界值测试
])
def test_user_item_and_session_item_boundary_values(user_id, username, title, description):
    # 测试边界值
    user_model = User(id=user_id, username=username, created_at=datetime(2023, 1, 1), updated_at=datetime(2023, 1, 1))
    user_item = UserItem.from_model(user_model)

    assert user_item.id == user_id
    assert user_item.username == username

    session_model = UserSession(
        id=user_id,
        user_id=user_id,
        created_at=datetime(2023, 1, 1),
        updated_at=datetime(2023, 1, 1),
        title=title,
        description=description
    )
    session_item = UserSessionItem.from_model(session_model)

    assert session_item.id == user_id
    assert session_item.user_id == user_id
    assert session_item.title == title
    assert session_item.description == description
