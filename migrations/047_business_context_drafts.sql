ALTER TABLE requirement_context_drafts RENAME COLUMN goal TO intent;
ALTER TABLE requirement_context_drafts DROP COLUMN observable_outcome;
ALTER TABLE requirement_context_drafts ADD COLUMN change_summary TEXT;
DROP TABLE IF EXISTS requirement_context_facts;

CREATE TABLE IF NOT EXISTS requirement_context_assertions (
  draft_id TEXT NOT NULL REFERENCES requirement_context_drafts(draft_id) ON DELETE CASCADE,
  assertion_key TEXT NOT NULL,
  perspective TEXT NOT NULL CHECK(perspective IN ('actual', 'expected', 'target')),
  statement TEXT NOT NULL,
  evidence_status TEXT NOT NULL
    CHECK(evidence_status IN ('observed', 'reported', 'inferred', 'decided', 'conflicted')),
  source TEXT NOT NULL,
  decision_key TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK(lifecycle_status IN ('active', 'dismissed', 'superseded')),
  lifecycle_reason TEXT,
  superseded_by TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, assertion_key)
);

CREATE TABLE IF NOT EXISTS requirement_context_impacts (
  draft_id TEXT NOT NULL REFERENCES requirement_context_drafts(draft_id) ON DELETE CASCADE,
  impact_key TEXT NOT NULL,
  statement TEXT NOT NULL,
  disposition TEXT NOT NULL
    CHECK(disposition IN ('change', 'preserve', 'needs_decision', 'technical')),
  rationale TEXT NOT NULL,
  source TEXT NOT NULL,
  decision_key TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK(lifecycle_status IN ('active', 'dismissed', 'superseded')),
  lifecycle_reason TEXT,
  superseded_by TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, impact_key)
);

CREATE TABLE IF NOT EXISTS requirement_context_acceptance_items (
  draft_id TEXT NOT NULL REFERENCES requirement_context_drafts(draft_id) ON DELETE CASCADE,
  acceptance_key TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK(lifecycle_status IN ('active', 'dismissed', 'superseded')),
  lifecycle_reason TEXT,
  superseded_by TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, acceptance_key)
);

CREATE TABLE IF NOT EXISTS requirement_context_item_revisions (
  revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL REFERENCES requirement_context_drafts(draft_id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK(item_type IN ('assertion', 'impact', 'acceptance')),
  item_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('upsert', 'dismiss', 'supersede')),
  snapshot_json TEXT NOT NULL,
  execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_requirement_context_item_revisions
  ON requirement_context_item_revisions(draft_id, revision_id);
