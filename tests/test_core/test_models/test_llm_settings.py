import pytest

from chronoveil.core.enums import LLMProvider
from chronoveil.core.models import LLMSettings


def test_llm_settings_creation():
    """测试正常创建LLMSettings实例"""
    settings = LLMSettings(
        provider=LLMProvider.OPENAI,
        base_url="https://api.openai.com/v1",
        model_name="gpt-3.5-turbo",
        api_key="test-key"
    )
    assert settings.provider == LLMProvider.OPENAI
    assert settings.base_url == "https://api.openai.com/v1"
    assert settings.model_name == "gpt-3.5-turbo"
    assert settings.api_key == "test-key"


@pytest.mark.parametrize("provider, base_url, model_name, api_key", [
    (None, None, None, None),
    (LLMProvider.OPENAI, "", "", ""),
    (None, "https://api.openai.com/v1", "gpt-3.5-turbo", "test-key"),
])
def test_llm_settings_with_optional_fields(provider, base_url, model_name, api_key):
    """测试LLMSettings使用可选字段的边界情况"""
    settings = LLMSettings(
        provider=provider,
        base_url=base_url,
        model_name=model_name,
        api_key=api_key
    )
    assert settings.provider == provider
    assert settings.base_url == base_url
    assert settings.model_name == model_name
    assert settings.api_key == api_key


def test_llm_settings_default_behavior():
    """测试LLMSettings默认创建（所有字段为None）"""
    settings = LLMSettings()
    assert settings.provider is None
    assert settings.base_url is None
    assert settings.model_name is None
    assert settings.api_key is None


def test_llm_settings_validation():
    """测试LLMSettings字段验证"""
    # 测试有效的provider
    settings = LLMSettings(provider=LLMProvider.OPENAI)
    assert settings.provider == LLMProvider.OPENAI

    # 测试无效的provider应该不会抛出异常，因为Pydantic允许None值
    settings = LLMSettings(provider=None)
    assert settings.provider is None


def test_llm_settings_field_types():
    """测试LLMSettings字段类型"""
    settings = LLMSettings(
        provider=LLMProvider.OPENAI,
        base_url="https://api.openai.com/v1",
        model_name="gpt-3.5-turbo",
        api_key="test-key"
    )

    assert isinstance(settings.provider, LLMProvider)
    assert isinstance(settings.base_url, str)
    assert isinstance(settings.model_name, str)
    assert isinstance(settings.api_key, str)
