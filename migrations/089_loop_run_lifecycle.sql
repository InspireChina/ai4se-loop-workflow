CREATE TABLE IF NOT EXISTS loop_lifecycle_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  desired_intent TEXT NOT NULL DEFAULT 'stopped' CHECK(desired_intent IN ('running', 'stopped')),
  intent_revision INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'normal' CHECK(mode IN ('normal', 'update-silence')),
  update_attempt_id TEXT,
  update_target_version TEXT,
  update_readiness TEXT CHECK(update_readiness IS NULL OR update_readiness IN ('stopping', 'ready', 'blocked')),
  actual_phase TEXT NOT NULL DEFAULT 'stopped' CHECK(actual_phase IN ('starting', 'running', 'stopping', 'stopped', 'crashed')),
  active_run_id TEXT,
  restart_count INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  healthy_since TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO loop_lifecycle_state(
  singleton, desired_intent, intent_revision, actual_phase, active_run_id
)
SELECT 1,
       CASE WHEN EXISTS(SELECT 1 FROM loop_meta WHERE key = 'loop_run_intent') THEN 'running' ELSE 'stopped' END,
       CASE WHEN EXISTS(SELECT 1 FROM loop_meta WHERE key = 'loop_run_intent') THEN 1 ELSE 0 END,
       CASE WHEN EXISTS(SELECT 1 FROM loop_meta WHERE key = 'active_run') THEN 'crashed' ELSE 'stopped' END,
       NULL;

DELETE FROM loop_meta WHERE key = 'loop_run_intent';

CREATE TABLE IF NOT EXISTS loop_lifecycle_commands (
  request_id TEXT PRIMARY KEY,
  source_adapter TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS loop_supervisor_lease (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  owner_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS loop_managed_processes (
  process_id TEXT PRIMARY KEY,
  supervision_token INTEGER NOT NULL,
  process_kind TEXT NOT NULL CHECK(process_kind IN ('ui-server', 'agent-runner', 'agent-cli')),
  pid INTEGER NOT NULL,
  process_start_marker TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'exited')),
  registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  exited_at TEXT,
  UNIQUE(supervision_token, process_kind, pid, process_start_marker)
);

CREATE INDEX IF NOT EXISTS idx_loop_managed_processes_active
  ON loop_managed_processes(status, supervision_token, process_kind);

ALTER TABLE loop_runs ADD COLUMN supervision_token INTEGER;

DELETE FROM project_settings
WHERE setting_key IN ('software_maintenance_enabled', 'software_maintenance_auto_apply');

DELETE FROM internal_agent_drafts WHERE work_type = 'maintenance';

DROP TABLE IF EXISTS software_maintenance_draft_tests;
DROP TABLE IF EXISTS software_maintenance_draft_files;
DROP TABLE IF EXISTS software_maintenance_drafts;
DROP TABLE IF EXISTS software_maintenance_jobs;
