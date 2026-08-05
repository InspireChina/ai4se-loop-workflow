ALTER TABLE requirement_context_questions ADD COLUMN authority TEXT NOT NULL DEFAULT 'human'
  CHECK(authority IN ('human', 'agent'));
ALTER TABLE requirement_context_questions ADD COLUMN selected_option_id TEXT;
ALTER TABLE requirement_context_questions ADD COLUMN decision_text TEXT;
ALTER TABLE requirement_context_questions ADD COLUMN decision_reason TEXT;
ALTER TABLE requirement_context_questions ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'
  CHECK(lifecycle_status IN ('active', 'not_applicable', 'superseded'));
ALTER TABLE requirement_context_questions ADD COLUMN lifecycle_reason TEXT;
ALTER TABLE requirement_context_questions ADD COLUMN superseded_by TEXT;

CREATE TABLE IF NOT EXISTS requirement_context_question_dependencies (
  draft_id TEXT NOT NULL,
  decision_key TEXT NOT NULL,
  parent_decision_key TEXT NOT NULL,
  parent_option_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, decision_key, parent_decision_key, parent_option_id),
  FOREIGN KEY(draft_id, decision_key)
    REFERENCES requirement_context_questions(draft_id, decision_key)
    ON DELETE CASCADE,
  FOREIGN KEY(draft_id, parent_decision_key, parent_option_id)
    REFERENCES requirement_context_question_options(draft_id, decision_key, option_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_requirement_context_question_dependencies_parent
  ON requirement_context_question_dependencies(draft_id, parent_decision_key, parent_option_id);

ALTER TABLE questions ADD COLUMN selected_option_id TEXT;
ALTER TABLE questions ADD COLUMN activation_json TEXT;
ALTER TABLE questions ADD COLUMN status_reason TEXT;
ALTER TABLE questions ADD COLUMN decision_authority TEXT NOT NULL DEFAULT 'human'
  CHECK(decision_authority IN ('human', 'agent'));
