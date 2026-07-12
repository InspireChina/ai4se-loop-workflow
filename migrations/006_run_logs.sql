CREATE TABLE IF NOT EXISTS run_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id TEXT NOT NULL,
  line TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_run_logs_lease ON run_logs(lease_id, log_id);
