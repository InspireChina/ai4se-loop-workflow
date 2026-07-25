PRAGMA foreign_keys = OFF;

CREATE TABLE agent_work_drafts_next (
  draft_id TEXT PRIMARY KEY,
  work_key TEXT NOT NULL,
  draft_version INTEGER NOT NULL CHECK(draft_version > 0),
  draft_type TEXT NOT NULL CHECK(draft_type IN (
    'requirement_context', 'delivery_plan', 'reproduction', 'analysis'
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

CREATE TABLE analysis_drafts (
  draft_id TEXT PRIMARY KEY REFERENCES agent_work_drafts(draft_id) ON DELETE CASCADE,
  goal TEXT
);

CREATE TABLE analysis_scope_items (
  draft_id TEXT NOT NULL REFERENCES analysis_drafts(draft_id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('included', 'excluded')),
  content TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, scope_key)
);

CREATE TABLE analysis_behaviors (
  draft_id TEXT NOT NULL REFERENCES analysis_drafts(draft_id) ON DELETE CASCADE,
  behavior_key TEXT NOT NULL,
  scenario TEXT NOT NULL,
  expected TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, behavior_key)
);

CREATE TABLE analysis_decisions (
  draft_id TEXT NOT NULL REFERENCES analysis_drafts(draft_id) ON DELETE CASCADE,
  decision_key TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  impact TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('resolved_from_context', 'needs_user_input')),
  selected_option_id TEXT,
  source TEXT CHECK(source IN ('code', 'user', 'convention')),
  decision_text TEXT,
  rationale TEXT,
  evidence TEXT,
  recommendation_option_id TEXT,
  recommendation_reason TEXT,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, decision_key)
);

CREATE TABLE analysis_decision_options (
  draft_id TEXT NOT NULL,
  decision_key TEXT NOT NULL,
  option_id TEXT NOT NULL,
  label TEXT NOT NULL,
  consequence TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, decision_key, option_id),
  FOREIGN KEY(draft_id, decision_key)
    REFERENCES analysis_decisions(draft_id, decision_key)
    ON DELETE CASCADE
);

CREATE TABLE analysis_acceptance_criteria (
  draft_id TEXT NOT NULL REFERENCES analysis_drafts(draft_id) ON DELETE CASCADE,
  criterion_key TEXT NOT NULL,
  description TEXT NOT NULL,
  oracle TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, criterion_key)
);

CREATE TABLE analysis_verification_steps (
  draft_id TEXT NOT NULL REFERENCES analysis_drafts(draft_id) ON DELETE CASCADE,
  verification_key TEXT NOT NULL,
  criterion_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('command', 'browser', 'inspection')),
  instruction TEXT NOT NULL,
  command TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, verification_key),
  FOREIGN KEY(draft_id, criterion_key)
    REFERENCES analysis_acceptance_criteria(draft_id, criterion_key)
    ON DELETE CASCADE
);

CREATE TABLE analysis_dependencies (
  draft_id TEXT NOT NULL REFERENCES analysis_drafts(draft_id) ON DELETE CASCADE,
  dependency_key TEXT NOT NULL,
  content TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, dependency_key)
);

CREATE TABLE analysis_budget_items (
  draft_id TEXT NOT NULL REFERENCES analysis_drafts(draft_id) ON DELETE CASCADE,
  budget_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('capability', 'path')),
  content TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, budget_key)
);
