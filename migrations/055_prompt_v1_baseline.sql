DROP INDEX IF EXISTS idx_agent_prompt_versions_history;

DROP TABLE IF EXISTS agent_prompt_versions;

CREATE TABLE agent_prompts (
  agent_id TEXT PRIMARY KEY REFERENCES agent_profiles(agent_id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  reason TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE agent_prompt_overlays (
  agent_id TEXT PRIMARY KEY REFERENCES agent_profiles(agent_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('human', 'evolution')),
  reason TEXT,
  evidence_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE agent_prompt_candidates (
  candidate_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE REFERENCES agent_profiles(agent_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  base_overlay_revision INTEGER NOT NULL CHECK(base_overlay_revision >= 0),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source = 'evolution'),
  reason TEXT,
  evidence_json TEXT,
  remaining_runs INTEGER NOT NULL DEFAULT 3 CHECK(remaining_runs >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE agent_profiles
ADD COLUMN current_prompt_overlay_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE execution_attempts
ADD COLUMN prompt_overlay_revision INTEGER;

UPDATE agent_profiles
SET current_prompt_version = 1,
    current_prompt_overlay_revision = 0,
    candidate_prompt_version = NULL,
    canary_remaining = 0,
    prompt_seed_revision = 1,
    updated_at = CURRENT_TIMESTAMP;

UPDATE agent_observations
SET status = 'rejected',
    last_seen_at = CURRENT_TIMESTAMP
WHERE status = 'prompt_candidate';
