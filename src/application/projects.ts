import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { databaseConnection, paths, setConfiguredWorkspaceRoot } from '../infrastructure/database';
import { normalizeWorkspaceRoot } from './project-settings';

type Db = Awaited<ReturnType<typeof databaseConnection>>;

export type Project = {
  project_id: string;
  name: string;
  workspace_root: string;
  description: string | null;
  is_default: number;
  deleted_at: string | null;
  requirement_count: number;
  active_requirement_count: number;
  active_execution_count: number;
  created_at: string;
  updated_at: string;
};

const projectInputSchema = z.object({
  name: z.string().trim().min(1, '请输入项目名称').max(100, '项目名称不能超过 100 个字符'),
  workspaceRoot: z.unknown(),
  description: z.string().trim().max(500, '项目说明不能超过 500 个字符').optional().nullable(),
});

function refreshProjectPages() {
  try {
    revalidatePath('/');
    revalidatePath('/tasks');
    revalidatePath('/schedules');
    revalidatePath('/runs');
    revalidatePath('/agents');
    revalidatePath('/settings');
  } catch { /* CLI usage has no request context. */ }
}

export function listProjectsInDb(db: Db): Project[] {
  return db.prepare(`
    SELECT project.project_id, project.name, project.workspace_root, project.description, project.is_default, project.deleted_at,
           project.created_at, project.updated_at,
           COUNT(task.task_id) AS requirement_count,
           SUM(CASE WHEN task.task_id IS NOT NULL AND task.agile_status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END) AS active_requirement_count,
           (
             SELECT COUNT(*) FROM execution_attempts execution
             JOIN tasks execution_task ON execution_task.task_id = execution.task_id
             WHERE execution_task.project_id = project.project_id
               AND execution.status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
           ) AS active_execution_count
    FROM projects project
    LEFT JOIN tasks task ON task.project_id = project.project_id
    WHERE project.deleted_at IS NULL
    GROUP BY project.project_id
    ORDER BY project.is_default DESC, project.created_at, project.name, project.project_id
  `).all() as Project[];
}

export async function listProjects() {
  return listProjectsInDb(await databaseConnection());
}

export function defaultProjectInDb(db: Db) {
  const project = db.prepare(`
    SELECT project_id, name, workspace_root, description, is_default, deleted_at, created_at, updated_at,
           0 AS requirement_count, 0 AS active_requirement_count, 0 AS active_execution_count
    FROM projects WHERE deleted_at IS NULL ORDER BY is_default DESC, created_at, project_id LIMIT 1
  `).get() as Project | undefined;
  if (!project) throw new Error('当前没有可用项目，请先在设置中创建项目');
  return project;
}

export function projectInDb(db: Db, projectId: string) {
  return db.prepare(`
    SELECT project_id, name, workspace_root, description, is_default, deleted_at, created_at, updated_at,
           0 AS requirement_count, 0 AS active_requirement_count, 0 AS active_execution_count
    FROM projects WHERE project_id = ? AND deleted_at IS NULL
  `).get(projectId) as Project | undefined;
}

export function taskProjectInDb(db: Db, taskId: string) {
  return db.prepare(`
    SELECT project.project_id, project.name, project.workspace_root, project.description, project.is_default, project.deleted_at,
           project.created_at, project.updated_at,
           0 AS requirement_count, 0 AS active_requirement_count, 0 AS active_execution_count
    FROM tasks task
    LEFT JOIN projects project ON project.project_id = task.project_id
    WHERE task.task_id = ?
  `).get(taskId) as Project | undefined;
}

export function taskWorkspaceRootInDb(db: Db, taskId: string) {
  const row = db.prepare(`
    SELECT COALESCE(project.workspace_root, NULLIF(task.work_dir, ''), ?) AS workspace_root
    FROM tasks task
    LEFT JOIN projects project ON project.project_id = task.project_id
    WHERE task.task_id = ?
  `).get(paths.root, taskId) as { workspace_root: string } | undefined;
  if (!row) throw new Error(`需求不存在：${taskId}`);
  return row.workspace_root;
}

export async function taskWorkspaceRoot(taskId: string) {
  return taskWorkspaceRootInDb(await databaseConnection(), taskId);
}

