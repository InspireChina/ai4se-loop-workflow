import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { createTaskInDb, createTaskSchema, beginRun, endRun, cancelTask } from './tasks';
import { planDispatchInDb } from './dispatch-planner';
import { progressDispatcher, progressDispatchInspector } from './progress-dispatch';
import { setAgentConcurrency } from './project-settings';
import { openInterventionInDb } from './interventions';

async function fixture() {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused = 1').run();
  await setAgentConcurrency(4);
  const task = db.transaction(() => createTaskInDb(db, createTaskSchema.parse({ title: randomUUID() }),
    `REQ-${randomUUID()}`))();
  const first = (db.prepare("SELECT item_id FROM workflow_items WHERE task_id = ? AND work_key = 'delivery:context'").get(task.task_id) as { item_id: string }).item_id;
  const add = (agent = 'backlog-agent', pipeline = 'backlog', lane = 'control') => {
    const id = randomUUID();
    // Deliberately independent domain-only nodes test graph/resource semantics,
    // not a claim that these synthetic nodes were executed by a real Agent.
    db.prepare(`INSERT INTO workflow_items(item_id,task_id,work_key,kind,title,agent,pipeline,lane,status,origin,ready_at)
      VALUES(?,?,?,'fixture','Independent work',?,?,?,'ready','native','2026-01-01')`)
      .run(id, task.task_id, `fixture:${id}`, agent, pipeline, lane);
    return id;
  };
  return { db, taskId: task.task_id, first, add };
}

test('native queue selects independent same-Lane work from the graph despite contradictory Lane badges', async () => {
  const { db, taskId, first, add } = await fixture();
  const second = add();
  db.prepare("UPDATE tasks SET agile_status = 'done', run_state = 'idle', current_subagent = 'review-agent' WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE task_lanes SET status = 'system_blocked', current_agent = 'test-agent' WHERE task_id = ?").run(taskId);
  assert.deepEqual(new Set(planDispatchInDb(db).filter(work => work.taskId === taskId).map(work => work.workItemId)), new Set([first, second]));
});

test('a real reservation occupies its exact item, not every independent item with the same Lane label', async () => {
  const { db, taskId, first, add } = await fixture();
  const second = add();
  db.prepare("UPDATE workflow_items SET ready_at = '2000-01-01' WHERE item_id = ?").run(first);
  await setAgentConcurrency(1);
  const runId = await beginRun('native-queue-fixture');
  try {
    const one = await progressDispatcher.reserveNext({ runId });
    assert.equal(one.kind, 'reserved');
    assert.equal(one.kind === 'reserved' && one.reservations.length, 1);
    assert.equal(one.kind === 'reserved' && one.reservations[0].work.workItemId, first);
    await setAgentConcurrency(2);
    const explanation = await progressDispatchInspector.inspect({ requirementId: taskId });
    assert.ok(explanation.decisions.some(decision => decision.state === 'active' && decision.workItemId === first));
    assert.ok(explanation.decisions.some(decision => decision.state === 'selected' && decision.workItemId === second));
    const two = await progressDispatcher.reserveNext({ runId });
    assert.equal(two.kind === 'reserved' && two.reservations.length, 1);
    assert.equal(two.kind === 'reserved' && two.reservations[0].work.workItemId, second);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM execution_attempts WHERE task_id = ? AND status = 'planned'").get(taskId) as { count: number }).count, 2);
  } finally { await cancelTask({ taskId, reason: 'Finish domain reservation test' }); await endRun(runId, false, { stopRunner: false }); }
});

test('changing native Lane labels cannot change the tie-break order of equally ready Work Items', async () => {
  const { db, taskId, first, add } = await fixture();
  const second = add();
  db.prepare("UPDATE workflow_items SET ready_at = '2000-01-01' WHERE item_id IN (?, ?)").run(first, second);
  const before = planDispatchInDb(db).filter(work => work.taskId === taskId).map(work => work.workItemId);
  db.prepare("UPDATE workflow_items SET lane = 'analysis' WHERE item_id = ?").run(first);
  db.prepare("UPDATE workflow_items SET lane = 'delivery' WHERE item_id = ?").run(second);
  assert.deepEqual(planDispatchInDb(db).filter(work => work.taskId === taskId).map(work => work.workItemId), before);
});

