CREATE TABLE IF NOT EXISTS legacy_project_database_imports (
  source_db_path TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
