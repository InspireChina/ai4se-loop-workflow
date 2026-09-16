import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { createTask, type Task } from '../test/legacy-task-fixtures';
import { toEnvelope } from './dispatch-planner';
import { applyAgentResult } from './agent-results';
import { agentResultSchema } from '../domain/agent-result';
import { adoptNativeWorkflowInDb } from './work-item-transitions';
import { acquireResourceClaimsInDb, releaseResourceClaimInDb, resourceClaimInDb } from './resource-claims';

async function fixture() {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Historical execution adoption' });
  function insert(status: string, generation = 'historical-current', reservation?: string) {
    const id = randomUUID();
    db.prepare(`INSERT INTO execution_attempts(execution_id, run_id, task_id, agent, pipeline, lane,
      delegation_key, dispatch_generation_key, attempt, status, input_hash, input_json, result_json,
      dispatch_reservation_json, dispatch_retry_consumed)
      VALUES(?, 'RUN-historical', ?, 'backlog-agent', 'backlog', 'control', ?, ?, 1, ?, 'original-hash',
        '{"historicalInput":"unchanged"}', '{"historicalResult":"unchanged"}', ?, 0)`)
      .run(id, taskId, id, generation, status, reservation || null);
    return id;
  }
  return { db, taskId, insert };
}

for (const status of ['running', 'output_received', 'verifying', 'applying']) {
  test(`adoption binds historical ${status} execution and its current retry generation without modifying snapshots`, async () => {
    const { db, taskId, insert } = await fixture();
    const unrelated = insert('applied', 'old-generation');
    const failed = insert('retryable_failed');
    const live = insert(status);
    const source = db.prepare('SELECT input_hash, input_json, result_json, status FROM execution_attempts WHERE execution_id = ?').get(live);
    const unrelatedBefore = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(unrelated);
    const item = adoptNativeWorkflowInDb(db, taskId).find((row) => row.work_key === 'delivery:context')!;
    assert.equal(item.status, 'running');
    const rows = db.prepare('SELECT work_item_id, work_item_attempt, dispatch_generation_key, dispatch_retry_consumed FROM execution_attempts WHERE execution_id IN (?, ?) ORDER BY work_item_attempt')
      .all(failed, live) as { work_item_id: string; work_item_attempt: number; dispatch_generation_key: string; dispatch_retry_consumed: number }[];
    assert.deepEqual(rows.map((row) => row.work_item_id), [item.item_id, item.item_id]);
    assert.deepEqual(rows.map((row) => row.work_item_attempt), [1, 2]);
    assert.equal(rows[0].dispatch_generation_key, rows[1].dispatch_generation_key);
    assert.notEqual(rows[0].dispatch_generation_key, 'historical-current');
    assert.equal(rows[0].dispatch_retry_consumed, 1);
    assert.deepEqual(db.prepare('SELECT input_hash, input_json, result_json, status FROM execution_attempts WHERE execution_id = ?').get(live), source);
    assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(unrelated), unrelatedBefore);
    const before = db.prepare('SELECT * FROM workflow_item_events WHERE item_id = ? ORDER BY rowid').all(item.item_id);
    const executions = db.prepare('SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY rowid').all(taskId);
    adoptNativeWorkflowInDb(db, taskId);
    assert.deepEqual(db.prepare('SELECT * FROM workflow_item_events WHERE item_id = ? ORDER BY rowid').all(item.item_id), before);
    assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY rowid').all(taskId), executions);
  });
}

for (const status of ['retryable_failed', 'system_blocked']) test(`adoption settles historical ${status} even when old display metadata is idle`, async () => {
  const { db, taskId, insert } = await fixture();
  const id = insert(status);
  const item = adoptNativeWorkflowInDb(db, taskId).find((row) => row.work_key === 'delivery:context')!;
  assert.equal(item.status, status === 'system_blocked' ? 'waiting' : 'ready');
  assert.equal(item.dispatch_epoch, 1);
  assert.deepEqual(db.prepare('SELECT status, work_item_id, dispatch_retry_consumed FROM execution_attempts WHERE execution_id = ?').get(id),
    { status, work_item_id: item.item_id, dispatch_retry_consumed: 1 });
  assert.ok(db.prepare("SELECT 1 FROM workflow_item_events WHERE item_id = ? AND event_type = 'attempt_released'").get(item.item_id));
});

