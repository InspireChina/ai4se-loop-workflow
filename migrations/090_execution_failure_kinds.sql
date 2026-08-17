ALTER TABLE execution_attempts ADD COLUMN failure_kind TEXT;

CREATE INDEX IF NOT EXISTS idx_execution_attempts_generation_failure
  ON execution_attempts(dispatch_generation_key, failure_kind, status);
