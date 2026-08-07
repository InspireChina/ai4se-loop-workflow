ALTER TABLE delivery_analysis_drafts
ADD COLUMN workflow_phase TEXT NOT NULL DEFAULT 'impact_scan'
  CHECK(workflow_phase IN (
    'impact_scan',
    'decision_tree',
    'delivery_contract',
    'finalize'
  ));

ALTER TABLE delivery_analysis_drafts
ADD COLUMN validated_change_seq INTEGER;

UPDATE delivery_analysis_drafts
SET workflow_phase = 'decision_tree'
WHERE draft_id IN (
  SELECT draft_id FROM agent_work_drafts
  WHERE draft_type = 'analysis' AND status = 'waiting_for_answers'
);

CREATE TABLE IF NOT EXISTS delivery_analysis_phase_transitions (
  transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL REFERENCES delivery_analysis_drafts(draft_id) ON DELETE CASCADE,
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  reason TEXT NOT NULL,
  execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_delivery_analysis_phase_transitions
  ON delivery_analysis_phase_transitions(draft_id, transition_id);

CREATE TABLE IF NOT EXISTS delivery_analysis_decision_dependencies (
  draft_id TEXT NOT NULL,
  decision_key TEXT NOT NULL,
  parent_decision_key TEXT NOT NULL,
  parent_option_id TEXT NOT NULL,
  PRIMARY KEY(draft_id, decision_key, parent_decision_key, parent_option_id),
  FOREIGN KEY(draft_id, decision_key)
    REFERENCES delivery_analysis_decisions(draft_id, decision_key)
    ON DELETE CASCADE,
  FOREIGN KEY(draft_id, parent_decision_key, parent_option_id)
    REFERENCES delivery_analysis_decision_options(draft_id, decision_key, option_id)
    ON DELETE CASCADE
);
