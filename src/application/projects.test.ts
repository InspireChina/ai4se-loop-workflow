import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import { acquireResourceClaimInDb, CODE_WORKSPACE_RESOURCE, resourceClaimInDb } from './resource-claims';
import { inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import { createTask, getTask, listTasks } from './tasks';
import { createProject, deleteProject, listProjects, setDefaultProject, updateProject } from './projects';

test('soft deletes a project by workspace identity and restores all history when re-added', async () => {
  const originalDefault = (await listProjects()).find((project) => project.is_default);
  assert.ok(originalDefault);
  const projectRoot = join(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!, 'second-project');
  mkdirSync(projectRoot, { recursive: true });
  const projectId = await createProject({ name: '第二项目', workspaceRoot: projectRoot, description: '并行项目' });
  const taskId = await createTask({ title: '第二项目需求', itemType: 'feature', projectId });

  const detail = await getTask(taskId);
  assert.equal(detail?.task.project_id, projectId);
  assert.equal(detail?.task.project_name, '第二项目');
  assert.equal(detail?.task.work_dir, realpathSync(projectRoot));
  assert.deepEqual((await listTasks({ projectId })).map((task) => task.task_id), [taskId]);
  assert.equal((await listTasks({ projectId: 'missing-project' })).length, 0);

  await updateProject({ projectId, name: '第二项目（更新）', workspaceRoot: projectRoot, description: '' });
  assert.equal((await listProjects()).find((project) => project.project_id === projectId)?.name, '第二项目（更新）');

  await setDefaultProject(projectId);
  const projects = await listProjects();
  assert.equal(projects[0].project_id, projectId);
  assert.equal(projects.filter((project) => project.is_default).length, 1);
  const defaultTaskId = await createTask({ title: '使用默认项目', itemType: 'feature' });
  assert.equal((await getTask(defaultTaskId))?.task.project_id, projectId);

  await deleteProject(projectId);
  assert.equal((await listProjects()).some((project) => project.project_id === projectId), false);
  assert.deepEqual(await listTasks({ includeTerminal: true, projectId }), []);
  assert.deepEqual(await inspectTaskDispatch(taskId), []);
  assert.equal(await getTask(taskId), null);
  assert.equal(await getTask(defaultTaskId), null);
  assert.equal((await listProjects()).find((project) => project.is_default)?.project_id, originalDefault.project_id);
  const deleted = (await databaseConnection()).prepare('SELECT deleted_at FROM projects WHERE project_id = ?')
    .get(projectId) as { deleted_at: string | null };
  assert.ok(deleted.deleted_at);

  const restoredId = await createProject({ name: '第二项目（恢复）', workspaceRoot: projectRoot, description: '恢复历史' });
  assert.equal(restoredId, projectId);
  assert.equal((await listProjects()).find((project) => project.project_id === projectId)?.name, '第二项目（恢复）');
  assert.deepEqual(new Set((await listTasks({ includeTerminal: true, projectId })).map((task) => task.task_id)), new Set([taskId, defaultTaskId]));
  assert.equal((await getTask(taskId))?.task.project_id, projectId);
});

test('scopes the code workspace lock by project while keeping same-project exclusion', async () => {
  const db = await databaseConnection();
  const defaultProject = (await listProjects())[0];
  const projectRoot = join(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!, 'parallel-project');
  mkdirSync(projectRoot, { recursive: true });
  const secondProjectId = await createProject({ name: '并行项目', workspaceRoot: projectRoot });
  const firstTaskId = await createTask({ title: '默认项目开发', itemType: 'feature', projectId: defaultProject.project_id });
  const secondTaskId = await createTask({ title: '并行项目开发', itemType: 'feature', projectId: secondProjectId });
  const competingTaskId = await createTask({ title: '默认项目竞争开发', itemType: 'feature', projectId: defaultProject.project_id });

  assert.ok(acquireResourceClaimInDb(db, { resourceKey: CODE_WORKSPACE_RESOURCE, taskId: firstTaskId, lane: 'delivery' }));
  assert.ok(acquireResourceClaimInDb(db, { resourceKey: CODE_WORKSPACE_RESOURCE, taskId: secondTaskId, lane: 'delivery' }));
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, firstTaskId)?.owner_task_id, firstTaskId);
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, secondTaskId)?.owner_task_id, secondTaskId);
  assert.throws(
    () => acquireResourceClaimInDb(db, { resourceKey: CODE_WORKSPACE_RESOURCE, taskId: competingTaskId, lane: 'delivery' }),
    /已被/,
  );
});
