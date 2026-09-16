import type Database from 'better-sqlite3';
import type { RequirementDependency } from './task-dependencies';
import { nativeDeliveryReadyInDb } from './work-item-controls';

export function requirementDependencySatisfied(value: string | Pick<RequirementDependency, 'delivery_ready'>) {
  return typeof value === 'string' ? value === 'ready_to_close' || value === 'done' : value.delivery_ready;
}

export function requirementDeliveryReadyInDb(db: Database.Database, taskId: string) {
  const task = db.prepare('SELECT workflow_engine, agile_status FROM tasks WHERE task_id = ?').get(taskId) as
    { workflow_engine: string; agile_status: string } | undefined;
  return task?.workflow_engine === 'native' ? nativeDeliveryReadyInDb(db, taskId)
    : Boolean(task && requirementDependencySatisfied(task.agile_status));
}


/** First admission waits for actual upstream delivery readiness, not a task label. */
export function requirementDependencyGateOpenInDb(db: Database.Database, taskId: string) {
  const started = db.prepare(`
    SELECT 1 FROM execution_attempts WHERE task_id = ? LIMIT 1
  `).get(taskId);
  if (started) return true;
  const dependencies = db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?')
    .all(taskId) as { depends_on_task_id: string }[];
  return dependencies.every(dependency => requirementDeliveryReadyInDb(db, dependency.depends_on_task_id));
}
