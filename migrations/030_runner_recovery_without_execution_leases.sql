CREATE TABLE IF NOT EXISTS loop_runs (
  run_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('starting', 'running', 'stopping', 'stopped', 'crashed')),
  process_kind TEXT,
  runner_pid INTEGER,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  heartbeat_at TEXT,
  stop_requested_at TEXT,
  finished_at TEXT,
  failure_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_loop_runs_status
  ON loop_runs(status, started_at);

UPDATE execution_attempts
SET status = 'retryable_failed',
    last_error = COALESCE(last_error, '应用升级后回收未完成且尚无结构化结果的 execution attempt'),
    finished_at = CURRENT_TIMESTAMP,
    heartbeat_at = CURRENT_TIMESTAMP
WHERE status IN ('planned', 'running')
  AND result_json IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM agent_results
    WHERE agent_results.execution_id = execution_attempts.execution_id
      AND agent_results.application_status = 'pending'
  );

DROP INDEX IF EXISTS idx_execution_attempts_recovery;

CREATE INDEX IF NOT EXISTS idx_execution_attempts_recovery
  ON execution_attempts(status, created_at);

ALTER TABLE execution_attempts DROP COLUMN lease_owner;

ALTER TABLE execution_attempts DROP COLUMN lease_expires_at;
