ALTER TABLE tasks ADD COLUMN run_state TEXT NOT NULL DEFAULT 'runnable';
ALTER TABLE tasks ADD COLUMN closure_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE tasks ADD COLUMN review_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN review_document_id TEXT;
ALTER TABLE tasks ADD COLUMN closure_acknowledged_at TEXT;

UPDATE tasks
SET closure_status = 'acknowledged',
    run_state = 'idle',
    closure_acknowledged_at = COALESCE(completed_at, updated_at)
WHERE agile_status = 'done';

ALTER TABLE questions ADD COLUMN decision_key TEXT;
ALTER TABLE questions ADD COLUMN alternatives_json TEXT;
ALTER TABLE questions ADD COLUMN recommendation_reason TEXT;
ALTER TABLE questions ADD COLUMN depends_on_json TEXT;
ALTER TABLE questions ADD COLUMN spec_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE questions ADD COLUMN resolved_at TEXT;

UPDATE tasks
SET agile_status = resume_status,
    resume_status = NULL,
    run_state = 'waiting_for_answers'
WHERE agile_status = 'blocked'
  AND current_subagent = 'analyst-agent'
  AND resume_status IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM questions q
    WHERE q.task_id = tasks.task_id AND q.status IN ('pending', 'answered')
  );

UPDATE questions SET status = 'superseded'
WHERE kind = 'review' AND status IN ('pending', 'answered');

UPDATE tasks
SET agile_status = 'in review',
    resume_status = NULL,
    run_state = 'runnable',
    blocked_reason = NULL,
    resume_pending = 0
WHERE agile_status = 'blocked'
  AND current_subagent = 'review-agent'
  AND resume_status = 'in review';

CREATE TABLE IF NOT EXISTS closure_acknowledgements (
  acknowledgement_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  review_document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
  review_revision INTEGER NOT NULL,
  acknowledged_by TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, review_revision)
);

CREATE INDEX IF NOT EXISTS idx_closure_acknowledgements_task
  ON closure_acknowledgements(task_id, review_revision);
