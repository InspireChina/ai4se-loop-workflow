CREATE TABLE IF NOT EXISTS runtime_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  trace_id TEXT,
  span_id TEXT,
  run_id TEXT,
  execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
  agent_id TEXT,
  event_name TEXT NOT NULL,
  component TEXT NOT NULL,
  stage TEXT,
  severity_text TEXT NOT NULL CHECK(severity_text IN ('TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL')),
  severity_number INTEGER NOT NULL,
  body TEXT NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  exception_type TEXT,
  exception_message TEXT,
  exception_stack TEXT,
  exception_fingerprint TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS software_maintenance_jobs (
  job_id TEXT PRIMARY KEY,
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('execution_finally', 'runner_error', 'manual', 'recheck')),
  trigger_run_id TEXT,
  trigger_execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  severity_text TEXT NOT NULL CHECK(severity_text IN ('INFO', 'WARN', 'ERROR', 'FATAL')),
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'no_issue', 'verified', 'applied', 'rejected', 'failed', 'stale')),
  base_commit TEXT,
  event_from_id INTEGER,
  event_to_id INTEGER,
  incident_fingerprint TEXT,
  summary TEXT,
  diagnosis_json TEXT,
  workspace_path TEXT,
  branch_name TEXT,
  patch_commit TEXT,
  changed_files_json TEXT,
  harness_json TEXT,
  error TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_software_maintenance_execution
  ON software_maintenance_jobs(trigger_execution_id, trigger_kind)
  WHERE trigger_execution_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runtime_events_correlation
  ON runtime_events(run_id, execution_id, event_id);

CREATE INDEX IF NOT EXISTS idx_runtime_events_severity
  ON runtime_events(severity_number, event_id);

CREATE INDEX IF NOT EXISTS idx_software_maintenance_queue
  ON software_maintenance_jobs(status, created_at);

INSERT OR IGNORE INTO project_settings(setting_key, setting_value)
VALUES('software_maintenance_enabled', 'false');

INSERT OR IGNORE INTO project_settings(setting_key, setting_value)
VALUES('software_maintenance_auto_apply', 'true');
