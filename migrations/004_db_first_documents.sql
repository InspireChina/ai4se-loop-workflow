CREATE TABLE IF NOT EXISTS documents (
  document_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  story_index INTEGER,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'markdown',
  source_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, story_index, kind)
);

CREATE INDEX IF NOT EXISTS idx_documents_task ON documents(task_id, story_index, kind);

UPDATE tasks SET work_dir = '' WHERE work_dir IS NOT NULL;
