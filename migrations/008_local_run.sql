ALTER TABLE run_logs RENAME COLUMN lease_id TO run_id;
DROP INDEX IF EXISTS idx_run_logs_lease;
CREATE INDEX IF NOT EXISTS idx_run_logs_run ON run_logs(run_id, log_id);
DELETE FROM loop_meta WHERE key = 'run_lease';
