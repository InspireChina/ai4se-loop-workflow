CREATE TABLE IF NOT EXISTS runtime_input_requests (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  story_index INTEGER,
  source_agent TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  why TEXT,
  recommendation TEXT,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'answered', 'resolved', 'superseded')),
  source_execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  resolved_execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runtime_input_requests_task
  ON runtime_input_requests(task_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_runtime_input_requests_resolution
  ON runtime_input_requests(resolved_execution_id, status);
