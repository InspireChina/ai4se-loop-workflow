import type Database from 'better-sqlite3';
import { nativeCancellationInDb } from './work-item-controls';
import { requirementDeliveryReadyInDb } from './task-dependency-query';
import { projectNativeWorkflowDisplayInDb } from './native-workflow-projection';

export type RequirementDependency = {
  task_id: string;
  depends_on_task_id: string;
  title: string;
  agile_status: string;
  completed_at: string | null;
  delivery_ready: boolean;
};

export type RequirementDependencyCandidate = {
  task_id: string;
  project_id: string;
  title: string;
  agile_status: string;
  updated_at: string;
};

export { requirementDependencySatisfied, requirementDeliveryReadyInDb, requirementDependencyGateOpenInDb } from './task-dependency-query';

function requirementCancelledInDb(db: Database.Database, taskId: string) {
  const task = db.prepare('SELECT workflow_engine, agile_status FROM tasks WHERE task_id = ?').get(taskId) as
    { workflow_engine: string; agile_status: string } | undefined;
  return task?.workflow_engine === 'native' ? Boolean(nativeCancellationInDb(db, taskId)) : task?.agile_status === 'cancelled';
}

export function requirementDependenciesInDb(db: Database.Database, taskId: string) {
  return db.prepare(`
    SELECT dependency.task_id, dependency.depends_on_task_id,
           upstream.title, upstream.agile_status, upstream.completed_at
    FROM task_dependencies dependency
    JOIN tasks upstream ON upstream.task_id = dependency.depends_on_task_id
    WHERE dependency.task_id = ?
    ORDER BY dependency.created_at, upstream.title, upstream.task_id
  `).all(taskId).map(row => {
    const dependency = row as Omit<RequirementDependency, 'delivery_ready'>;
    projectNativeWorkflowDisplayInDb(db, dependency.depends_on_task_id);
    const display = db.prepare('SELECT agile_status, completed_at FROM tasks WHERE task_id = ?').get(dependency.depends_on_task_id) as
      Pick<RequirementDependency, 'agile_status' | 'completed_at'>;
    return { ...dependency, ...display, delivery_ready: requirementDeliveryReadyInDb(db, dependency.depends_on_task_id) };
  });
}

/**
 * Configure and validate the requirement dependency graph. Read-only first
 * admission and delivery proof queries live in task-dependency-query.
 */


export function configureRequirementDependenciesInDb(
  db: Database.Database,
  taskId: string,
  dependencyTaskIds: readonly string[],
) {
  return db.transaction(() => configureDependenciesInDb(db, taskId, dependencyTaskIds))();
}

function configureDependenciesInDb(db: Database.Database, taskId: string, dependencyTaskIds: readonly string[]) {
  const uniqueIds = [...new Set(dependencyTaskIds.map((item) => item.trim()).filter(Boolean))];
  if (uniqueIds.length > 50) throw new Error('一个需求最多配置 50 个前置需求');
  const insert = db.prepare(`
    INSERT INTO task_dependencies(task_id, depends_on_task_id) VALUES(?, ?)
  `);
  for (const dependencyTaskId of uniqueIds) {
    if (dependencyTaskId === taskId) throw new Error('需求不能依赖自身');
    const task = db.prepare('SELECT project_id FROM tasks WHERE task_id = ?')
      .get(taskId) as { project_id: string | null } | undefined;
    if (!task?.project_id) throw new Error(`需求没有绑定项目：${taskId}`);
    const upstream = db.prepare(`
      SELECT task_id, project_id, agile_status FROM tasks WHERE task_id = ?
    `).get(dependencyTaskId) as { task_id: string; project_id: string | null; agile_status: string } | undefined;
    if (!upstream) throw new Error(`前置需求不存在：${dependencyTaskId}`);
    if (upstream.project_id !== task.project_id) throw new Error(`前置需求必须属于同一项目：${dependencyTaskId}`);
    if (requirementCancelledInDb(db, dependencyTaskId)) throw new Error(`不能依赖已取消的需求：${dependencyTaskId}`);
    const createsCycle = db.prepare(`
      WITH RECURSIVE ancestors(task_id) AS (
        SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?
        UNION
        SELECT dependency.depends_on_task_id
        FROM task_dependencies dependency
        JOIN ancestors ON ancestors.task_id = dependency.task_id
      )
      SELECT 1 FROM ancestors WHERE task_id = ? LIMIT 1
    `).get(dependencyTaskId, taskId);
    if (createsCycle) throw new Error(`需求依赖不能形成环：${taskId} → ${dependencyTaskId}`);
    insert.run(taskId, dependencyTaskId);
  }
  return requirementDependenciesInDb(db, taskId);
}

export function requirementDependencyCandidatesInDb(db: Database.Database) {
  return db.prepare(`
    SELECT tasks.task_id, tasks.project_id, tasks.title, tasks.agile_status, tasks.updated_at
    FROM tasks
    JOIN projects ON projects.project_id = tasks.project_id
    WHERE projects.deleted_at IS NULL
    ORDER BY tasks.updated_at DESC, tasks.task_id DESC
  `).all().filter(row => {
    const candidate = row as RequirementDependencyCandidate;
    return !requirementCancelledInDb(db, candidate.task_id) && !requirementDeliveryReadyInDb(db, candidate.task_id);
  }).map(row => {
    const candidate = row as RequirementDependencyCandidate;
    projectNativeWorkflowDisplayInDb(db, candidate.task_id);
    const display = db.prepare('SELECT agile_status, updated_at FROM tasks WHERE task_id = ?').get(candidate.task_id) as
      Pick<RequirementDependencyCandidate, 'agile_status' | 'updated_at'>;
    return { ...candidate, ...display };
  });
}
