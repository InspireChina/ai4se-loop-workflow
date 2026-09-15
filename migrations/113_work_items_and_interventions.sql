CREATE TABLE IF NOT EXISTS workflow_items (
  item_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  work_key TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  story_index INTEGER,
  agent TEXT,
  pipeline TEXT,
  lane TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'ready', 'running', 'waiting', 'completed', 'superseded', 'cancelled'
  )),
  origin TEXT NOT NULL DEFAULT 'native' CHECK(origin IN ('native', 'legacy_projection')),
  source_state_hash TEXT,
  completion_authority TEXT CHECK(completion_authority IS NULL OR completion_authority IN (
    'agent', 'system', 'arbitration', 'human'
  )),
  completion_reason TEXT,
  superseded_by_item_id TEXT REFERENCES workflow_items(item_id) ON DELETE SET NULL,
  ready_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, work_key, revision)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_items_active_key
  ON workflow_items(task_id, work_key)
  WHERE status NOT IN ('superseded', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_workflow_items_schedule
  ON workflow_items(status, lane, ready_at, updated_at);

CREATE INDEX IF NOT EXISTS idx_workflow_items_task
  ON workflow_items(task_id, story_index, created_at);

CREATE TABLE IF NOT EXISTS workflow_dependencies (
  item_id TEXT NOT NULL REFERENCES workflow_items(item_id) ON DELETE CASCADE,
  depends_on_item_id TEXT NOT NULL REFERENCES workflow_items(item_id) ON DELETE CASCADE,
  dependency_kind TEXT NOT NULL DEFAULT 'completion'
    CHECK(dependency_kind IN ('completion', 'ordering')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(item_id, depends_on_item_id),
  CHECK(item_id != depends_on_item_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_dependencies_upstream
  ON workflow_dependencies(depends_on_item_id, item_id);

CREATE TABLE IF NOT EXISTS interventions (
  intervention_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  item_id TEXT REFERENCES workflow_items(item_id) ON DELETE SET NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
    'pending', 'running', 'resolved', 'awaiting_human', 'superseded', 'cancelled'
  )),
  resolver_strategy TEXT NOT NULL DEFAULT 'system_then_human'
    CHECK(resolver_strategy IN ('system_then_human', 'human_only')),
  authority TEXT NOT NULL DEFAULT 'standard'
    CHECK(authority IN ('standard', 'arbitration')),
  requested_by TEXT NOT NULL DEFAULT 'system',
  source_execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  summary TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  context_hash TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  max_system_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_system_attempts >= 0),
  current_execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  active_session_id TEXT,
  command_token_hash TEXT,
  status_viewed_session_id TEXT,
  resolution TEXT,
  resolved_by TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  escalated_at TEXT,
  UNIQUE(task_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_interventions_queue
  ON interventions(status, resolver_strategy, created_at);

CREATE INDEX IF NOT EXISTS idx_interventions_task
  ON interventions(task_id, status, created_at);

CREATE TABLE IF NOT EXISTS intervention_attempts (
  attempt_id TEXT PRIMARY KEY,
  intervention_id TEXT NOT NULL REFERENCES interventions(intervention_id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL UNIQUE REFERENCES execution_attempts(execution_id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK(attempt > 0),
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN (
    'running', 'resolved', 'deferred', 'failed', 'cancelled'
  )),
  reason TEXT,
  resolution TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  UNIQUE(intervention_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_intervention_attempts_intervention
  ON intervention_attempts(intervention_id, attempt);

ALTER TABLE verification_assistance_jobs
  ADD COLUMN intervention_id TEXT REFERENCES interventions(intervention_id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_assistance_intervention
  ON verification_assistance_jobs(intervention_id)
  WHERE intervention_id IS NOT NULL;

INSERT OR IGNORE INTO interventions(
  intervention_id, task_id, item_id, dedupe_key, status,
  resolver_strategy, authority, requested_by, source_execution_id,
  summary, context_json, context_hash, attempt_count,
  max_system_attempts, current_execution_id, resolution, resolved_by,
  last_error, created_at, updated_at, resolved_at, escalated_at
)
SELECT
  'INT-' || job.job_id,
  job.task_id,
  NULL,
  'verification-assistance:' || job.request_id,
  CASE job.status
    WHEN 'escalated' THEN 'awaiting_human'
    ELSE job.status
  END,
  'system_then_human',
  'standard',
  COALESCE(request.source_agent, 'test-agent'),
  request.source_execution_id,
  request.title,
  '{"verificationRequestId":"' || job.request_id || '","legacyVerificationJobId":"' || job.job_id || '"}',
  'legacy-verification:' || job.job_id,
  job.attempt_count,
  job.max_attempts,
  job.current_execution_id,
  job.answer,
  CASE WHEN job.status = 'resolved' THEN 'system-assistance-agent' END,
  job.last_reason,
  job.created_at,
  job.updated_at,
  job.resolved_at,
  job.escalated_at
FROM verification_assistance_jobs job
JOIN runtime_input_requests request ON request.request_id = job.request_id;

UPDATE verification_assistance_jobs
SET intervention_id = 'INT-' || job_id
WHERE intervention_id IS NULL;

INSERT OR IGNORE INTO intervention_attempts(
  attempt_id, intervention_id, execution_id, attempt, status,
  reason, resolution, started_at, finished_at
)
SELECT
  'INT-' || attempt.attempt_id,
  'INT-' || attempt.job_id,
  attempt.execution_id,
  attempt.attempt,
  attempt.status,
  attempt.reason,
  attempt.answer,
  attempt.started_at,
  attempt.finished_at
FROM verification_assistance_attempts attempt;
