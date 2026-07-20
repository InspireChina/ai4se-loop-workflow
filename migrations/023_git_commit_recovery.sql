CREATE TABLE IF NOT EXISTS git_commit_resolution_requests (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE CASCADE,
  story_index INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('checkpoint', 'delivery')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'answered', 'applied', 'superseded')),
  attempted_message TEXT NOT NULL,
  error_output TEXT NOT NULL,
  answer_message TEXT,
  remembered_template TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  answered_at TEXT,
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_git_commit_resolution_task
  ON git_commit_resolution_requests(task_id, status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_git_commit_resolution_pending
  ON git_commit_resolution_requests(task_id, story_index, operation)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS idx_git_commit_resolution_answered
  ON git_commit_resolution_requests(task_id, story_index, operation)
  WHERE status = 'answered';
