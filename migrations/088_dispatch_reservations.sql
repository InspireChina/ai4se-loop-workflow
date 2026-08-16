ALTER TABLE execution_attempts ADD COLUMN dispatch_generation_key TEXT;

ALTER TABLE execution_attempts ADD COLUMN dispatch_reservation_json TEXT;

ALTER TABLE execution_attempts ADD COLUMN dispatch_execution_exited_at TEXT;

ALTER TABLE execution_attempts ADD COLUMN dispatch_settled_at TEXT;

ALTER TABLE execution_attempts ADD COLUMN dispatch_retry_consumed INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_execution_attempts_dispatch_generation
  ON execution_attempts(dispatch_generation_key, attempt);
