INSERT OR IGNORE INTO project_settings(setting_key, setting_value)
SELECT 'flow_agent_executor', COALESCE(
  (SELECT executor_id FROM agent_runtime_settings GROUP BY executor_id ORDER BY COUNT(*) DESC, executor_id LIMIT 1),
  (SELECT setting_value FROM project_settings WHERE setting_key = 'agent_executor'),
  'cursor'
);

INSERT OR IGNORE INTO project_settings(setting_key, setting_value)
SELECT 'flow_codex_model', COALESCE(
  (SELECT codex_model FROM agent_runtime_settings GROUP BY codex_model ORDER BY COUNT(*) DESC, codex_model LIMIT 1),
  (SELECT setting_value FROM project_settings WHERE setting_key = 'codex_model'),
  'gpt-5.6-sol'
);

INSERT OR IGNORE INTO project_settings(setting_key, setting_value)
SELECT 'flow_codex_reasoning_effort', COALESCE(
  (SELECT codex_reasoning_effort FROM agent_runtime_settings GROUP BY codex_reasoning_effort ORDER BY COUNT(*) DESC, codex_reasoning_effort LIMIT 1),
  (SELECT setting_value FROM project_settings WHERE setting_key = 'codex_reasoning_effort'),
  'default'
);

INSERT OR IGNORE INTO project_settings(setting_key, setting_value)
SELECT 'flow_claude_model', COALESCE(
  (SELECT claude_model FROM agent_runtime_settings GROUP BY claude_model ORDER BY COUNT(*) DESC, claude_model LIMIT 1),
  (SELECT setting_value FROM project_settings WHERE setting_key = 'claude_model'),
  ''
);

INSERT OR IGNORE INTO project_settings(setting_key, setting_value)
VALUES('flow_codex_web_search', 'true');

INSERT OR IGNORE INTO project_settings(setting_key, setting_value)
VALUES('codex_web_search', 'true');

PRAGMA foreign_keys = OFF;

ALTER TABLE agent_runtime_settings RENAME TO agent_runtime_settings_legacy_078;

CREATE TABLE agent_runtime_settings (
  agent_id TEXT PRIMARY KEY CHECK(agent_id IN (
    'idea-context-agent', 'business-design-agent', 'requirement-spec-agent', 'spec-review-agent',
    'backlog-agent', 'story-splitter-agent', 'analyst-agent', 'repro-agent',
    'dev-agent', 'test-agent', 'review-agent', 'feedback-agent'
  )),
  executor_id TEXT NOT NULL CHECK(executor_id IN ('cursor', 'codex', 'claude')),
  codex_model TEXT NOT NULL,
  codex_reasoning_effort TEXT NOT NULL CHECK(codex_reasoning_effort IN (
    'default', 'minimal', 'low', 'medium', 'high', 'xhigh'
  )),
  codex_web_search INTEGER NOT NULL DEFAULT 1 CHECK(codex_web_search IN (0, 1)),
  claude_model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO agent_runtime_settings(
  agent_id, executor_id, codex_model, codex_reasoning_effort,
  codex_web_search, claude_model, created_at, updated_at
)
SELECT
  agent_id, executor_id, codex_model, codex_reasoning_effort,
  1, claude_model, created_at, updated_at
FROM agent_runtime_settings_legacy_078;

DROP TABLE agent_runtime_settings_legacy_078;

DELETE FROM agent_runtime_settings
WHERE executor_id = (SELECT setting_value FROM project_settings WHERE setting_key = 'flow_agent_executor')
  AND codex_model = (SELECT setting_value FROM project_settings WHERE setting_key = 'flow_codex_model')
  AND codex_reasoning_effort = (SELECT setting_value FROM project_settings WHERE setting_key = 'flow_codex_reasoning_effort')
  AND claude_model = (SELECT setting_value FROM project_settings WHERE setting_key = 'flow_claude_model')
  AND codex_web_search = 1;

PRAGMA foreign_keys = ON;
