CREATE TABLE IF NOT EXISTS recovery_items (
  recovery_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  story_index INTEGER,
  kind TEXT NOT NULL CHECK(kind = 'test_failure'),
  source_agent TEXT NOT NULL,
  target_stage TEXT NOT NULL CHECK(target_stage IN ('analysis', 'dev')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'reopened', 'resolved', 'superseded')),
  summary TEXT NOT NULL,
  details_json TEXT NOT NULL,
  source_execution_id TEXT,
  resolution_json TEXT,
  failure_count INTEGER NOT NULL DEFAULT 1,
  claimed_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recovery_items_active
  ON recovery_items(task_id, story_index, status, target_stage, created_at);

CREATE INDEX IF NOT EXISTS idx_recovery_items_source_execution
  ON recovery_items(source_execution_id, kind);
