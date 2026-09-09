DROP TRIGGER IF EXISTS trg_tasks_project_default_insert;
DROP TRIGGER IF EXISTS trg_tasks_project_default_update;

CREATE TRIGGER trg_tasks_project_default_insert
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

CREATE TRIGGER trg_tasks_project_default_update
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
