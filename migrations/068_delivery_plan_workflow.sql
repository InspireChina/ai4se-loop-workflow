ALTER TABLE delivery_plan_drafts
ADD COLUMN workflow_phase TEXT NOT NULL DEFAULT 'planning_basis'
  CHECK(workflow_phase IN (
    'planning_basis',
    'delivery_units',
    'coverage_order',
    'finalize'
  ));

ALTER TABLE delivery_plan_drafts
ADD COLUMN validated_change_seq INTEGER;

CREATE TABLE IF NOT EXISTS delivery_plan_phase_transitions (
  transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL REFERENCES delivery_plan_drafts(draft_id) ON DELETE CASCADE,
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  reason TEXT NOT NULL,
  execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_delivery_plan_phase_transitions
  ON delivery_plan_phase_transitions(draft_id, transition_id);
