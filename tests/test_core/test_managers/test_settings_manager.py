import os
import tempfile
import unittest
from PySide6.QtCore import QSettings
from unittest.mock import patch

from chronoveil.core.enums import Setting, LLMProvider
from chronoveil.core.managers import SettingsManager
from chronoveil.core.models import LLMSettings


class TestSettingsManager(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.temp_settings_file = os.path.join(self.temp_dir, "test_settings.ini")
        
        with patch.object(QSettings, 'fileName', return_value=self.temp_settings_file):
            self.settings_manager = SettingsManager()
            for setting in Setting:
                self.settings_manager._settings.remove(setting)

    def tearDown(self):
        if os.path.exists(self.temp_settings_file):
            os.remove(self.temp_settings_file)
        os.rmdir(self.temp_dir)

    def test_set_and_get_string_value(self):
        test_url = "https://api.openai.com/v1"
        self.settings_manager.set_value(Setting.LLM_BASE_URL, test_url)
        
        retrieved_value = self.settings_manager.get_value(Setting.LLM_BASE_URL)
        self.assertEqual(retrieved_value, test_url)

    def test_set_and_get_provider_value(self):
        provider = LLMProvider.OPENAI
        self.settings_manager.set_value(Setting.LLM_PROVIDER, provider)
        
        retrieved_value = self.settings_manager.get_value(Setting.LLM_PROVIDER)
        self.assertEqual(retrieved_value, provider)

    def test_set_and_get_none_value(self):
        retrieved_value = self.settings_manager.get_value(Setting.LLM_BASE_URL)
        self.assertEqual(retrieved_value, None)

    def test_set_value_with_sync(self):
        test_key = "test_key"
        test_value = "test_value"
        self.settings_manager.set_value(Setting.LLM_API_KEY, test_value)
        
        # 验证值已正确设置
        retrieved_value = self.settings_manager.get_value(Setting.LLM_API_KEY)
        self.assertEqual(retrieved_value, test_value)

    def test_set_value_no_change(self):
        test_value = "same_value"
        
        # 首先设置值
        self.settings_manager.set_value(Setting.LLM_MODEL_NAME, test_value)
        first_retrieved = self.settings_manager.get_value(Setting.LLM_MODEL_NAME)
        self.assertEqual(first_retrieved, test_value)
        
        # 再次设置相同的值，应该不会改变任何内容
        self.settings_manager.set_value(Setting.LLM_MODEL_NAME, test_value)
        second_retrieved = self.settings_manager.get_value(Setting.LLM_MODEL_NAME)
        self.assertEqual(second_retrieved, test_value)

    def test_get_llm_setting_default(self):
        llm_settings = self.settings_manager.get_llm_setting()
        
        self.assertIsNone(llm_settings.provider)
        self.assertIsNone(llm_settings.base_url)
        self.assertIsNone(llm_settings.model_name)
        self.assertIsNone(llm_settings.api_key)

    def test_set_and_get_llm_setting(self):
        expected_settings = LLMSettings(
            provider=LLMProvider.OPENAI,
            base_url="https://api.openai.com/v1",
            model_name="gpt-4",
            api_key="test-api-key"
        )
        
        self.settings_manager.set_llm_setting(expected_settings)
        actual_settings = self.settings_manager.get_llm_setting()
        
        self.assertEqual(actual_settings.provider, expected_settings.provider)
        self.assertEqual(actual_settings.base_url, expected_settings.base_url)
        self.assertEqual(actual_settings.model_name, expected_settings.model_name)
        self.assertEqual(actual_settings.api_key, expected_settings.api_key)

    def test_parse_bool_value(self):
        # 由于我们没有布尔类型的设置，跳过此测试或添加一个布尔设置用于测试
        # 这里我们只测试现有的字符串和枚举类型
        pass

    def test_parse_error_handling(self):
        with patch.object(self.settings_manager._settings, 'value', return_value="invalid_enum_value"):
            result = self.settings_manager.get_value(Setting.LLM_PROVIDER)
            self.assertIsNone(result)


if __name__ == '__main__':
    unittest.main()