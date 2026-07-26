PRAGMA foreign_keys = OFF;

DELETE FROM agent_work_drafts
WHERE draft_type = 'review';

DROP TABLE IF EXISTS review_runtime_inputs;
DROP TABLE IF EXISTS review_evidence;
DROP TABLE IF EXISTS review_sections;
DROP TABLE IF EXISTS review_drafts;

CREATE TABLE review_drafts (
  draft_id TEXT PRIMARY KEY REFERENCES agent_work_drafts(draft_id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('closure', 'report_correction')),
  baseline_review_document_id TEXT REFERENCES documents(document_id) ON DELETE SET NULL,
  baseline_review_revision INTEGER CHECK(
    baseline_review_revision IS NULL OR baseline_review_revision > 0
  )
);

CREATE TABLE review_required_subjects (
  draft_id TEXT NOT NULL REFERENCES review_drafts(draft_id) ON DELETE CASCADE,
  subject_ref TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN (
    'intent', 'target', 'impact', 'acceptance', 'delivery_unit', 'feedback_acceptance'
  )),
  content TEXT NOT NULL,
  source_ref TEXT,
  contract_ref TEXT,
  story_index INTEGER CHECK(story_index IS NULL OR story_index > 0),
  subject_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, subject_ref)
);

CREATE TABLE review_reconciliations (
  draft_id TEXT NOT NULL REFERENCES review_drafts(draft_id) ON DELETE CASCADE,
  reconciliation_key TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  result TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, reconciliation_key),
  UNIQUE(draft_id, subject_ref),
  FOREIGN KEY(draft_id, subject_ref)
    REFERENCES review_required_subjects(draft_id, subject_ref)
    ON DELETE CASCADE
);

CREATE TABLE review_reconciliation_evidence (
  draft_id TEXT NOT NULL,
  reconciliation_key TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  evidence_revision INTEGER,
  evidence_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, reconciliation_key, evidence_ref),
  FOREIGN KEY(draft_id, reconciliation_key)
    REFERENCES review_reconciliations(draft_id, reconciliation_key)
    ON DELETE CASCADE
);

CREATE TABLE review_gaps (
  draft_id TEXT NOT NULL REFERENCES review_drafts(draft_id) ON DELETE CASCADE,
  gap_key TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  gap_kind TEXT NOT NULL CHECK(gap_kind IN (
    'missing_evidence', 'fact_conflict', 'unresolved_obligation'
  )),
  reason TEXT NOT NULL,
  boundary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'resolved', 'forwarded')),
  resolution TEXT,
  forwarded_story_index INTEGER CHECK(
    forwarded_story_index IS NULL OR forwarded_story_index > 0
  ),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, gap_key),
  FOREIGN KEY(draft_id, subject_ref)
    REFERENCES review_required_subjects(draft_id, subject_ref)
    ON DELETE CASCADE
);

CREATE TABLE review_sections (
  draft_id TEXT NOT NULL REFERENCES review_drafts(draft_id) ON DELETE CASCADE,
  section_kind TEXT NOT NULL CHECK(section_kind IN (
    'outcome', 'scope', 'decisions', 'implementation',
    'verification', 'deviations', 'risks', 'feedback'
  )),
  content TEXT NOT NULL,
  PRIMARY KEY(draft_id, section_kind)
);

CREATE UNIQUE INDEX idx_review_gaps_one_active_subject
  ON review_gaps(draft_id, subject_ref)
  WHERE status = 'active';

PRAGMA foreign_keys = ON;
