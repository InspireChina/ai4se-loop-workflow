ALTER TABLE document_comments ADD COLUMN intent TEXT NOT NULL DEFAULT 'change_request'
  CHECK(intent IN ('note', 'question', 'change_request'));

ALTER TABLE document_comments ADD COLUMN feedback_status TEXT NOT NULL DEFAULT 'submitted'
  CHECK(feedback_status IN ('submitted', 'triaged', 'in_progress', 'verifying', 'resolved', 'reopened'));

ALTER TABLE document_comments ADD COLUMN disposition TEXT
  CHECK(disposition IN ('no_change', 'reply', 'revise', 'rewind', 'learning_only'));

ALTER TABLE document_comments ADD COLUMN target_stage TEXT
  CHECK(target_stage IN ('plan', 'analysis', 'dev', 'test', 'review'));

ALTER TABLE document_comments ADD COLUMN target_agent TEXT;
ALTER TABLE document_comments ADD COLUMN target_story_index INTEGER;
ALTER TABLE document_comments ADD COLUMN acceptance_json TEXT;
ALTER TABLE document_comments ADD COLUMN triage_reason TEXT;
ALTER TABLE document_comments ADD COLUMN resolution_claim_json TEXT;
ALTER TABLE document_comments ADD COLUMN verification_json TEXT;
ALTER TABLE document_comments ADD COLUMN triaged_at TEXT;
ALTER TABLE document_comments ADD COLUMN submitted_at TEXT;

UPDATE document_comments
SET feedback_status = CASE WHEN status = 'resolved' THEN 'resolved' ELSE 'submitted' END,
    submitted_at = COALESCE(submitted_at, created_at, CURRENT_TIMESTAMP);

CREATE INDEX IF NOT EXISTS idx_document_comments_feedback_queue
  ON document_comments(feedback_status, intent, created_at);
