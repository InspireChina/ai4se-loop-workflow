-- Physical process ownership outlives logical execution cancellation/claims.
CREATE TABLE IF NOT EXISTS execution_processes (
  allocation_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES execution_attempts(execution_id),
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  owner_pid INTEGER NOT NULL,
  supervision_token INTEGER NOT NULL,
  pid INTEGER,
  process_start_marker TEXT,
  status TEXT NOT NULL DEFAULT 'launching' CHECK (status IN ('launching','running','terminating','exited')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  exited_at TEXT
);
CREATE INDEX IF NOT EXISTS execution_processes_active_run ON execution_processes(run_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS execution_processes_single_active_source
  ON execution_processes(execution_id) WHERE status <> 'exited';

CREATE TABLE IF NOT EXISTS execution_process_barriers (
  allocation_id TEXT NOT NULL REFERENCES execution_processes(allocation_id),
  resource_key TEXT NOT NULL,
  resource_scope TEXT NOT NULL,
  owner_task_id TEXT NOT NULL,
  owner_lane TEXT NOT NULL,
  owner_story_index INTEGER,
  owner_execution_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(allocation_id, resource_key, resource_scope)
);
CREATE INDEX IF NOT EXISTS execution_process_barriers_resource ON execution_process_barriers(resource_key,resource_scope);
