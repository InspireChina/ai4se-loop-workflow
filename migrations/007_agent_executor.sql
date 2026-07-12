CREATE TABLE IF NOT EXISTS project_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO project_settings(setting_key, setting_value)
VALUES('agent_executor', 'cursor');