test('native queue orders by explicit priority and item readiness, never stale task stages or updated labels', async () => {
  const oldest = await fixture();
  const newest = await fixture();
  oldest.db.prepare('UPDATE tasks SET is_paused = 0 WHERE task_id = ?').run(oldest.taskId);
  oldest.db.prepare("UPDATE workflow_items SET ready_at = '2000-01-01' WHERE item_id = ?").run(oldest.first);
  oldest.db.prepare("UPDATE workflow_items SET ready_at = '2020-01-01' WHERE item_id = ?").run(newest.first);
  oldest.db.prepare("UPDATE tasks SET agile_status = 'blocked', updated_at = '2099-01-01' WHERE task_id = ?").run(newest.taskId);
  assert.equal(planDispatchInDb(oldest.db)[0].workItemId, oldest.first);
  oldest.db.prepare("UPDATE tasks SET priority = '9' WHERE task_id = ?").run(newest.taskId);
  assert.equal(planDispatchInDb(oldest.db)[0].workItemId, newest.first);
});

test('native resource selection cannot grant two independent work items the same code slot in one batch', async () => {
  const { db, taskId, first, add } = await fixture();
  db.prepare("UPDATE workflow_items SET status = 'pending' WHERE item_id = ?").run(first);
  const ids: string[] = [add('dev-agent', 'dev', 'delivery'), add('test-agent', 'test', 'delivery')];
  const selected = planDispatchInDb(db).filter(work => work.taskId === taskId && work.resources.includes('code:workspace'));
  assert.equal(selected.length, 1);
  assert.ok(ids.includes(selected[0].workItemId!));
  const runId = await beginRun('native-resource-fixture');
  try {
    const one = await progressDispatcher.reserveNext({ runId });
    assert.equal(one.kind === 'reserved' && one.reservations.filter(reservation => reservation.work.resources.includes('code:workspace')).length, 1);
    assert.equal(planDispatchInDb(db).filter(work => work.taskId === taskId).length, 0,
      'task-scoped ownership must not allow a second live writer/tester on the same workspace');
  } finally { await cancelTask({ taskId, reason: 'Finish resource test' }); await endRun(runId, false, { stopRunner: false }); }
});

test('native queue excludes a blocked item without turning its Lane into a global block', async () => {
  const { db, taskId, first, add } = await fixture();
  const second = add();
  openInterventionInDb(db, { taskId, itemId: first, requestedBy: 'backlog-agent', dedupeKey: 'fixture:independent-hold',
    summary: 'Only this work needs help', resolverStrategy: 'human_only' });
  assert.deepEqual(planDispatchInDb(db).filter(work => work.taskId === taskId).map(work => work.workItemId), [second]);
});

test('native queue cannot dispatch a graph-ready item while its exact source result is still pending application', async () => {
  const { db, taskId, first } = await fixture();
  const source = randomUUID();
  db.prepare(`INSERT INTO execution_attempts(execution_id,run_id,task_id,agent,pipeline,delegation_key,attempt,status,input_hash,input_json,work_item_id,work_item_attempt)
    VALUES(?,'RUN-pending-native',?,'backlog-agent','backlog',?,1,'retryable_failed','input','{}',?,1)`).run(source, taskId, randomUUID(), first);
  db.prepare(`INSERT INTO agent_results(result_id,run_id,task_id,agent,pipeline,outcome,result_json,application_status,execution_id)
    VALUES(?,'RUN-pending-native',?,'backlog-agent','backlog','completed','{}','pending',?)`).run(randomUUID(), taskId, source);
  assert.equal(planDispatchInDb(db).filter(work => work.taskId === taskId).length, 0);
});
