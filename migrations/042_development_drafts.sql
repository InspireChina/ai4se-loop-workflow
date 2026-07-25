PRAGMA foreign_keys = OFF;

CREATE TABLE agent_work_drafts_next (
  draft_id TEXT PRIMARY KEY,
  work_key TEXT NOT NULL,
  draft_version INTEGER NOT NULL CHECK(draft_version > 0),
  draft_type TEXT NOT NULL CHECK(draft_type IN (
    'requirement_context', 'delivery_plan', 'reproduction', 'analysis', 'development'
  )),
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  story_index INTEGER,
  agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'editing'
    CHECK(status IN ('editing', 'waiting_for_answers', 'submitted', 'abandoned')),
  change_seq INTEGER NOT NULL DEFAULT 0 CHECK(change_seq >= 0),
  last_execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  status_viewed_execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  terminal_execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  terminal_action TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_at TEXT,
  UNIQUE(work_key, draft_version)
);

INSERT INTO agent_work_drafts_next(
  draft_id, work_key, draft_version, draft_type, task_id, story_index,
  agent, status, change_seq, last_execution_id, status_viewed_execution_id,
  terminal_execution_id, terminal_action, created_at, updated_at, submitted_at
)
SELECT
  draft_id, work_key, draft_version, draft_type, task_id, story_index,
  agent, status, change_seq, last_execution_id, status_viewed_execution_id,
  terminal_execution_id, terminal_action, created_at, updated_at, submitted_at
FROM agent_work_drafts;

DROP TABLE agent_work_drafts;
ALTER TABLE agent_work_drafts_next RENAME TO agent_work_drafts;
CREATE INDEX idx_agent_work_drafts_execution
  ON agent_work_drafts(last_execution_id, status);

PRAGMA foreign_keys = ON;

ALTER TABLE runtime_input_requests ADD COLUMN request_key TEXT;
CREATE UNIQUE INDEX idx_runtime_input_requests_source_key
  ON runtime_input_requests(task_id, story_index, source_agent, request_key)
  WHERE request_key IS NOT NULL;

CREATE TABLE development_drafts (
  draft_id TEXT PRIMARY KEY REFERENCES agent_work_drafts(draft_id) ON DELETE CASCADE,
  summary TEXT,
  assessment_mode TEXT CHECK(
    assessment_mode IS NULL OR assessment_mode IN ('existing', 'changed')
  ),
  implementation_notes TEXT,
  commit_sha TEXT,
  failure_summary TEXT
);

CREATE TABLE development_criteria (
  draft_id TEXT NOT NULL REFERENCES development_drafts(draft_id) ON DELETE CASCADE,
  criterion_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('covered', 'not_covered')),
  evidence TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, criterion_key)
);

CREATE TABLE development_changes (
  draft_id TEXT NOT NULL REFERENCES development_drafts(draft_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  summary TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, path)
);

CREATE TABLE development_tests (
  draft_id TEXT NOT NULL REFERENCES development_drafts(draft_id) ON DELETE CASCADE,
  test_key TEXT NOT NULL,
  command TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK(passed IN (0, 1)),
  summary TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, test_key)
);

CREATE TABLE development_risks (
  draft_id TEXT NOT NULL REFERENCES development_drafts(draft_id) ON DELETE CASCADE,
  risk_key TEXT NOT NULL,
  content TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, risk_key)
);

CREATE TABLE development_runtime_inputs (
  draft_id TEXT NOT NULL REFERENCES development_drafts(draft_id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  why TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, request_key)
);

CREATE TABLE development_recovery_resolutions (
  draft_id TEXT NOT NULL REFERENCES development_drafts(draft_id) ON DELETE CASCADE,
  recovery_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, recovery_id)
);
