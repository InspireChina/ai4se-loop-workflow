import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseConnection, getConfiguredWorkspaceRoot } from '../infrastructure/database';
import { acquireResourceClaimInDb, CODE_WORKSPACE_RESOURCE, resourceClaimInDb } from './resource-claims';
import { createTask, getTask } from './tasks';
import { workspaceContextInDb, taskWorkspaceRoot } from './workspace-context';

test('all requirements share the startup working directory and project selection is rejected', async () => {
  const db = await databaseConnection();
  const context = workspaceContextInDb(db);
  const taskId = await createTask({ title: 'Single workspace requirement' });
  assert.equal(context.project_id, 'PRJ-default');
  assert.equal((await getTask(taskId))?.task.work_dir, getConfiguredWorkspaceRoot());
  assert.equal(await taskWorkspaceRoot(taskId), getConfiguredWorkspaceRoot());
  await assert.rejects(createTask({ title: 'Foreign workspace', projectId: 'other' }), /不支持选择项目/);
  assert.throws(() => db.prepare("INSERT INTO projects(project_id,name,workspace_root) VALUES('other','Other','/tmp/other')").run(), /唯一工作目录/);
  assert.throws(() => db.prepare('DELETE FROM projects').run(), /不支持删除/);
  assert.throws(() => db.prepare('UPDATE projects SET is_default=0').run(), /不支持/);
});

test('the single code workspace remains mutually exclusive across tasks', async () => {
  const db = await databaseConnection();
  const first = await createTask({ title: 'First developer' });
  const second = await createTask({ title: 'Competing developer' });
  assert.ok(acquireResourceClaimInDb(db, { resourceKey: CODE_WORKSPACE_RESOURCE, taskId: first, lane: 'delivery' }));
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, first)?.owner_task_id, first);
  assert.throws(() => acquireResourceClaimInDb(db, { resourceKey: CODE_WORKSPACE_RESOURCE, taskId: second, lane: 'delivery' }), /已被/);
});

test('saved project choices cannot override the startup directory or retarget task state', async () => {
  const { appDatabaseConnection } = await import('../infrastructure/database');
  const app = appDatabaseConnection();
  app.prepare("INSERT OR REPLACE INTO app_settings(setting_key,setting_value) VALUES('workspace_root','/tmp/stale-project-choice')").run();
  assert.equal(getConfiguredWorkspaceRoot(), process.env.LOOP_WORKSPACE_ROOT_OVERRIDE);
  const id = await createTask({ title: 'Startup workspace wins' });
  assert.equal((await getTask(id))?.task.work_dir, process.env.LOOP_WORKSPACE_ROOT_OVERRIDE);
});

test('a state directory with tasks cannot be rebound to a different startup workspace', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  await createTask({ title: 'Persisted workspace binding' });
  const other = realpathSync(mkdtempSync(join(process.env.LOOP_DATA_ROOT!, 'other-workspace-')));
  const result = execFileSync(process.execPath, ['--import','tsx','--input-type=module','-e',`
    process.env.LOOP_TEST_SETUP_PID=String(process.pid);
    const {databaseConnection}=await import('./src/infrastructure/database.ts');
    try { await databaseConnection(); process.exit(2); }
    catch(error) { if(!/数据目录已绑定/.test(error.message)) throw error; console.log('binding-protected'); }
  `], {cwd:process.cwd(),encoding:'utf8',env:{...process.env,LOOP_WORKSPACE_ROOT_OVERRIDE:other}});
  assert.match(result,/binding-protected/);
});
