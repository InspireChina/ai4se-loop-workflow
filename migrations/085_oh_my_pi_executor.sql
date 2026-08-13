PRAGMA foreign_keys = OFF;

ALTER TABLE agent_runtime_settings RENAME TO agent_runtime_settings_legacy_085;

CREATE TABLE agent_runtime_settings (
  agent_id TEXT PRIMARY KEY CHECK(agent_id IN (
    'idea-context-agent', 'business-design-agent', 'requirement-spec-agent', 'spec-review-agent',
    'backlog-agent', 'story-splitter-agent', 'analyst-agent', 'repro-agent',
    'dev-agent', 'test-agent', 'review-agent', 'feedback-agent'
  )),
  executor_id TEXT NOT NULL CHECK(executor_id IN ('cursor', 'codex', 'claude', 'omp')),
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
  codex_web_search, claude_model, created_at, updated_at
FROM agent_runtime_settings_legacy_085;

DROP TABLE agent_runtime_settings_legacy_085;

PRAGMA foreign_keys = ON;
