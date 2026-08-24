import type Database from 'better-sqlite3';

export type RequirementDependency = {
  task_id: string;
  depends_on_task_id: string;
  title: string;
  agile_status: string;
  completed_at: string | null;
};

export type RequirementDependencyCandidate = {
  task_id: string;
  title: string;
  agile_status: string;
  updated_at: string;
};

export function requirementDependenciesInDb(db: Database.Database, taskId: string) {
  return db.prepare(`
    SELECT dependency.task_id, dependency.depends_on_task_id,
           upstream.title, upstream.agile_status, upstream.completed_at
    FROM task_dependencies dependency
    JOIN tasks upstream ON upstream.task_id = dependency.depends_on_task_id
    WHERE dependency.task_id = ?
    ORDER BY dependency.created_at, upstream.title, upstream.task_id
  `).all(taskId) as RequirementDependency[];
}

/**
 * Dependencies gate only the first dispatch. Once an execution has been
 * reserved, later upstream feedback must not interrupt this requirement.
 */
export function requirementDependencyGateOpenInDb(db: Database.Database, taskId: string) {
  const started = db.prepare(`
    SELECT 1 FROM execution_attempts WHERE task_id = ? LIMIT 1
  `).get(taskId);
  if (started) return true;
  const unmet = db.prepare(`
    SELECT 1
    FROM task_dependencies dependency
    JOIN tasks upstream ON upstream.task_id = dependency.depends_on_task_id
    WHERE dependency.task_id = ? AND upstream.agile_status <> 'done'
    LIMIT 1
  `).get(taskId);
  return !unmet;
}

export function configureRequirementDependenciesInDb(
  db: Database.Database,
  taskId: string,
  dependencyTaskIds: readonly string[],
) {
  const uniqueIds = [...new Set(dependencyTaskIds.map((item) => item.trim()).filter(Boolean))];
  if (uniqueIds.length > 50) throw new Error('一个需求最多配置 50 个前置需求');
  const insert = db.prepare(`
    INSERT INTO task_dependencies(task_id, depends_on_task_id) VALUES(?, ?)
  `);
  for (const dependencyTaskId of uniqueIds) {
    if (dependencyTaskId === taskId) throw new Error('需求不能依赖自身');
    const upstream = db.prepare(`
      SELECT task_id, agile_status FROM tasks WHERE task_id = ?
    `).get(dependencyTaskId) as { task_id: string; agile_status: string } | undefined;
    if (!upstream) throw new Error(`前置需求不存在：${dependencyTaskId}`);
    if (upstream.agile_status === 'cancelled') throw new Error(`不能依赖已取消的需求：${dependencyTaskId}`);
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
    SELECT task_id, title, agile_status, updated_at
    FROM tasks
    WHERE agile_status NOT IN ('done', 'cancelled')
    ORDER BY updated_at DESC, task_id DESC
  `).all() as RequirementDependencyCandidate[];
}
