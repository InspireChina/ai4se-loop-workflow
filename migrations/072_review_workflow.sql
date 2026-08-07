ALTER TABLE review_drafts
ADD COLUMN workflow_phase TEXT NOT NULL DEFAULT 'fact_reconciliation'
  CHECK(workflow_phase IN (
    'fact_reconciliation', 'closure_assessment', 'report',
    'forward_units', 'finalize'
  ));

ALTER TABLE review_drafts ADD COLUMN validated_change_seq INTEGER;
ALTER TABLE review_drafts ADD COLUMN assessment_summary TEXT;
ALTER TABLE review_drafts ADD COLUMN assessment_evidence_boundary TEXT;
ALTER TABLE review_drafts ADD COLUMN assessment_residual_risk TEXT;

CREATE TABLE review_forward_units (
  draft_id TEXT NOT NULL REFERENCES review_drafts(draft_id) ON DELETE CASCADE,
  unit_key TEXT NOT NULL,
  title TEXT NOT NULL,
  actor TEXT NOT NULL,
  trigger_condition TEXT NOT NULL,
  observable_outcome TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, unit_key)
);

CREATE TABLE review_forward_unit_gaps (
  draft_id TEXT NOT NULL,
  unit_key TEXT NOT NULL,
  gap_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, unit_key, gap_key),
  UNIQUE(draft_id, gap_key),
  FOREIGN KEY(draft_id, unit_key)
    REFERENCES review_forward_units(draft_id, unit_key) ON DELETE CASCADE,
  FOREIGN KEY(draft_id, gap_key)
    REFERENCES review_gaps(draft_id, gap_key) ON DELETE CASCADE
);

CREATE TABLE review_forward_unit_dependencies (
  draft_id TEXT NOT NULL,
  unit_key TEXT NOT NULL,
  depends_on_unit_key TEXT NOT NULL,
  PRIMARY KEY(draft_id, unit_key, depends_on_unit_key),
  FOREIGN KEY(draft_id, unit_key)
    REFERENCES review_forward_units(draft_id, unit_key) ON DELETE CASCADE,
  FOREIGN KEY(draft_id, depends_on_unit_key)
    REFERENCES review_forward_units(draft_id, unit_key) ON DELETE CASCADE,
  CHECK(unit_key != depends_on_unit_key)
);

CREATE TABLE review_phase_transitions (
  transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL REFERENCES review_drafts(draft_id) ON DELETE CASCADE,
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  reason TEXT NOT NULL,
  execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_review_phase_transitions
  ON review_phase_transitions(draft_id, transition_id);

CREATE TABLE review_gap_delivery_unit_links (
  source_result_id TEXT NOT NULL REFERENCES agent_results(result_id) ON DELETE CASCADE,
  gap_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  story_index INTEGER NOT NULL,
  subject_ref TEXT NOT NULL,
  gap_kind TEXT NOT NULL
    CHECK(gap_kind IN ('missing_evidence', 'fact_conflict', 'unresolved_obligation')),
  reason TEXT NOT NULL,
  boundary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(source_result_id, gap_key),
  FOREIGN KEY(task_id, story_index)
    REFERENCES stories(task_id, story_index) ON DELETE CASCADE
);

INSERT INTO review_gap_delivery_unit_links(
  source_result_id, gap_key, task_id, story_index,
  subject_ref, gap_kind, reason, boundary, created_at
)
SELECT source_result_id, gap_key, task_id, story_index,
       subject_ref, gap_kind, reason, boundary, created_at
FROM review_gap_delivery_units;

CREATE INDEX idx_review_gap_delivery_unit_links_task
  ON review_gap_delivery_unit_links(task_id, story_index);
