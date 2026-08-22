ALTER TABLE tasks ADD COLUMN retry_cycle INTEGER NOT NULL DEFAULT 1;
ALTER TABLE task_lanes ADD COLUMN retry_cycle INTEGER NOT NULL DEFAULT 1;
ALTER TABLE execution_attempts ADD COLUMN retry_not_before TEXT;

CREATE INDEX IF NOT EXISTS idx_execution_attempts_retry_window
  ON execution_attempts(dispatch_generation_key, status, retry_not_before);