for (const acquired of [false, true]) test(`adoption cancels an unstarted old reservation and ${acquired ? 'releases acquired' : 'retains inherited'} code resources`, async () => {
  const { db, taskId, insert } = await fixture();
  const reservation = JSON.stringify({ resourceAcquisitions: { 'code:workspace': acquired ? 'acquired' : 'inherited' }, work: { taskId } });
  const id = insert('planned', 'old-planned', reservation);
  acquireResourceClaimsInDb(db, { resourceKeys: ['code:workspace'], taskId, lane: 'control', executionId: id });
  // Old reservation selection had marked its compatibility lane as running.
  db.prepare("UPDATE workflow_items SET status = 'running' WHERE task_id = ? AND work_key = 'delivery:context'").run(taskId);
  db.prepare("UPDATE task_lanes SET status = 'running', current_agent = 'backlog-agent' WHERE task_id = ?").run(taskId);
  try {
    const item = adoptNativeWorkflowInDb(db, taskId).find((row) => row.work_key === 'delivery:context')!;
    const execution = db.prepare('SELECT status, dispatch_retry_consumed, dispatch_reservation_json, work_item_id FROM execution_attempts WHERE execution_id = ?')
      .get(id) as { status: string; dispatch_retry_consumed: number; dispatch_reservation_json: string; work_item_id: string };
    assert.equal(execution.status, 'cancelled');
    assert.equal(execution.dispatch_retry_consumed, 0);
    assert.equal(execution.dispatch_reservation_json, reservation);
    assert.equal(execution.work_item_id, item.item_id);
    assert.equal(item.status, 'ready');
    assert.equal(Boolean(resourceClaimInDb(db, 'code:workspace', taskId)), !acquired);
  } finally { releaseResourceClaimInDb(db, 'code:workspace', taskId); }
});

test('ambiguous historical live ownership aborts adoption and rolls back all graph and binding edits', async () => {
  const { db, taskId, insert } = await fixture();
  insert('running');
  insert('applying');
  const before = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId);
  const executions = db.prepare('SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY rowid').all(taskId);
  assert.throws(() => adoptNativeWorkflowInDb(db, taskId), /多个历史活动执行/);
  assert.equal((db.prepare('SELECT workflow_engine FROM tasks WHERE task_id = ?').get(taskId) as { workflow_engine: string }).workflow_engine, 'legacy');
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId), before);
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY rowid').all(taskId), executions);
});

for (const applied of [false, true]) test(`a completed legacy cursor ${applied ? 'retains the already applied execution binding' : 'cannot invent a live execution completion'}`, async () => {
  const { db, taskId, insert } = await fixture();
  const id = insert('applying');
  db.prepare("UPDATE tasks SET agile_status = 'in plan', current_subagent = 'story-splitter-agent' WHERE task_id = ?").run(taskId);
  if (applied) db.prepare(`INSERT INTO agent_results(result_id, execution_id, run_id, task_id, agent, pipeline,
    outcome, result_json, application_status, effect_outcome)
    VALUES(?, ?, 'RUN-historical', ?, 'backlog-agent', 'backlog', 'completed', '{"outcome":"completed"}', 'applied', 'advanced')`)
    .run(randomUUID(), id, taskId);
  const source = db.prepare('SELECT input_hash, input_json, result_json, status FROM execution_attempts WHERE execution_id = ?').get(id);
  if (!applied) {
    assert.throws(() => adoptNativeWorkflowInDb(db, taskId), /没有成功应用收据/);
    assert.equal((db.prepare('SELECT workflow_engine FROM tasks WHERE task_id = ?').get(taskId) as { workflow_engine: string }).workflow_engine, 'legacy');
  } else {
    const item = adoptNativeWorkflowInDb(db, taskId).find((row) => row.work_key === 'delivery:context')!;
    assert.equal(item.status, 'completed');
    assert.equal((db.prepare('SELECT work_item_id FROM execution_attempts WHERE execution_id = ?').get(id) as { work_item_id: string }).work_item_id, item.item_id);
  }
  assert.deepEqual(db.prepare('SELECT input_hash, input_json, result_json, status FROM execution_attempts WHERE execution_id = ?').get(id), source);
});

for (const cancelled of [false, true]) test(`an unbound ${cancelled ? 'cancelled historical' : 'active native'} result cannot fall back to legacy cursor advancement`, async () => {
  const { db, taskId, insert } = await fixture();
  const id = insert('running');
  adoptNativeWorkflowInDb(db, taskId);
  db.prepare('UPDATE execution_attempts SET work_item_id = NULL, status = ? WHERE execution_id = ?').run(cancelled ? 'cancelled' : 'running', id);
  const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as Task;
  const delegation = toEnvelope(task, { taskId, agent: 'backlog-agent', pipeline: 'backlog', lane: 'control',
    storyIndex: null, resources: [], description: 'Old execution envelope without graph identity' });
  const before = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId);
  const documents = db.prepare('SELECT * FROM documents WHERE task_id = ? ORDER BY rowid').all(taskId);
  const result = agentResultSchema.parse({ outcome: 'completed', summary: 'Old unbound completion must not advance' });
  if (cancelled) assert.equal(await applyAgentResult('RUN-historical', delegation, result, { executionId: id }), 'discarded');
  else await assert.rejects(applyAgentResult('RUN-historical', delegation, result, { executionId: id }), /缺少有效的执行绑定/);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId), before);
  assert.deepEqual(db.prepare('SELECT * FROM documents WHERE task_id = ? ORDER BY rowid').all(taskId), documents);
  assert.equal((db.prepare('SELECT agile_status FROM tasks WHERE task_id = ?').get(taskId) as { agile_status: string }).agile_status, task.agile_status);
});
