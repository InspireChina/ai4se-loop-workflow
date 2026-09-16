import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import { createProject } from './projects';
import { createTaskInDb, createTaskSchema } from './tasks';
import { createDispatchQuery } from './dispatch-query';
import { inspectDispatchInDb } from './dispatch-planner';
import { activeResourceClaimInDb, resourceIdentityInDb, resourceScopeInDb } from './resource-claims';
import { taskContextChatTurnIsRunning } from './task-context-chat';
import { agentConcurrencyInDb } from './project-settings';
import { requirementDependencyGateOpenInDb } from './task-dependencies';
import { readyWorkflowItemsForTaskInDb } from './work-items';
import { nativeWorkflowEndedInDb, workflowBlockedInDb } from './work-item-controls';
import { executionProcessBarrierInDb } from './execution-processes';
import { repairResourceClaimInDb } from './repair-resources';
import { agentCommandProfile } from '../domain/agent-command-profile-catalog';

async function fixture() {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused=1').run();
  const workspace = join(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE!, randomUUID());
  mkdirSync(workspace, { recursive: true });
  const projectId = await createProject({ name: 'Independent dispatch query', workspaceRoot: workspace });
  const taskIds = [0, 1, 2].map(() => `REQ-${randomUUID()}`);
  for (const [index, taskId] of taskIds.entries()) {
    createTaskInDb(db, createTaskSchema.parse({ title: `Query ${index}`, description: 'Preserve exact original dispatch source',
      itemType: index === 2 ? 'business-analysis' : 'direct', projectId }), taskId);
  }
  db.prepare('UPDATE tasks SET priority=? WHERE task_id=?').run('9', taskIds[0]);
  return { db, taskIds };
}

test('shared dispatch query preserves priority, project exclusivity, capacity, exact item source and resume selection without refresh', async () => {
  const { db, taskIds } = await fixture();
  let refreshed = false;
  const query = createDispatchQuery({
    activeResourceClaimInDb: (connection, resource, taskId, options) => {
      assert.equal(options?.releaseStale, false);
      return activeResourceClaimInDb(connection, resource, taskId, options);
    }, resourceIdentityInDb, resourceScopeInDb, taskContextChatTurnIsRunning,
    agentConcurrencyInDb: () => 2, requirementDependencyGateOpenInDb, readyWorkflowItemsForTaskInDb,
    nativeWorkflowEndedInDb, workflowBlockedInDb, executionProcessBarrierInDb, repairResourceClaimInDb,
    supportsResume: agent => Boolean(agentCommandProfile(agent, 'resume')),
    refreshWorkflowForDispatchInDb: () => { refreshed = true; throw new Error('inspection must not reconcile'); },
  });
  db.prepare("INSERT INTO project_settings(setting_key,setting_value) VALUES('agent_concurrency','2') ON CONFLICT(setting_key) DO UPDATE SET setting_value='2'").run();
  const initial = query.inspectDispatchInDb(db);
  assert.deepEqual(initial, inspectDispatchInDb(db));
  assert.equal(initial.length, 2);
  assert.ok(initial.some(line => line.taskId === taskIds[0]));
  assert.ok(initial.some(line => line.taskId === taskIds[2]));
  assert.ok(!initial.some(line => line.taskId === taskIds[1]), 'two code writers in the same project cannot both reserve dispatch');
  for (const line of initial) {
    const item = db.prepare('SELECT item_id,revision,dispatch_epoch FROM workflow_items WHERE item_id=?').get(line.workItemId!) as
      { item_id: string; revision: number; dispatch_epoch: number };
    assert.equal(line.workItemRevision, item.revision);
    assert.equal(line.workItemEpoch, item.dispatch_epoch);
  }
  db.prepare('UPDATE workflow_items SET resume_pending=1 WHERE task_id=?').run(taskIds[2]);
  assert.equal(query.inspectDispatchInDb(db).find(line => line.taskId === taskIds[2])!.pipeline, 'resume');
  db.prepare('UPDATE tasks SET is_paused=1 WHERE task_id=?').run(taskIds[0]);
  assert.ok(query.inspectDispatchInDb(db).some(line => line.taskId === taskIds[1]));
  assert.equal(refreshed, false);
});

