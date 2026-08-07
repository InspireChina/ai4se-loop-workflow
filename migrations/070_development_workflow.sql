ALTER TABLE development_drafts
ADD COLUMN workflow_phase TEXT NOT NULL DEFAULT 'implement'
  CHECK(workflow_phase IN ('implement', 'review', 'developer_verify', 'finalize'));

ALTER TABLE development_drafts
ADD COLUMN validated_change_seq INTEGER;

ALTER TABLE development_drafts
ADD COLUMN review_result TEXT CHECK(review_result IN ('pass', 'needs_changes'));

ALTER TABLE development_drafts
ADD COLUMN review_summary TEXT;

ALTER TABLE development_drafts
ADD COLUMN review_evidence TEXT;

CREATE TABLE IF NOT EXISTS development_phase_transitions (
  transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL REFERENCES development_drafts(draft_id) ON DELETE CASCADE,
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  reason TEXT NOT NULL,
  execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_development_phase_transitions
  ON development_phase_transitions(draft_id, transition_id);