export async function createProject(input: unknown) {
  const value = projectInputSchema.parse(input);
  const workspaceRoot = normalizeWorkspaceRoot(value.workspaceRoot);
  const db = await databaseConnection();
  const projectId = db.transaction(() => {
    const duplicate = db.prepare('SELECT project_id, deleted_at FROM projects WHERE workspace_root = ?')
      .get(workspaceRoot) as { project_id: string; deleted_at: string | null } | undefined;
    if (duplicate && !duplicate.deleted_at) throw new Error('该工作目录已经添加为项目');
    if (duplicate) {
      db.prepare(`
        UPDATE projects
        SET name = ?, description = ?, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE project_id = ?
      `).run(value.name, value.description || null, duplicate.project_id);
      return duplicate.project_id;
    }
    const nextProjectId = `PRJ-${randomUUID()}`;
    db.prepare(`
      INSERT INTO projects(project_id, name, workspace_root, description)
      VALUES(?, ?, ?, ?)
    `).run(nextProjectId, value.name, workspaceRoot, value.description || null);
    return nextProjectId;
  }).immediate();
  refreshProjectPages();
  return projectId;
}

export async function updateProject(input: unknown) {
  const value = projectInputSchema.extend({ projectId: z.string().min(1) }).parse(input);
  const workspaceRoot = normalizeWorkspaceRoot(value.workspaceRoot);
  const db = await databaseConnection();
  const current = projectInDb(db, value.projectId);
  if (!current) throw new Error('项目不存在');
  if (current.workspace_root !== workspaceRoot) {
    const running = db.prepare(`
      SELECT 1 FROM execution_attempts execution
      JOIN tasks task ON task.task_id = execution.task_id
      WHERE task.project_id = ?
        AND execution.status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
      LIMIT 1
    `).get(value.projectId);
    if (running) throw new Error('该项目仍有 Agent 正在运行，暂时不能修改工作目录');
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE projects
      SET name = ?, workspace_root = ?, description = ?, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ?
    `).run(value.name, workspaceRoot, value.description || null, value.projectId);
    db.prepare('UPDATE tasks SET work_dir = ? WHERE project_id = ?').run(workspaceRoot, value.projectId);
  })();
  if (current.is_default) setConfiguredWorkspaceRoot(workspaceRoot);
  refreshProjectPages();
}

export async function setDefaultProject(projectIdInput: unknown) {
  const projectId = z.string().min(1).parse(projectIdInput);
  const db = await databaseConnection();
  if (!projectInDb(db, projectId)) throw new Error('项目不存在');
  db.transaction(() => {
    db.prepare('UPDATE projects SET is_default = 0 WHERE is_default = 1').run();
    db.prepare(`
      UPDATE projects
      SET is_default = 1, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ?
    `).run(projectId);
  })();
  const project = projectInDb(db, projectId);
  if (project) setConfiguredWorkspaceRoot(project.workspace_root);
  refreshProjectPages();
}

export async function deleteProject(projectIdInput: unknown) {
  const projectId = z.string().min(1).parse(projectIdInput);
  const db = await databaseConnection();
  const nextDefaultRoot = db.transaction(() => {
    const project = projectInDb(db, projectId);
    if (!project) return null;
    const replacement = db.prepare(`
      SELECT project_id, workspace_root
      FROM projects
      WHERE deleted_at IS NULL AND project_id != ?
      ORDER BY is_default DESC, created_at, project_id
      LIMIT 1
    `).get(projectId) as { project_id: string; workspace_root: string } | undefined;
    if (!replacement) throw new Error('至少需要保留一个项目');
    const running = db.prepare(`
      SELECT 1 FROM execution_attempts execution
      JOIN tasks task ON task.task_id = execution.task_id
      WHERE task.project_id = ?
        AND execution.status IN ('planned', 'running', 'output_received', 'verifying', 'applying')
      LIMIT 1
    `).get(projectId);
    if (running) throw new Error('该项目仍有 Agent 正在运行，请等待执行结束后再删除');
    db.prepare(`
      UPDATE projects
      SET is_default = 0, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = ? AND deleted_at IS NULL
    `).run(projectId);
    if (project.is_default) {
      db.prepare(`
        UPDATE projects SET is_default = 1, updated_at = CURRENT_TIMESTAMP
        WHERE project_id = ? AND deleted_at IS NULL
      `).run(replacement.project_id);
    }
    return project.is_default ? replacement.workspace_root : null;
  }).immediate();
  if (nextDefaultRoot) setConfiguredWorkspaceRoot(nextDefaultRoot);
  refreshProjectPages();
}
