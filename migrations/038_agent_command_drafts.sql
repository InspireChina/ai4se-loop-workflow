ALTER TABLE execution_attempts ADD COLUMN command_token_hash TEXT;

CREATE TABLE IF NOT EXISTS agent_work_drafts (
  draft_id TEXT PRIMARY KEY,
  work_key TEXT NOT NULL,
  draft_version INTEGER NOT NULL CHECK(draft_version > 0),
  draft_type TEXT NOT NULL CHECK(draft_type IN ('requirement_context')),
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

CREATE INDEX IF NOT EXISTS idx_agent_work_drafts_execution
  ON agent_work_drafts(last_execution_id, status);

CREATE TABLE IF NOT EXISTS requirement_context_drafts (
  draft_id TEXT PRIMARY KEY REFERENCES agent_work_drafts(draft_id) ON DELETE CASCADE,
  goal TEXT,
  observable_outcome TEXT,
  classification TEXT CHECK(classification IS NULL OR classification IN ('feature', 'bug', 'tech', 'other'))
);

CREATE TABLE IF NOT EXISTS requirement_context_facts (
  draft_id TEXT NOT NULL REFERENCES requirement_context_drafts(draft_id) ON DELETE CASCADE,
  fact_key TEXT NOT NULL,
  statement TEXT NOT NULL,
  source TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, fact_key)
);

CREATE TABLE IF NOT EXISTS requirement_context_constraints (
  draft_id TEXT NOT NULL REFERENCES requirement_context_drafts(draft_id) ON DELETE CASCADE,
  constraint_key TEXT NOT NULL,
  content TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, constraint_key)
);

CREATE TABLE IF NOT EXISTS requirement_context_scope_items (
  draft_id TEXT NOT NULL REFERENCES requirement_context_drafts(draft_id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('included', 'excluded')),
  content TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, scope_key)
);

CREATE TABLE IF NOT EXISTS requirement_context_questions (
  draft_id TEXT NOT NULL REFERENCES requirement_context_drafts(draft_id) ON DELETE CASCADE,
  decision_key TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  impact TEXT NOT NULL,
  recommendation_option_id TEXT,
  recommendation_reason TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, decision_key)
);

CREATE TABLE IF NOT EXISTS requirement_context_question_options (
  draft_id TEXT NOT NULL,
  decision_key TEXT NOT NULL,
  option_id TEXT NOT NULL,
  label TEXT NOT NULL,
  consequence TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, decision_key, option_id),
  FOREIGN KEY(draft_id, decision_key)
    REFERENCES requirement_context_questions(draft_id, decision_key)
    ON DELETE CASCADE
);
