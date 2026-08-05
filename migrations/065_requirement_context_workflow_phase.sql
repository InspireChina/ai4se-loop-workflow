ALTER TABLE requirement_context_drafts
ADD COLUMN workflow_phase TEXT NOT NULL DEFAULT 'as_is'
  CHECK(workflow_phase IN (
    'as_is',
    'decision_tree',
    'to_be',
    'impact_scan',
    'scope',
    'acceptance',
    'finalize'
  ));

CREATE TABLE IF NOT EXISTS requirement_context_phase_transitions (
  transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL REFERENCES requirement_context_drafts(draft_id) ON DELETE CASCADE,
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  reason TEXT NOT NULL,
  execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_requirement_context_phase_transitions
  ON requirement_context_phase_transitions(draft_id, transition_id);
