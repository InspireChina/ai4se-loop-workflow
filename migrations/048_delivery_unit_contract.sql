ALTER TABLE stories ADD COLUMN unit_key TEXT;
ALTER TABLE stories ADD COLUMN actor TEXT;
ALTER TABLE stories ADD COLUMN trigger_condition TEXT;
ALTER TABLE stories ADD COLUMN observable_outcome TEXT;
ALTER TABLE stories ADD COLUMN acceptance TEXT;
ALTER TABLE stories ADD COLUMN source_delivery_plan_draft_id TEXT
  REFERENCES delivery_plan_drafts(draft_id) ON DELETE SET NULL;

ALTER TABLE delivery_plan_units ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'
  CHECK(lifecycle_status IN ('active', 'dismissed', 'superseded'));
ALTER TABLE delivery_plan_units ADD COLUMN lifecycle_reason TEXT;
ALTER TABLE delivery_plan_units ADD COLUMN superseded_by TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_stories_task_unit_key
  ON stories(task_id, unit_key)
  WHERE unit_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS delivery_plan_source_items (
  draft_id TEXT NOT NULL REFERENCES delivery_plan_drafts(draft_id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  source_kind TEXT NOT NULL
    CHECK(source_kind IN ('change', 'preserve', 'technical', 'acceptance')),
  content TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(draft_id, source_key)
);

CREATE TABLE IF NOT EXISTS delivery_plan_unit_source_links (
  draft_id TEXT NOT NULL,
  unit_key TEXT NOT NULL,
  source_key TEXT NOT NULL,
  PRIMARY KEY(draft_id, unit_key, source_key),
  FOREIGN KEY(draft_id, unit_key)
    REFERENCES delivery_plan_units(draft_id, unit_key)
    ON DELETE CASCADE,
  FOREIGN KEY(draft_id, source_key)
    REFERENCES delivery_plan_source_items(draft_id, source_key)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS delivery_plan_unit_dependencies (
  draft_id TEXT NOT NULL,
  unit_key TEXT NOT NULL,
  depends_on_unit_key TEXT NOT NULL,
  PRIMARY KEY(draft_id, unit_key, depends_on_unit_key),
  CHECK(unit_key <> depends_on_unit_key),
  FOREIGN KEY(draft_id, unit_key)
    REFERENCES delivery_plan_units(draft_id, unit_key)
    ON DELETE CASCADE,
  FOREIGN KEY(draft_id, depends_on_unit_key)
    REFERENCES delivery_plan_units(draft_id, unit_key)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS delivery_plan_unit_revisions (
  revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL REFERENCES delivery_plan_drafts(draft_id) ON DELETE CASCADE,
  unit_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('upsert', 'dismiss', 'supersede')),
  snapshot_json TEXT NOT NULL,
  execution_id TEXT REFERENCES execution_attempts(execution_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_delivery_plan_unit_revisions
  ON delivery_plan_unit_revisions(draft_id, revision_id);

CREATE TABLE IF NOT EXISTS delivery_unit_context_links (
  task_id TEXT NOT NULL,
  story_index INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  source_kind TEXT NOT NULL
    CHECK(source_kind IN ('change', 'preserve', 'technical', 'acceptance')),
  content TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  PRIMARY KEY(task_id, story_index, source_key),
  FOREIGN KEY(task_id, story_index)
    REFERENCES stories(task_id, story_index)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS delivery_unit_dependencies (
  task_id TEXT NOT NULL,
  story_index INTEGER NOT NULL,
  depends_on_story_index INTEGER NOT NULL,
  PRIMARY KEY(task_id, story_index, depends_on_story_index),
  CHECK(story_index <> depends_on_story_index),
  FOREIGN KEY(task_id, story_index)
    REFERENCES stories(task_id, story_index)
    ON DELETE CASCADE,
  FOREIGN KEY(task_id, depends_on_story_index)
    REFERENCES stories(task_id, story_index)
    ON DELETE CASCADE
);