test('independent compiled queue core runs against readonly SQLite with corrupt business/config bootstrap targets left untouched', async () => {
  const { db, taskIds } = await fixture();
  const bundled = await build({ entryPoints: [resolve('src/application/dispatch-query.ts')], bundle: true,
    platform: 'node', format: 'esm', write: false, metafile: true });
  const dependencies = Object.keys(bundled.metafile!.inputs);
  assert.deepEqual(dependencies.sort(), ['src/application/dispatch-query.ts', 'src/domain/requirement-priority.ts', 'src/domain/resource.ts']);
  const catalog = await build({ entryPoints: [resolve('src/domain/agent-command-profile-catalog.ts')], bundle: true,
    platform: 'node', format: 'esm', write: false, metafile: true });
  assert.deepEqual(Object.keys(catalog.metafile!.inputs), ['src/domain/agent-command-profile-catalog.ts']);
  const guardRoot = join(process.env.LOOP_DATA_ROOT!, randomUUID());
  mkdirSync(guardRoot, { recursive: true });
  const bootstrapBusiness = join(guardRoot, 'loop-ui.db'), bootstrapConfig = join(guardRoot, 'loopwork.db');
  writeFileSync(bootstrapBusiness, 'corrupt independent business bootstrap guard');
  writeFileSync(bootstrapConfig, 'corrupt independent configuration bootstrap guard');
  const before = [readFileSync(bootstrapBusiness), readFileSync(bootstrapConfig)];
  const code = `import Database from 'better-sqlite3';
${bundled.outputFiles![0].text}
${catalog.outputFiles![0].text}
const db = new Database(${JSON.stringify(db.name)}, { readonly: true, fileMustExist: true });
const query = createDispatchQuery({
 activeResourceClaimInDb: () => undefined,
 resourceScopeInDb: (db,key,id) => key === 'code:workspace' ? 'project:' + db.prepare('SELECT project_id FROM tasks WHERE task_id=?').get(id).project_id : 'global',
 resourceIdentityInDb: (db,key,id) => key + '@project:' + db.prepare('SELECT project_id FROM tasks WHERE task_id=?').get(id).project_id,
 taskContextChatTurnIsRunning: () => false, agentConcurrencyInDb: () => 2,
 requirementDependencyGateOpenInDb: () => true,
 readyWorkflowItemsForTaskInDb: (db,id) => db.prepare("SELECT * FROM workflow_items WHERE task_id=? AND status='ready' ORDER BY item_id").all(id),
 nativeWorkflowEndedInDb: () => false, workflowBlockedInDb: () => false,
 executionProcessBarrierInDb: () => undefined, repairResourceClaimInDb: () => undefined,
 supportsResume: agent => Boolean(agentCommandProfile(agent, 'resume')),
 refreshWorkflowForDispatchInDb: () => { throw new Error('readonly inspection invoked refresh'); }
});
if (!db.readonly) throw new Error('reader must remain readonly');
console.log(JSON.stringify(query.inspectDispatchInDb(db).map(line => ({taskId:line.taskId,itemId:line.workItemId,revision:line.workItemRevision,epoch:line.workItemEpoch}))));
db.close();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', code], { cwd: process.cwd(), timeout: 15000,
    env: { ...process.env, LOOP_DATA_ROOT: guardRoot, LOOP_GLOBAL_DB_PATH: bootstrapBusiness,
      LOOP_LEGACY_DB_PATH: bootstrapBusiness, LOOP_APP_ROOT: resolve('.'), NODE_TEST_CONTEXT: 'independent-query-guard' }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const selected = JSON.parse(child.stdout) as { taskId: string; itemId: string; revision: number; epoch: number }[];
  assert.equal(selected.length, 2);
  assert.ok(selected.some(line => line.taskId === taskIds[0]));
  assert.ok(selected.some(line => line.taskId === taskIds[2]));
  for (const line of selected) {
    assert.ok(line.itemId); assert.equal(line.revision, 1); assert.equal(line.epoch, 1);
  }
  assert.deepEqual([readFileSync(bootstrapBusiness), readFileSync(bootstrapConfig)], before);
  // The injected port values above are controlled fixture observations, not
  // production eligibility. This proves core import/use isolation only; Root
  // must still supply the full actual readonly dependency/resource adapter.
});
