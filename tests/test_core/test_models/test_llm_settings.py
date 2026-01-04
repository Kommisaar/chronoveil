import pytest

from chronoveil.core.enums.api_format import LLMAPIFormat
from chronoveil.core.models.llm_settings import LLMSettings


def test_llm_settings_creation():
    """测试正常创建LLMSettings实例"""
    settings = LLMSettings(
        api_format=LLMAPIFormat.OPENAI,
        base_url="https://api.openai.com/v1",
        model_name="gpt-3.5-turbo",
        api_key="test-key"
    )
    assert settings.api_format == LLMAPIFormat.OPENAI
    assert settings.base_url == "https://api.openai.com/v1"
    assert settings.model_name == "gpt-3.5-turbo"
    assert settings.api_key == "test-key"


@pytest.mark.parametrize("api_format, base_url, model_name, api_key", [
    (None, None, None, None),
    (LLMAPIFormat.OPENAI, "", "", ""),
    (None, "https://api.openai.com/v1", "gpt-3.5-turbo", "test-key"),
])
def test_llm_settings_with_optional_fields(api_format, base_url, model_name, api_key):
    """测试LLMSettings使用可选字段的边界情况"""
    settings = LLMSettings(
        api_format=api_format,
        base_url=base_url,
        model_name=model_name,
        api_key=api_key
    )
    assert settings.api_format == api_format
    assert settings.base_url == base_url
    assert settings.model_name == model_name
    assert settings.api_key == api_key


def test_llm_settings_default_behavior():
    """测试LLMSettings默认创建（所有字段为None）"""
    settings = LLMSettings()
    assert settings.api_format is None
    assert settings.base_url is None
    assert settings.model_name is None
    assert settings.api_key is None


def test_llm_settings_validation():
    """测试LLMSettings字段验证"""
    # 测试有效的api_format
    settings = LLMSettings(api_format=LLMAPIFormat.OPENAI)
    assert settings.api_format == LLMAPIFormat.OPENAI

    # 测试无效的api_format应该不会抛出异常，因为Pydantic允许None值
    settings = LLMSettings(api_format=None)
    assert settings.api_format is None


def test_llm_settings_field_types():
    """测试LLMSettings字段类型"""
    settings = LLMSettings(
        api_format=LLMAPIFormat.OPENAI,
        base_url="https://api.openai.com/v1",
        model_name="gpt-3.5-turbo",
        api_key="test-key"
    )

    assert isinstance(settings.api_format, LLMAPIFormat)
    assert isinstance(settings.base_url, str)
    assert isinstance(settings.model_name, str)
    assert isinstance(settings.api_key, str)
