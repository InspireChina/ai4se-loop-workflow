ALTER TABLE interventions ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy-unknown'
  CHECK(source_kind IN ('legacy-unknown','human-input','assistance-request','agent-fault'));
ALTER TABLE interventions ADD COLUMN repair_case_id TEXT;

CREATE TABLE repair_observation_outbox (
  observation_id TEXT PRIMARY KEY,
  intervention_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  observation_json TEXT NOT NULL CHECK(json_valid(observation_json)),
  repair_case_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT
);
CREATE INDEX repair_outbox_pending ON repair_observation_outbox(delivered_at,created_at);

-- Preserve genuine operator input. Unknown legacy records are NOT blanket
-- converted into automatic repair just because their status is awaiting_human.
UPDATE interventions SET source_kind = 'human-input' WHERE resolver_strategy = 'human_only';
