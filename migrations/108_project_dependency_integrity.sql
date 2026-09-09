CREATE TRIGGER IF NOT EXISTS trg_tasks_dependency_project_update
BEFORE UPDATE OF project_id ON tasks
WHEN NEW.project_id IS NOT NULL AND EXISTS (
  SELECT 1
  FROM task_dependencies dependency
  JOIN tasks other ON other.task_id = CASE
    WHEN dependency.task_id = NEW.task_id THEN dependency.depends_on_task_id
    ELSE dependency.task_id
  END
  WHERE (dependency.task_id = NEW.task_id OR dependency.depends_on_task_id = NEW.task_id)
    AND other.project_id <> NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, '有依赖关系的需求必须属于同一项目');
END;
