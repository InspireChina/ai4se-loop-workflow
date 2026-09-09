ALTER TABLE projects ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_projects_active_default
ON projects(deleted_at, is_default, created_at);

CREATE TRIGGER IF NOT EXISTS projects_deleted_cannot_be_default_insert
BEFORE INSERT ON projects
WHEN NEW.deleted_at IS NOT NULL AND NEW.is_default = 1
BEGIN
  SELECT RAISE(ABORT, 'deleted project cannot be default');
END;

CREATE TRIGGER IF NOT EXISTS projects_deleted_cannot_be_default_update
BEFORE UPDATE OF deleted_at, is_default ON projects
WHEN NEW.deleted_at IS NOT NULL AND NEW.is_default = 1
BEGIN
  SELECT RAISE(ABORT, 'deleted project cannot be default');
END;
