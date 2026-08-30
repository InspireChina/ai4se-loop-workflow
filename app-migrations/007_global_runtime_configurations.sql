CREATE TABLE global_runtime_configurations (
  configuration_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('system', 'flow', 'agent')),
  agent_id TEXT,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0, 1)),
  executor_id TEXT NOT NULL,
  codex_model TEXT NOT NULL,
  codex_reasoning_effort TEXT NOT NULL,
  codex_web_search INTEGER NOT NULL CHECK(codex_web_search IN (0, 1)),
  claude_model TEXT NOT NULL DEFAULT '',
  omp_model TEXT NOT NULL DEFAULT '',
  omp_thinking TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(
    (scope = 'agent' AND agent_id IS NOT NULL)
    OR (scope IN ('system', 'flow') AND agent_id IS NULL)
  ),
  UNIQUE(scope, agent_id, name)
);

CREATE UNIQUE INDEX idx_global_runtime_active_system
  ON global_runtime_configurations(scope)
  WHERE is_active = 1 AND scope IN ('system', 'flow');

CREATE UNIQUE INDEX idx_global_runtime_active_agent
  ON global_runtime_configurations(agent_id)
  WHERE is_active = 1 AND scope = 'agent';

CREATE INDEX idx_global_runtime_scope
  ON global_runtime_configurations(scope, agent_id, updated_at);
