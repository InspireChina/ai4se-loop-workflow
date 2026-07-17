CREATE TABLE IF NOT EXISTS verification_runs (
  verification_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  story_index INTEGER NOT NULL,
  spec_revision INTEGER NOT NULL,
  code_commit TEXT,
  status TEXT NOT NULL CHECK(status IN ('running', 'passed', 'failed', 'error')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  FOREIGN KEY(task_id, story_index) REFERENCES stories(task_id, story_index) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS verification_evidence (
  evidence_id TEXT PRIMARY KEY,
  verification_id TEXT NOT NULL REFERENCES verification_runs(verification_id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  instruction TEXT NOT NULL,
  command TEXT,
  exit_code INTEGER,
  output_summary TEXT,
  passed INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_verification_runs_story
  ON verification_runs(task_id, story_index, spec_revision, started_at);

CREATE INDEX IF NOT EXISTS idx_verification_evidence_run
  ON verification_evidence(verification_id, criterion_id);
