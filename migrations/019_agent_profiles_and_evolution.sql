CREATE TABLE IF NOT EXISTS agent_profiles (
  agent_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  auto_evolve INTEGER NOT NULL DEFAULT 1,
  current_prompt_version INTEGER NOT NULL DEFAULT 1,
  current_memory_revision INTEGER NOT NULL DEFAULT 1,
  candidate_prompt_version INTEGER,
  canary_remaining INTEGER NOT NULL DEFAULT 0,
  last_evolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_prompt_versions (
  agent_id TEXT NOT NULL REFERENCES agent_profiles(agent_id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'candidate', 'superseded', 'rolled_back')),
  source TEXT NOT NULL CHECK(source IN ('seed', 'human', 'local', 'evolution')),
  reason TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(agent_id, version)
);

CREATE TABLE IF NOT EXISTS agent_memory_versions (
  agent_id TEXT NOT NULL REFERENCES agent_profiles(agent_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('seed', 'human', 'local', 'evolution')),
  reason TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(agent_id, revision)
);

CREATE TABLE IF NOT EXISTS agent_observations (
  observation_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(agent_id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  guidance TEXT NOT NULL,
  target TEXT NOT NULL CHECK(target IN ('daily', 'memory', 'prompt')),
  confidence REAL NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('observed', 'promoted_memory', 'prompt_candidate', 'promoted_prompt', 'rejected')),
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(agent_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS agent_observation_occurrences (
  observation_id TEXT NOT NULL REFERENCES agent_observations(observation_id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL REFERENCES execution_attempts(execution_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(observation_id, execution_id)
);

CREATE TABLE IF NOT EXISTS agent_evolution_runs (
  evolution_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES execution_attempts(execution_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(agent_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('running', 'applied', 'no_change', 'failed')),
  evaluator_result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  UNIQUE(execution_id)
);

ALTER TABLE execution_attempts ADD COLUMN prompt_version INTEGER;
ALTER TABLE execution_attempts ADD COLUMN prompt_hash TEXT;
ALTER TABLE execution_attempts ADD COLUMN memory_revision INTEGER;
ALTER TABLE execution_attempts ADD COLUMN memory_hash TEXT;
ALTER TABLE execution_attempts ADD COLUMN evolution_candidate_id TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_prompt_versions_history
  ON agent_prompt_versions(agent_id, version DESC);

CREATE INDEX IF NOT EXISTS idx_agent_observations_promotion
  ON agent_observations(agent_id, status, occurrence_count, confidence);
