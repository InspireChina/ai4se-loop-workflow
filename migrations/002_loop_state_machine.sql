ALTER TABLE tasks ADD COLUMN link TEXT;
ALTER TABLE tasks ADD COLUMN external_id TEXT;
ALTER TABLE tasks ADD COLUMN external_status TEXT;
ALTER TABLE tasks ADD COLUMN resume_status TEXT;
ALTER TABLE tasks ADD COLUMN resume_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN review_approved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN last_actor TEXT;
ALTER TABLE tasks ADD COLUMN owner TEXT;
ALTER TABLE tasks ADD COLUMN evidence TEXT;
ALTER TABLE tasks ADD COLUMN risk TEXT;
ALTER TABLE tasks ADD COLUMN completed_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_link_unique ON tasks(link) WHERE link IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_active_code_slot ON tasks(agile_status, resume_status);

CREATE TABLE IF NOT EXISTS loop_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO loop_meta(key, value) VALUES ('schema_version', '2');
UPDATE tasks SET analysis_approved_index = analysis_index WHERE analysis_approved_index < analysis_index;
