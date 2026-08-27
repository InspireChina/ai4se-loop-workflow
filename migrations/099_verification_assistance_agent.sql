CREATE TABLE IF NOT EXISTS verification_assistance_jobs (
  job_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES runtime_input_requests(request_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  story_index INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'running', 'resolved', 'escalated', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts >= 3),
  active_session_id TEXT,
  command_token_hash TEXT,
  status_viewed_session_id TEXT,
  current_execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  answer TEXT,
  last_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  escalated_at TEXT
);

CREATE TABLE IF NOT EXISTS verification_assistance_attempts (
  attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES verification_assistance_jobs(job_id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL UNIQUE REFERENCES execution_attempts(execution_id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK(attempt > 0),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK(status IN ('running', 'resolved', 'deferred', 'failed')),
  reason TEXT,
  answer TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  UNIQUE(job_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_verification_assistance_queue
  ON verification_assistance_jobs(status, created_at);

CREATE INDEX IF NOT EXISTS idx_verification_assistance_task
  ON verification_assistance_jobs(task_id, status, created_at);
