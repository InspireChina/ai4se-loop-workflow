ALTER TABLE scheduled_requirement_plans
ADD COLUMN project_id TEXT REFERENCES projects(project_id) ON DELETE RESTRICT;

UPDATE scheduled_requirement_plans
SET project_id = COALESCE(
  (SELECT task.project_id FROM tasks task WHERE task.task_id = scheduled_requirement_plans.last_task_id),
  (SELECT project.project_id FROM projects project WHERE project.is_default = 1 LIMIT 1),
  (SELECT project.project_id FROM projects project ORDER BY project.created_at, project.project_id LIMIT 1)
)
WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_requirement_plans_project_due
ON scheduled_requirement_plans(project_id, enabled, deleted_at, next_trigger_at);

CREATE TRIGGER IF NOT EXISTS trg_tasks_project_default_insert
AFTER INSERT ON tasks
WHEN NEW.project_id IS NULL
BEGIN
  UPDATE tasks
  SET project_id = COALESCE(
    (SELECT project_id FROM projects WHERE is_default = 1 LIMIT 1),
    (SELECT project_id FROM projects ORDER BY created_at, project_id LIMIT 1)
  )
  WHERE task_id = NEW.task_id;
  SELECT RAISE(ABORT, '需求必须绑定项目')
  WHERE (SELECT project_id FROM tasks WHERE task_id = NEW.task_id) IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_project_default_update
AFTER UPDATE OF project_id ON tasks
WHEN NEW.project_id IS NULL
BEGIN
  UPDATE tasks
  SET project_id = COALESCE(
    (SELECT project_id FROM projects WHERE is_default = 1 LIMIT 1),
    (SELECT project_id FROM projects ORDER BY created_at, project_id LIMIT 1)
  )
  WHERE task_id = NEW.task_id;
  SELECT RAISE(ABORT, '需求必须绑定项目')
  WHERE (SELECT project_id FROM tasks WHERE task_id = NEW.task_id) IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_schedules_project_required_insert
BEFORE INSERT ON scheduled_requirement_plans
WHEN NEW.project_id IS NULL
BEGIN
  SELECT RAISE(ABORT, '定时需求必须绑定项目');
END;

CREATE TRIGGER IF NOT EXISTS trg_schedules_project_required_update
BEFORE UPDATE OF project_id ON scheduled_requirement_plans
WHEN NEW.project_id IS NULL
BEGIN
  SELECT RAISE(ABORT, '定时需求必须绑定项目');
END;

CREATE TRIGGER IF NOT EXISTS trg_task_dependencies_same_project_insert
BEFORE INSERT ON task_dependencies
WHEN (
  SELECT task.project_id <> upstream.project_id
  FROM tasks task, tasks upstream
  WHERE task.task_id = NEW.task_id AND upstream.task_id = NEW.depends_on_task_id
)
BEGIN
  SELECT RAISE(ABORT, '前置需求必须属于同一项目');
END;

CREATE TRIGGER IF NOT EXISTS trg_task_dependencies_same_project_update
BEFORE UPDATE OF task_id, depends_on_task_id ON task_dependencies
WHEN (
  SELECT task.project_id <> upstream.project_id
  FROM tasks task, tasks upstream
  WHERE task.task_id = NEW.task_id AND upstream.task_id = NEW.depends_on_task_id
)
BEGIN
  SELECT RAISE(ABORT, '前置需求必须属于同一项目');
END;
