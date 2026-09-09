ALTER TABLE projects ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

UPDATE projects
SET is_default = CASE
  WHEN project_id = (
    SELECT project_id
    FROM projects
    ORDER BY created_at, project_id
    LIMIT 1
  ) THEN 1
  ELSE 0
END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_single_default
ON projects(is_default)
WHERE is_default = 1;
