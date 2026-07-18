ALTER TABLE documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_evolution_runs ADD COLUMN evidence_json TEXT;

CREATE TABLE IF NOT EXISTS document_comments (
  comment_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  document_revision INTEGER NOT NULL,
  agent_id TEXT,
  anchor_type TEXT NOT NULL CHECK(anchor_type IN ('file', 'selection')),
  quoted_text TEXT,
  start_offset INTEGER,
  end_offset INTEGER,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
  evolution_status TEXT NOT NULL DEFAULT 'pending' CHECK(evolution_status IN ('pending', 'analyzed')),
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_observation_comment_evidence (
  observation_id TEXT NOT NULL REFERENCES agent_observations(observation_id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL REFERENCES document_comments(comment_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(observation_id, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_document_comments_task
  ON document_comments(task_id, document_id, created_at);

CREATE INDEX IF NOT EXISTS idx_document_comments_evolution
  ON document_comments(agent_id, evolution_status, created_at);
