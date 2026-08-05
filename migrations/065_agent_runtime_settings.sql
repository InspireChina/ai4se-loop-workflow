CREATE TABLE IF NOT EXISTS agent_runtime_settings (
  agent_id TEXT PRIMARY KEY CHECK(agent_id IN (
    'backlog-agent', 'story-splitter-agent', 'analyst-agent', 'repro-agent',
    'dev-agent', 'test-agent', 'review-agent', 'feedback-agent'
  )),
  executor_id TEXT NOT NULL CHECK(executor_id IN ('cursor', 'codex', 'claude')),
  codex_model TEXT NOT NULL,
  codex_reasoning_effort TEXT NOT NULL CHECK(codex_reasoning_effort IN (
    'default', 'minimal', 'low', 'medium', 'high', 'xhigh'
  )),
  claude_model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

WITH flow_agents(agent_id) AS (
  VALUES
    ('backlog-agent'),
    ('story-splitter-agent'),
    ('analyst-agent'),
    ('repro-agent'),
    ('dev-agent'),
    ('test-agent'),
    ('review-agent'),
    ('feedback-agent')
)
INSERT OR IGNORE INTO agent_runtime_settings(
  agent_id, executor_id, codex_model, codex_reasoning_effort, claude_model
)
SELECT
  agent_id,
  CASE (SELECT setting_value FROM project_settings WHERE setting_key = 'agent_executor')
    WHEN 'codex' THEN 'codex'
    WHEN 'claude' THEN 'claude'
    ELSE 'cursor'
  END,
  COALESCE(NULLIF((SELECT setting_value FROM project_settings WHERE setting_key = 'codex_model'), ''), 'gpt-5.6-sol'),
  CASE (SELECT setting_value FROM project_settings WHERE setting_key = 'codex_reasoning_effort')
    WHEN 'minimal' THEN 'minimal'
    WHEN 'low' THEN 'low'
    WHEN 'medium' THEN 'medium'
    WHEN 'high' THEN 'high'
    WHEN 'xhigh' THEN 'xhigh'
    ELSE 'default'
  END,
  COALESCE((SELECT setting_value FROM project_settings WHERE setting_key = 'claude_model'), '')
FROM flow_agents;
