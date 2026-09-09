CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_root TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(project_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_tasks_project_status
ON tasks(project_id, agile_status, priority, updated_at);
