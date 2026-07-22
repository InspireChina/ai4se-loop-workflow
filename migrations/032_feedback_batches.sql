ALTER TABLE document_comments ADD COLUMN feedback_batch_id TEXT;

ALTER TABLE document_comments ADD COLUMN feedback_is_rewind_frontier INTEGER NOT NULL DEFAULT 0
  CHECK(feedback_is_rewind_frontier IN (0, 1));

ALTER TABLE document_comments ADD COLUMN feedback_needs_rebase INTEGER NOT NULL DEFAULT 0
  CHECK(feedback_needs_rebase IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_document_comments_feedback_batch
  ON document_comments(task_id, feedback_batch_id, feedback_status, created_at);
