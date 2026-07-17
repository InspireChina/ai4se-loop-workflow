CREATE TABLE IF NOT EXISTS story_specs (
  spec_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  story_index INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'waiting_for_answers', 'resolved', 'superseded')),
  spec_json TEXT NOT NULL,
  source_result_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  UNIQUE(task_id, story_index, revision),
  FOREIGN KEY(task_id, story_index) REFERENCES stories(task_id, story_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_story_specs_current
  ON story_specs(task_id, story_index, status, revision);
