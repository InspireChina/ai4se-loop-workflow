ALTER TABLE stories ADD COLUMN origin_type TEXT NOT NULL DEFAULT 'original'
  CHECK(origin_type IN ('original', 'feedback_behavior', 'feedback_bug', 'feedback_scope', 'feedback_technical'));

ALTER TABLE stories ADD COLUMN origin_feedback_batch_id TEXT;
ALTER TABLE stories ADD COLUMN corrects_story_indexes_json TEXT;

CREATE TABLE IF NOT EXISTS feedback_batches (
  batch_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'triaging'
    CHECK(status IN (
      'triaging',
      'waiting_for_answers',
      'executing',
      'verifying',
      'reporting',
      'completed',
      'cancelled',
      'system_blocked'
    )),
  source_execution_id TEXT,
  summary TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_batches_one_active
  ON feedback_batches(task_id)
  WHERE status NOT IN ('completed', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_feedback_batches_queue
  ON feedback_batches(status, created_at);

CREATE TABLE IF NOT EXISTS feedback_batch_comments (
  batch_id TEXT NOT NULL REFERENCES feedback_batches(batch_id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL REFERENCES document_comments(comment_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(batch_id, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_batch_comments_comment
  ON feedback_batch_comments(comment_id, batch_id);

CREATE TABLE IF NOT EXISTS feedback_groups (
  group_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES feedback_batches(batch_id) ON DELETE CASCADE,
  group_key TEXT NOT NULL,
  work_type TEXT NOT NULL
    CHECK(work_type IN (
      'reply',
      'historical_correction',
      'report_correction',
      'bug',
      'behavior_change',
      'scope_addition',
      'technical_change',
      'learning_only'
    )),
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK(status IN (
      'planned',
      'waiting_for_repro',
      'waiting_for_plan',
      'executing',
      'ready_for_verification',
      'completed',
      'reopened',
      'cancelled',
      'system_blocked'
    )),
  title TEXT,
  reason TEXT NOT NULL,
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  affected_story_indexes_json TEXT NOT NULL DEFAULT '[]',
  response_text TEXT,
  source_execution_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  UNIQUE(batch_id, group_key)
);

CREATE INDEX IF NOT EXISTS idx_feedback_groups_queue
  ON feedback_groups(batch_id, status, created_at);

CREATE TABLE IF NOT EXISTS feedback_group_comments (
  group_id TEXT NOT NULL REFERENCES feedback_groups(group_id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL REFERENCES document_comments(comment_id) ON DELETE CASCADE,
  PRIMARY KEY(group_id, comment_id)
);

CREATE TABLE IF NOT EXISTS feedback_group_delivery_units (
  group_id TEXT NOT NULL REFERENCES feedback_groups(group_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  story_index INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(group_id, task_id, story_index),
  FOREIGN KEY(task_id, story_index) REFERENCES stories(task_id, story_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_feedback_group_delivery_units_unit
  ON feedback_group_delivery_units(task_id, story_index, group_id);

UPDATE document_comments
SET feedback_status = 'submitted',
    disposition = NULL,
    target_stage = NULL,
    target_agent = NULL,
    target_story_index = NULL,
    acceptance_json = NULL,
    triage_reason = NULL,
    resolution_claim_json = NULL,
    verification_json = NULL,
    triaged_at = NULL,
    feedback_batch_id = NULL,
    feedback_is_rewind_frontier = 0,
    feedback_needs_rebase = 0,
    status = 'open',
    resolved_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE feedback_status NOT IN ('resolved');
