CREATE TABLE IF NOT EXISTS review_gap_delivery_units (
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
  UNIQUE(task_id, story_index),
  FOREIGN KEY(task_id, story_index)
    REFERENCES stories(task_id, story_index)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_review_gap_delivery_units_task
  ON review_gap_delivery_units(task_id, story_index);
