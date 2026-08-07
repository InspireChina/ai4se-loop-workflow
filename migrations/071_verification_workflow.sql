ALTER TABLE verification_drafts
ADD COLUMN workflow_phase TEXT NOT NULL DEFAULT 'plan'
  CHECK(workflow_phase IN ('plan', 'execute', 'evidence_review', 'finalize'));

ALTER TABLE verification_drafts
ADD COLUMN validated_change_seq INTEGER;

ALTER TABLE verification_drafts
ADD COLUMN evidence_review_summary TEXT;

ALTER TABLE verification_drafts
ADD COLUMN residual_risk TEXT;

UPDATE verification_drafts
SET workflow_phase = CASE phase
  WHEN 'executing' THEN 'execute'
  ELSE 'plan'
END;

CREATE TABLE IF NOT EXISTS verification_phase_transitions (
  transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL REFERENCES verification_drafts(draft_id) ON DELETE CASCADE,
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  reason TEXT NOT NULL,
  execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_verification_phase_transitions
  ON verification_phase_transitions(draft_id, transition_id);
