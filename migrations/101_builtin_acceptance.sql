-- Acceptance 是跨 Agent 流转的内置业务承诺，不再由 Artifact Block 承载。
CREATE TABLE acceptances (
  acceptance_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  acceptance_key TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('requirement', 'delivery_unit')),
  story_index INTEGER,
  statement TEXT NOT NULL,
  oracle TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_command_chain_draft_id TEXT REFERENCES agent_work_drafts(draft_id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active', 'superseded')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, acceptance_key),
  CHECK(
    (scope_type = 'requirement' AND story_index IS NULL)
    OR (scope_type = 'delivery_unit' AND story_index IS NOT NULL)
  )
);

CREATE TABLE command_chain_acceptance_items (
  draft_id TEXT NOT NULL REFERENCES command_chain_drafts(draft_id) ON DELETE CASCADE,
  acceptance_key TEXT NOT NULL,
  statement TEXT NOT NULL,
  oracle TEXT NOT NULL,
  source TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(draft_id, acceptance_key)
);

CREATE TABLE delivery_unit_acceptances (
  task_id TEXT NOT NULL,
  story_index INTEGER NOT NULL,
  acceptance_id TEXT NOT NULL REFERENCES acceptances(acceptance_id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK(relation IN ('assigned', 'unit')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(task_id, story_index, acceptance_id),
  FOREIGN KEY(task_id, story_index) REFERENCES stories(task_id, story_index) ON DELETE CASCADE
);

CREATE TABLE acceptance_assessments (
  assessment_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES command_chain_drafts(draft_id) ON DELETE CASCADE,
  acceptance_id TEXT NOT NULL REFERENCES acceptances(acceptance_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  story_index INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('implementation', 'verification', 'review')),
  agent TEXT NOT NULL,
  execution_id TEXT NOT NULL REFERENCES execution_attempts(execution_id) ON DELETE CASCADE,
  result TEXT NOT NULL CHECK(result IN ('claimed', 'passed', 'failed', 'blocked')),
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(draft_id, acceptance_id, kind)
);

CREATE INDEX idx_acceptances_task_scope
  ON acceptances(task_id, scope_type, story_index, lifecycle, acceptance_key);
CREATE INDEX idx_delivery_unit_acceptances_unit
  ON delivery_unit_acceptances(task_id, story_index, relation);
CREATE INDEX idx_acceptance_assessments_acceptance
  ON acceptance_assessments(acceptance_id, kind, created_at);
