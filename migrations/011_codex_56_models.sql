UPDATE project_settings
SET setting_value = 'gpt-5.6-sol', updated_at = CURRENT_TIMESTAMP
WHERE setting_key = 'codex_model'
  AND setting_value NOT IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna');
