import { databaseConnection, getConfiguredWorkspaceRoot } from '../infrastructure/database';

// An internal singleton key keeps Workflow state, resource locks and evidence
// relationships stable. It is not a selectable or configurable project.
export const CURRENT_WORKSPACE_ID = 'PRJ-default';
type Db = Awaited<ReturnType<typeof databaseConnection>>;
export type WorkspaceContext = {
  project_id: string;
  name: string;
  workspace_root: string;
  description: string | null;
  is_default: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export function workspaceContextInDb(db: Db): WorkspaceContext {
  const workspace = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(CURRENT_WORKSPACE_ID) as WorkspaceContext | undefined;
  if (!workspace || workspace.workspace_root !== getConfiguredWorkspaceRoot()) throw new Error('当前工作目录与状态目录不一致，请重启实例并使用对应的数据目录');
  return workspace;
}

export function resolveWorkspaceContextInDb(db: Db, id: string): WorkspaceContext | undefined {
  return id === CURRENT_WORKSPACE_ID ? workspaceContextInDb(db) : undefined;
}

export function taskWorkspaceRootInDb(db: Db, taskId: string) {
  const task = db.prepare('SELECT project_id FROM tasks WHERE task_id = ?').get(taskId) as { project_id: string } | undefined;
  if (!task) throw new Error(`需求不存在：${taskId}`);
  if (task.project_id !== CURRENT_WORKSPACE_ID) throw new Error('DJI 不支持其他工作目录的任务');
  return workspaceContextInDb(db).workspace_root;
}

export async function taskWorkspaceRoot(taskId: string) {
  return taskWorkspaceRootInDb(await databaseConnection(), taskId);
}
