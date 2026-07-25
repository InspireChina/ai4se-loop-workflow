PRAGMA foreign_keys = OFF;

CREATE TABLE agent_work_drafts_next (
  draft_id TEXT PRIMARY KEY,
  work_key TEXT NOT NULL,
  draft_version INTEGER NOT NULL CHECK(draft_version > 0),
  draft_type TEXT NOT NULL CHECK(draft_type IN (
    'requirement_context', 'delivery_plan', 'reproduction', 'analysis',
    'development', 'verification', 'feedback'
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

CREATE TABLE feedback_drafts (
  draft_id TEXT PRIMARY KEY REFERENCES agent_work_drafts(draft_id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('triage', 'verify')),
  summary TEXT,
  verification_reason TEXT
);

CREATE TABLE feedback_draft_groups (
  draft_id TEXT NOT NULL REFERENCES feedback_drafts(draft_id) ON DELETE CASCADE,
  group_key TEXT NOT NULL,
  work_type TEXT NOT NULL CHECK(work_type IN (
    'reply', 'historical_correction', 'report_correction', 'bug',
    'behavior_change', 'scope_addition', 'technical_change', 'learning_only'
  )),
  title TEXT,
  reason TEXT NOT NULL,
  response TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, group_key)
);

CREATE TABLE feedback_draft_group_comments (
  draft_id TEXT NOT NULL,
  group_key TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, group_key, comment_id),
  FOREIGN KEY(draft_id, group_key)
    REFERENCES feedback_draft_groups(draft_id, group_key) ON DELETE CASCADE
);

CREATE TABLE feedback_draft_group_units (
  draft_id TEXT NOT NULL,
  group_key TEXT NOT NULL,
  story_index INTEGER NOT NULL CHECK(story_index > 0),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, group_key, story_index),
  FOREIGN KEY(draft_id, group_key)
    REFERENCES feedback_draft_groups(draft_id, group_key) ON DELETE CASCADE
);

CREATE TABLE feedback_draft_acceptance (
  draft_id TEXT NOT NULL,
  group_key TEXT NOT NULL,
  acceptance_key TEXT NOT NULL,
  content TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, group_key, acceptance_key),
  FOREIGN KEY(draft_id, group_key)
    REFERENCES feedback_draft_groups(draft_id, group_key) ON DELETE CASCADE
);

CREATE TABLE feedback_draft_questions (
  draft_id TEXT NOT NULL REFERENCES feedback_drafts(draft_id) ON DELETE CASCADE,
  decision_key TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  impact TEXT NOT NULL,
  recommendation_option_id TEXT,
  recommendation_reason TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, decision_key)
);

CREATE TABLE feedback_draft_question_options (
  draft_id TEXT NOT NULL,
  decision_key TEXT NOT NULL,
  option_id TEXT NOT NULL,
  label TEXT NOT NULL,
  consequence TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, decision_key, option_id),
  FOREIGN KEY(draft_id, decision_key)
    REFERENCES feedback_draft_questions(draft_id, decision_key) ON DELETE CASCADE
);

CREATE TABLE feedback_draft_evidence (
  draft_id TEXT NOT NULL REFERENCES feedback_drafts(draft_id) ON DELETE CASCADE,
  evidence_key TEXT NOT NULL,
  content TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, evidence_key)
);
