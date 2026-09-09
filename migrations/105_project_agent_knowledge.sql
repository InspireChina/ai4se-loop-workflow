CREATE TABLE IF NOT EXISTS project_agent_states (
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(agent_id) ON DELETE CASCADE,
  current_memory_revision INTEGER NOT NULL DEFAULT 1,
  auto_evolve INTEGER NOT NULL DEFAULT 1 CHECK(auto_evolve IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(project_id, agent_id)
);

CREATE TABLE IF NOT EXISTS project_agent_overlays (
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(agent_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  content TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('seed', 'migration', 'human', 'evolution')),
  reason TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(project_id, agent_id)
);

CREATE TABLE IF NOT EXISTS project_agent_overlay_candidates (
  candidate_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(agent_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 2),
  base_overlay_revision INTEGER NOT NULL CHECK(base_overlay_revision >= 1),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  reason TEXT,
  evidence_json TEXT,
  remaining_runs INTEGER NOT NULL DEFAULT 3 CHECK(remaining_runs >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, agent_id)
);

CREATE TABLE IF NOT EXISTS project_agent_memory_versions (
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(agent_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('seed', 'human', 'local', 'evolution', 'migration')),
  reason TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(project_id, agent_id, revision)
);

CREATE TABLE IF NOT EXISTS project_agent_observations (
  observation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
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
  UNIQUE(project_id, agent_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS project_agent_observation_occurrences (
  observation_id TEXT NOT NULL REFERENCES project_agent_observations(observation_id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL REFERENCES execution_attempts(execution_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(observation_id, execution_id)
);

CREATE TABLE IF NOT EXISTS project_agent_observation_comment_evidence (
  observation_id TEXT NOT NULL REFERENCES project_agent_observations(observation_id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL REFERENCES document_comments(comment_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(observation_id, comment_id)
);

ALTER TABLE agent_evolution_runs ADD COLUMN project_id TEXT REFERENCES projects(project_id) ON DELETE CASCADE;

INSERT OR IGNORE INTO project_agent_states(project_id, agent_id, current_memory_revision, auto_evolve)
SELECT project.project_id, profile.agent_id, profile.current_memory_revision, profile.auto_evolve
FROM projects project
CROSS JOIN agent_profiles profile
WHERE project.is_default = 1;

INSERT OR IGNORE INTO project_agent_overlays(project_id, agent_id, revision, content, content_hash, source, reason)
SELECT project.project_id, profile.agent_id,
       COALESCE(prompt.version, 1), COALESCE(prompt.content, ''), COALESCE(prompt.content_hash, ''),
       'migration', '从历史项目 Prompt 迁移'
FROM projects project
CROSS JOIN agent_profiles profile
LEFT JOIN agent_prompts prompt ON prompt.agent_id = profile.agent_id
WHERE project.is_default = 1;

INSERT OR IGNORE INTO project_agent_memory_versions(
  project_id, agent_id, revision, content, content_hash, source, reason, evidence_json, created_at
)
SELECT project.project_id, memory.agent_id, memory.revision, memory.content, memory.content_hash,
       'migration', COALESCE(memory.reason, '从原项目 Memory 迁移'), memory.evidence_json, memory.created_at
FROM projects project
CROSS JOIN agent_memory_versions memory
WHERE project.is_default = 1;

INSERT OR IGNORE INTO project_agent_observations(
  observation_id, project_id, agent_id, fingerprint, category, summary, guidance,
  target, confidence, status, occurrence_count, first_seen_at, last_seen_at
)
SELECT observation.observation_id, project.project_id, observation.agent_id, observation.fingerprint,
       observation.category, observation.summary, observation.guidance, observation.target,
       observation.confidence, observation.status, observation.occurrence_count,
       observation.first_seen_at, observation.last_seen_at
FROM projects project
CROSS JOIN agent_observations observation
WHERE project.is_default = 1;

INSERT OR IGNORE INTO project_agent_observation_occurrences(
  observation_id, execution_id, task_id, evidence_json, created_at
)
SELECT occurrence.observation_id, occurrence.execution_id, occurrence.task_id,
       occurrence.evidence_json, occurrence.created_at
FROM agent_observation_occurrences occurrence
JOIN project_agent_observations observation ON observation.observation_id = occurrence.observation_id;

INSERT OR IGNORE INTO project_agent_observation_comment_evidence(observation_id, comment_id, created_at)
SELECT evidence.observation_id, evidence.comment_id, evidence.created_at
FROM agent_observation_comment_evidence evidence
JOIN project_agent_observations observation ON observation.observation_id = evidence.observation_id;

UPDATE agent_evolution_runs
SET project_id = (
  SELECT task.project_id
  FROM execution_attempts execution
  JOIN tasks task ON task.task_id = execution.task_id
  WHERE execution.execution_id = agent_evolution_runs.execution_id
)
WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_project_agent_observations_promotion
ON project_agent_observations(project_id, agent_id, status, occurrence_count, confidence);
