import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from chronoveil.core.orm import BaseORM
from chronoveil.core.services.database_services import add_session_message
from chronoveil.core.services.database_services import add_user
from chronoveil.core.services.database_services import add_user_session
from chronoveil.core.services.database_services import delete_session_message
from chronoveil.core.services.database_services import delete_user
from chronoveil.core.services.database_services import delete_user_session
from chronoveil.core.services.database_services import get_all_users
from chronoveil.core.services.database_services import get_session_message_by_session_id
from chronoveil.core.services.database_services import get_user
from chronoveil.core.services.database_services import get_user_session_by_user_id
from chronoveil.core.services.database_services import update_session_message
from chronoveil.core.services.database_services import update_user
from chronoveil.core.services.database_services import update_user_session


@pytest.fixture
def session_maker():
    engine = create_engine("sqlite:///:memory:", echo=False)
    session_local = sessionmaker(bind=engine)
    BaseORM.metadata.create_all(engine)
    yield session_local
    BaseORM.metadata.drop_all(engine)
    engine.dispose()


def test_add_user(session_maker):
    user_id = add_user(session_maker, "test_user")
    assert user_id > 0

    user = get_user(session_maker, user_id)
    assert user is not None
    assert user.username == "test_user"


def test_delete_user(session_maker):
    user_id = add_user(session_maker, "test_user")
    result = delete_user(session_maker, user_id)
    assert result is True

    user = get_user(session_maker, user_id)
    assert user is None


def test_update_user(session_maker):
    user_id = add_user(session_maker, "test_user")
    new_username = "updated_user"
    result = update_user(session_maker, user_id, username=new_username)
    assert result is True

    user = get_user(session_maker, user_id)
    assert user is not None
    assert user.username == new_username


def test_update_user_no_kwargs(session_maker):
    result = update_user(session_maker, 1)
    assert result is False


def test_get_user_not_found(session_maker):
    user = get_user(session_maker, 999)
    assert user is None


# noinspection PyUnusedLocal
def test_get_all_users(session_maker):
    # Add some users
    user1_id = add_user(session_maker, "user1")
    user2_id = add_user(session_maker, "user2")

    users = get_all_users(session_maker)
    assert len(users) >= 2
    usernames = [user.username for user in users]
    assert "user1" in usernames
    assert "user2" in usernames


@pytest.mark.parametrize("username,expected", [
    ("user1", "user1"),
    ("test_user_123", "test_user_123"),
    ("user_with_underscore", "user_with_underscore"),
])
def test_add_user_parametrized(session_maker, username, expected):
    user_id = add_user(session_maker, username)
    user = get_user(session_maker, user_id)
    assert user is not None
    assert user.username == expected


def test_add_user_session(session_maker):
    # First add a user
    user_id = add_user(session_maker, "test_user")

    session_id = add_user_session(session_maker, user_id, "Session Title", "Session Description")
    assert session_id > 0

    sessions = get_user_session_by_user_id(session_maker, user_id)
    assert len(sessions) == 1
    assert sessions[0].title == "Session Title"
    assert sessions[0].description == "Session Description"


def test_delete_user_session(session_maker):
    user_id = add_user(session_maker, "test_user")
    session_id = add_user_session(session_maker, user_id, "Session Title", "Session Description")

    result = delete_user_session(session_maker, session_id)
    assert result is True

    sessions = get_user_session_by_user_id(session_maker, user_id)
    assert len(sessions) == 0


def test_update_user_session(session_maker):
    user_id = add_user(session_maker, "test_user")
    session_id = add_user_session(session_maker, user_id, "Old Title", "Old Description")

    new_title = "New Title"
    new_description = "New Description"
    result = update_user_session(session_maker, session_id, title=new_title, description=new_description)
    assert result is True

    sessions = get_user_session_by_user_id(session_maker, user_id)
    assert len(sessions) == 1
    assert sessions[0].title == new_title
    assert sessions[0].description == new_description


def test_update_user_session_no_kwargs(session_maker):
    result = update_user_session(session_maker, 1)
    assert result is False


def test_add_session_message(session_maker):
    # Add a user and session first
    user_id = add_user(session_maker, "test_user")
    session_id = add_user_session(session_maker, user_id, "Session Title", "Session Description")

    message_id = add_session_message(session_maker, session_id, "user", "User", "Hello, world!")
    assert message_id > 0

    messages = get_session_message_by_session_id(session_maker, session_id)
    assert len(messages) == 1
    assert messages[0].role == "user"
    assert messages[0].visual_role == "User"
    assert messages[0].content == "Hello, world!"


