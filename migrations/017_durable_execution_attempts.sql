CREATE TABLE IF NOT EXISTS execution_attempts (
  execution_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  story_index INTEGER,
  agent TEXT NOT NULL,
  pipeline TEXT NOT NULL,
  delegation_key TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'planned', 'running', 'output_received', 'verifying', 'applying',
    'applied', 'retryable_failed', 'system_blocked', 'cancelled'
  )),
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  base_commit TEXT,
  code_commit TEXT,
  verification_id TEXT,
  application_result_id TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(delegation_key, attempt)
);

CREATE INDEX IF NOT EXISTS idx_execution_attempts_recovery
  ON execution_attempts(status, lease_expires_at, created_at);

CREATE INDEX IF NOT EXISTS idx_execution_attempts_task
  ON execution_attempts(task_id, story_index, created_at);

CREATE TABLE IF NOT EXISTS execution_receipts (
  receipt_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES execution_attempts(execution_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  receipt_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(execution_id, kind, receipt_key)
);

ALTER TABLE agent_results ADD COLUMN execution_id TEXT;
ALTER TABLE agent_results ADD COLUMN effect_outcome TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_results_execution
  ON agent_results(execution_id)
  WHERE execution_id IS NOT NULL;

ALTER TABLE verification_runs ADD COLUMN execution_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_runs_execution
  ON verification_runs(execution_id)
  WHERE execution_id IS NOT NULL;
