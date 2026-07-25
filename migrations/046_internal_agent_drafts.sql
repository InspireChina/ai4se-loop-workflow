CREATE TABLE internal_agent_drafts (
  draft_id TEXT PRIMARY KEY,
  work_type TEXT NOT NULL CHECK(work_type IN ('evolution', 'maintenance')),
  work_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'editing'
    CHECK(status IN ('editing', 'submitted')),
  change_seq INTEGER NOT NULL DEFAULT 0 CHECK(change_seq >= 0),
  active_session_id TEXT,
  command_token_hash TEXT,
  status_viewed_session_id TEXT,
  terminal_action TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_at TEXT,
  UNIQUE(work_type, work_id)
);

CREATE TABLE evolution_evaluator_drafts (
  draft_id TEXT PRIMARY KEY REFERENCES internal_agent_drafts(draft_id) ON DELETE CASCADE,
  summary TEXT
);

CREATE TABLE evolution_evaluator_observations (
  draft_id TEXT NOT NULL REFERENCES evolution_evaluator_drafts(draft_id) ON DELETE CASCADE,
  observation_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN (
    'tool-usage', 'reasoning', 'verification', 'output-contract', 'workflow-efficiency'
  )),
  summary TEXT NOT NULL,
  guidance TEXT NOT NULL,
  target TEXT NOT NULL CHECK(target IN ('daily', 'memory', 'prompt')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  reusable INTEGER NOT NULL CHECK(reusable IN (0, 1)),
  evidence_comment_ids_json TEXT NOT NULL DEFAULT '[]',
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, observation_key)
);

CREATE TABLE software_maintenance_drafts (
  draft_id TEXT PRIMARY KEY REFERENCES internal_agent_drafts(draft_id) ON DELETE CASCADE,
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('no_issue', 'fixed', 'not_repairable')),
  fingerprint TEXT,
  classification TEXT CHECK(classification IS NULL OR classification IN (
    'loop_bug', 'executor_issue', 'target_repo_issue', 'expected_failure', 'insufficient_evidence'
  )),
  summary TEXT,
  root_cause TEXT,
  confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  follow_up TEXT
);

CREATE TABLE software_maintenance_draft_files (
  draft_id TEXT NOT NULL REFERENCES software_maintenance_drafts(draft_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, path)
);

CREATE TABLE software_maintenance_draft_tests (
  draft_id TEXT NOT NULL REFERENCES software_maintenance_drafts(draft_id) ON DELETE CASCADE,
  test_key TEXT NOT NULL,
  command TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK(passed IN (0, 1)),
  summary TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, test_key)
);