def test_delete_session_message(session_maker):
    user_id = add_user(session_maker, "test_user")
    session_id = add_user_session(session_maker, user_id, "Session Title", "Session Description")
    message_id = add_session_message(session_maker, session_id, "user", "User", "Hello, world!")

    result = delete_session_message(session_maker, message_id)
    assert result is True

    messages = get_session_message_by_session_id(session_maker, session_id)
    assert len(messages) == 0


def test_update_session_message(session_maker):
    user_id = add_user(session_maker, "test_user")
    session_id = add_user_session(session_maker, user_id, "Session Title", "Session Description")
    message_id = add_session_message(session_maker, session_id, "user", "User", "Original message")

    new_content = "Updated message"
    new_role = "assistant"
    result = update_session_message(session_maker, message_id, content=new_content, role=new_role)
    assert result is True

    messages = get_session_message_by_session_id(session_maker, session_id)
    assert len(messages) == 1
    assert messages[0].content == new_content
    assert messages[0].role == new_role


def test_update_session_message_no_kwargs(session_maker):
    result = update_session_message(session_maker, 1)
    assert result is False


# noinspection PyUnusedLocal
@pytest.mark.parametrize("role,visual_role,content", [
    ("user", "User", "Test message 1"),
    ("assistant", "Assistant", "Test message 2"),
    ("system", "System", "Test message 3"),
])
def test_add_session_message_parametrized(session_maker, role, visual_role, content):
    user_id = add_user(session_maker, "test_user")
    session_id = add_user_session(session_maker, user_id, "Session Title", "Session Description")

    message_id = add_session_message(session_maker, session_id, role, visual_role, content)
    messages = get_session_message_by_session_id(session_maker, session_id)

    assert len(messages) == 1
    assert messages[0].role == role
    assert messages[0].visual_role == visual_role
    assert messages[0].content == content


def test_get_user_session_by_user_id_empty(session_maker):
    sessions = get_user_session_by_user_id(session_maker, 999)
    assert len(sessions) == 0


def test_get_session_message_by_session_id_empty(session_maker):
    messages = get_session_message_by_session_id(session_maker, 999)
    assert len(messages) == 0


def test_get_all_users_empty(session_maker):
    users = get_all_users(session_maker)
    assert len(users) == 0


def test_add_user_session_with_invalid_user_id(session_maker):
    # Attempt to add a session with a non-existent user ID
    session_id = add_user_session(session_maker, 999, "Session Title", "Session Description")
    assert session_id > 0

    # Verify the session was created with the invalid user ID
    sessions = get_user_session_by_user_id(session_maker, 999)
    assert len(sessions) == 1
    assert sessions[0].user_id == 999


def test_add_session_message_with_invalid_session_id(session_maker):
    # Attempt to add a message to a non-existent session ID
    message_id = add_session_message(session_maker, 999, "user", "User", "Hello, world!")
    assert message_id > 0

    # Verify the message was created with the invalid session ID
    messages = get_session_message_by_session_id(session_maker, 999)
    assert len(messages) == 1
    assert messages[0].session_id == 999


def test_update_user_with_invalid_id(session_maker):
    result = update_user(session_maker, 999, username="updated_user")
    # Should return False since no user exists with ID 999
    assert result is False


def test_update_user_session_with_invalid_id(session_maker):
    result = update_user_session(session_maker, 999, title="New Title")
    # Should return False since no session exists with ID 999
    assert result is False


def test_update_session_message_with_invalid_id(session_maker):
    result = update_session_message(session_maker, 999, content="New Content")
    # Should return False since no message exists with ID 999
    assert result is False


def test_delete_user_with_invalid_id(session_maker):
    result = delete_user(session_maker, 999)
    # Should return False since no user exists with ID 999
    assert result is False


def test_delete_user_session_with_invalid_id(session_maker):
    result = delete_user_session(session_maker, 999)
    # Should return False since no session exists with ID 999
    assert result is False


def test_delete_session_message_with_invalid_id(session_maker):
    result = delete_session_message(session_maker, 999)
    # Should return False since no message exists with ID 999
    assert result is False
