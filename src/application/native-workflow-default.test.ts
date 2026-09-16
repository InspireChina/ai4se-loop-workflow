import { createLegacyTaskInDb } from '../test/legacy-task-fixtures';
import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import { builtinWorkflow } from '../domain/builtin-workflow';
import { createTask, createTaskInDb, createTaskSchema, beginRun, endRun } from './tasks';
import { planDispatchInDb } from './dispatch-planner';
import { startAgentRun } from '../infrastructure/agent-runner';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { createScheduledRequirement, materializeDueScheduledRequirements } from './scheduled-requirements';

test('production task factory has no legacy creation branch even for an obsolete extra engine argument', async () => {
  const db = await databaseConnection();
  const value = createTaskSchema.parse({ title: 'Obsolete factory argument', itemType: 'direct' });
  const taskId = 'REQ-obsolete-factory-argument';
  db.transaction(() => Reflect.apply(createTaskInDb, undefined, [db, value, taskId, 'legacy']))();
  assert.equal((db.prepare('SELECT workflow_engine FROM tasks WHERE task_id = ?').get(taskId) as { workflow_engine: string }).workflow_engine, 'native');
  assert.deepEqual(db.prepare('SELECT origin, work_key FROM workflow_items WHERE task_id = ?').all(taskId),
    [{ origin: 'native', work_key: 'direct:execute' }]);
});

async function withoutEngineFlag<T>(action: () => Promise<T>) {
  const previous = process.env.LOOP_WORKFLOW_ENGINE;
  delete process.env.LOOP_WORKFLOW_ENGINE;
  try { return await action(); }
  finally {
    if (previous === undefined) delete process.env.LOOP_WORKFLOW_ENGINE;
    else process.env.LOOP_WORKFLOW_ENGINE = previous;
  }
}

for (const type of ['feature', 'bug', 'direct', 'business-analysis', 'end-to-end'] as const) {
  test(`public ${type} creation defaults to native without an opt-in and preserves frozen creation identity`, async () => withoutEngineFlag(async () => {
    const db = await databaseConnection();
    db.prepare('UPDATE tasks SET is_paused = 1').run();
    const taskId = await createTask({ title: `Default ${type}`, itemType: type });
    assert.equal((db.prepare('SELECT workflow_engine FROM tasks WHERE task_id = ?').get(taskId) as { workflow_engine: string }).workflow_engine, 'native');
    const graph = builtinWorkflow(type);
    const nodes = db.prepare('SELECT item_id, work_key, origin, status FROM workflow_items WHERE task_id = ? ORDER BY rowid')
      .all(taskId) as { item_id: string; work_key: string; origin: string; status: string }[];
    assert.deepEqual(nodes.map(node => node.work_key), graph.items.map(node => node.workKey));
    assert.ok(nodes.every(node => node.origin === 'native'));
    assert.deepEqual(nodes.map(node => node.status), ['ready', ...graph.items.slice(1).map(() => 'pending')]);
    const work = (await inspectTaskDispatchEnvelope(taskId))[0];
    assert.equal(work.workItemId, nodes[0].item_id);
    assert.equal(work.agent, graph.items[0].agent);
    assert.equal(db.prepare(`SELECT 1 FROM workflow_item_events event JOIN workflow_items item ON item.item_id = event.item_id
      WHERE item.task_id = ? AND event.event_type = 'adopt'`).get(taskId), undefined);
  }));
}

test('scheduled requirements use the default native factory for every supported pipeline, atomically and idempotently', async () => withoutEngineFlag(async () => {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused = 1').run();
  for (const type of ['feature', 'bug', 'direct', 'business-analysis', 'end-to-end'] as const) {
    const id = await createScheduledRequirement({ title: `Scheduled native ${type}`, pipeline: type,
      recurrenceKind: 'daily', timezone: 'Asia/Shanghai', localTime: '09:30', priority: '5' });
    db.prepare("UPDATE scheduled_requirement_plans SET next_trigger_at = '2026-08-10T01:30:00.000Z' WHERE plan_id = ?").run(id);
  }
  const first = await materializeDueScheduledRequirements(new Date('2026-08-13T10:00:00.000Z'));
  assert.equal(first.created.length, 5);
  for (const created of first.created) {
    const task = db.prepare('SELECT workflow_engine, item_type FROM tasks WHERE task_id = ?').get(created.taskId) as { workflow_engine: string; item_type: Parameters<typeof builtinWorkflow>[0] };
    assert.equal(task.workflow_engine, 'native');
    const nodes = db.prepare('SELECT work_key FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(created.taskId) as { work_key: string }[];
    assert.deepEqual(nodes.map(node => node.work_key), builtinWorkflow(task.item_type).items.map(node => node.workKey));
  }
  assert.equal((await materializeDueScheduledRequirements(new Date('2026-08-13T10:00:00.000Z'))).created.length, 0);
}));

test('default Runner start cannot bypass the fenced historical-upgrade boundary when native opt-in is absent', async () => withoutEngineFlag(async () => {
  const db = await databaseConnection();
  db.prepare('DELETE FROM loop_supervisor_lease').run();
  const runId = await beginRun('native-default-start-test');
  try {
    await assert.rejects(startAgentRun(runId, 42), /工作流迁移被拒绝/);
    process.env.LOOP_WORKFLOW_ENGINE = 'legacy';
    await assert.rejects(startAgentRun(runId, 42), /工作流迁移被拒绝/, 'obsolete compatibility flags cannot skip startup adoption');
    assert.equal(db.prepare("SELECT 1 FROM loop_managed_processes WHERE run_id = ? AND process_kind = 'agent-runner'").get(runId), undefined);
    assert.equal(db.prepare('SELECT 1 FROM workflow_upgrade_receipts WHERE run_id = ?').get(runId), undefined);
  } finally { await endRun(runId, false, { stopRunner: false }); }
}));

test('an obsolete legacy environment flag cannot change public creation or restore the cursor scheduler', async () => withoutEngineFlag(async () => {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused = 1').run();
  process.env.LOOP_WORKFLOW_ENGINE = 'legacy';
  const taskId = await createTask({ title: 'Legacy flag must be ignored', itemType: 'direct' });
  assert.equal((db.prepare('SELECT workflow_engine FROM tasks WHERE task_id = ?').get(taskId) as { workflow_engine: string }).workflow_engine, 'native');
  const history = db.transaction(() => createLegacyTaskInDb(db, createTaskSchema.parse({ title: 'Unadopted high-priority history', priority: '9' }),
    'REQ-ignored-legacy-flag-history'))();
  const selected = planDispatchInDb(db);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].taskId, taskId);
  assert.ok(selected[0].workItemId);
  assert.equal(selected.some(work => work.taskId === history.task_id), false);
}));

test('the default queue never falls back to old cursor/Lane dispatch, even beside a runnable native requirement', async () => withoutEngineFlag(async () => {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused = 1').run();
  const legacy = db.transaction(() => createLegacyTaskInDb(db, createTaskSchema.parse({ title: 'Awaiting startup adoption', priority: '9' }),
    'REQ-native-default-history'))();
  assert.deepEqual(planDispatchInDb(db), [], 'unadopted history must wait for startup migration');
  const nativeId = await createTask({ title: 'Native default neighbour', priority: '5' });
  const planned = planDispatchInDb(db);
  assert.equal(planned.length, 1);
  assert.equal(planned[0].taskId, nativeId);
  assert.ok(planned[0].workItemId);
  assert.equal((db.prepare('SELECT workflow_engine FROM tasks WHERE task_id = ?').get(legacy.task_id) as { workflow_engine: string }).workflow_engine, 'legacy');
}));
