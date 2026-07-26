PRAGMA foreign_keys = OFF;

CREATE TABLE development_drafts_next (
  draft_id TEXT PRIMARY KEY REFERENCES agent_work_drafts(draft_id) ON DELETE CASCADE,
  repository_base_commit TEXT,
  initial_workspace_fingerprint TEXT,
  initial_workspace_tree TEXT,
  initial_workspace_changes_json TEXT
);

INSERT INTO development_drafts_next(
  draft_id, repository_base_commit,
  initial_workspace_fingerprint, initial_workspace_tree, initial_workspace_changes_json
)
SELECT
  draft_id,
  NULL,
  NULL,
  NULL,
  NULL
FROM development_drafts;

CREATE TABLE development_criteria_next (
  draft_id TEXT NOT NULL REFERENCES development_drafts_next(draft_id) ON DELETE CASCADE,
  criterion_key TEXT NOT NULL,
  evidence TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, criterion_key)
);

INSERT INTO development_criteria_next(draft_id, criterion_key, evidence, ordinal)
SELECT draft_id, criterion_key, evidence, ordinal
FROM development_criteria
WHERE status = 'covered';

CREATE TABLE development_checks_next (
  draft_id TEXT NOT NULL REFERENCES development_drafts_next(draft_id) ON DELETE CASCADE,
  check_key TEXT NOT NULL,
  command TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_execution_id TEXT NOT NULL,
  source_receipt_key TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  workspace_fingerprint TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, check_key)
);

DROP TABLE development_criteria;
DROP TABLE development_changes;
DROP TABLE development_tests;
DROP TABLE development_drafts;

ALTER TABLE development_drafts_next RENAME TO development_drafts;
ALTER TABLE development_criteria_next RENAME TO development_criteria;
ALTER TABLE development_checks_next RENAME TO development_checks;

PRAGMA foreign_keys = ON;
