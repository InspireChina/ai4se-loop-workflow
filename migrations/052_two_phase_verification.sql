PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS verification_recovery_checks;
DROP TABLE IF EXISTS verification_runtime_inputs;
DROP TABLE IF EXISTS verification_risks;
DROP TABLE IF EXISTS verification_checks;
DROP TABLE IF EXISTS verification_criteria;
DROP TABLE IF EXISTS verification_drafts;
DROP TABLE IF EXISTS verification_evidence;
DROP TABLE IF EXISTS verification_runs;

DELETE FROM agent_work_drafts
WHERE draft_type = 'verification';

CREATE TABLE verification_drafts (
  draft_id TEXT PRIMARY KEY REFERENCES agent_work_drafts(draft_id) ON DELETE CASCADE,
  phase TEXT NOT NULL DEFAULT 'planning'
    CHECK(phase IN ('planning', 'executing')),
  spec_revision INTEGER
);

CREATE TABLE verification_plan_scenarios (
  draft_id TEXT NOT NULL REFERENCES verification_drafts(draft_id) ON DELETE CASCADE,
  scenario_key TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('frontend', 'api')),
  title TEXT NOT NULL,
  setup TEXT NOT NULL,
  steps TEXT NOT NULL,
  expected TEXT NOT NULL,
  coverage_refs_json TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, scenario_key)
);

CREATE TABLE verification_results (
  draft_id TEXT NOT NULL REFERENCES verification_drafts(draft_id) ON DELETE CASCADE,
  scenario_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('passed', 'failed', 'blocked')),
  failure_kind TEXT CHECK(
    failure_kind IS NULL OR failure_kind IN (
      'implementation', 'specification', 'environment', 'inconclusive'
    )
  ),
  evidence TEXT NOT NULL,
  actual_behavior TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, scenario_key),
  FOREIGN KEY(draft_id, scenario_key)
    REFERENCES verification_plan_scenarios(draft_id, scenario_key)
    ON DELETE CASCADE
);

PRAGMA foreign_keys = ON;
