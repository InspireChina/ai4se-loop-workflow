import { createLegacyTaskInDb } from '../test/legacy-task-fixtures';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { createTaskInDb, createTaskSchema } from './tasks';
import { projectRequirementWorkInDb } from './dispatch-planner';
import { progressDispatchInspector } from './progress-dispatch';
import { openInterventionInDb } from './interventions';

async function fixture(engine: 'legacy' | 'native') {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused = 1').run();
  const task = db.transaction(() => (engine === 'legacy' ? createLegacyTaskInDb : createTaskInDb)(db, createTaskSchema.parse({ title: 'Diagnostic fixture' }),
    `REQ-${randomUUID()}`))();
  return { db, taskId: task.task_id };
}

function snapshot(db: Awaited<ReturnType<typeof databaseConnection>>, taskId: string) {
  return {
    task: db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId),
    items: db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId),
    lanes: db.prepare('SELECT * FROM task_lanes WHERE task_id = ? ORDER BY lane').all(taskId),
    events: db.prepare(`SELECT event.* FROM workflow_item_events event JOIN workflow_items item
      ON item.item_id = event.item_id WHERE item.task_id = ? ORDER BY event.rowid`).all(taskId),
  };
}

for (const status of ['backlog', 'done', 'blocked']) {
  test(`production diagnostics never infer work or completion from unadopted ${status} cursors`, async () => {
    const { db, taskId } = await fixture('legacy');
    db.prepare('UPDATE tasks SET agile_status = ?, total_stories = 99, analysis_index = 99, dev_index = 99, test_index = 99 WHERE task_id = ?')
      .run(status, taskId);
    const before = snapshot(db, taskId);
    assert.deepEqual(projectRequirementWorkInDb(db, taskId), []);
    assert.deepEqual(await progressDispatchInspector.inspect({ requirementId: taskId }), {
      requirementId: taskId, decisions: [{ lane: 'control', state: 'waiting', reason: 'migration-required' }],
    });
    assert.deepEqual(snapshot(db, taskId), before, 'inspection must not adopt or rewrite historical workflow');
  });
}

test('native inspection selects the exact graph node despite stale completed cursors and blocked Lane badges, without writes', async () => {
  const { db, taskId } = await fixture('native');
  const item = db.prepare("SELECT item_id FROM workflow_items WHERE task_id = ? AND work_key = 'delivery:context'")
    .get(taskId) as { item_id: string };
  db.prepare("UPDATE tasks SET agile_status = 'done', total_stories = 99, analysis_index = 99, dev_index = 99, test_index = 99 WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE task_lanes SET status = 'system_blocked' WHERE task_id = ?").run(taskId);
  const before = snapshot(db, taskId);
  const explanation = await progressDispatchInspector.inspect({ requirementId: taskId });
  assert.ok(explanation.decisions.some(decision => decision.state === 'selected' && decision.workItemId === item.item_id));
  assert.deepEqual(snapshot(db, taskId), before, 'planner readiness/projection changes must roll back after inspection');
});

test('native inspection reports the actual item Intervention, not stale task or Lane completion', async () => {
  const { db, taskId } = await fixture('native');
  const item = db.prepare("SELECT item_id FROM workflow_items WHERE task_id = ? AND work_key = 'delivery:context'")
    .get(taskId) as { item_id: string };
  openInterventionInDb(db, { taskId, itemId: item.item_id, dedupeKey: 'diagnostic:hold',
    requestedBy: 'backlog-agent', summary: 'Need an actual input', resolverStrategy: 'human_only' });
  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE task_lanes SET status = 'completed' WHERE task_id = ?").run(taskId);
  const before = snapshot(db, taskId);
  const explanation = await progressDispatchInspector.inspect({ requirementId: taskId });
  assert.ok(explanation.decisions.some(decision => decision.workItemId === item.item_id
    && decision.state === 'waiting' && decision.reason === 'waiting-for-input'));
  assert.equal(explanation.decisions.some(decision => decision.state === 'selected'), false);
  assert.deepEqual(snapshot(db, taskId), before);
});
