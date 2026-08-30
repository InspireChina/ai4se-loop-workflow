CREATE TABLE IF NOT EXISTS agent_configuration_prompt_candidates (
  candidate_id TEXT PRIMARY KEY,
  configuration_id TEXT NOT NULL UNIQUE REFERENCES agent_configuration_sets(configuration_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK(revision >= 2),
  base_prompt_revision INTEGER NOT NULL CHECK(base_prompt_revision >= 1),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  reason TEXT,
  evidence_json TEXT,
  remaining_runs INTEGER NOT NULL DEFAULT 3 CHECK(remaining_runs >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_configuration_canary_receipts (
  candidate_id TEXT NOT NULL REFERENCES agent_configuration_prompt_candidates(candidate_id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('active', 'succeeded', 'failed')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(candidate_id, execution_id)
);
