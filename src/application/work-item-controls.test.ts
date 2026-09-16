import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import { createTask, getTask, cancelTask, pauseTask, resumeTask } from '../test/legacy-task-fixtures';
import { adoptNativeWorkflowInDb, transitionWorkItemInDb, replaceUnstartedNativeWorkflowInDb } from './work-item-transitions';
import { nativeCancellationInDb, nativeWorkflowEndedInDb } from './work-item-controls';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { openIntervention, claimNextIntervention, cancelInterventionAttempt, interventionStatus } from './interventions';
import { executionCancellationRequested } from './executions';

async function fixture() {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Native cancellation control' });
  const items = adoptNativeWorkflowInDb(db, taskId);
  return { db, taskId, items };
}

test('native pause and resume follow real end facts rather than stale terminal labels', async () => {
  const { db, taskId } = await fixture();
  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id = ?").run(taskId);
  await pauseTask({ taskId });
  assert.equal((await getTask(taskId))?.task.is_paused, 1);
  db.prepare("UPDATE tasks SET agile_status = 'cancelled' WHERE task_id = ?").run(taskId);
  await resumeTask({ taskId });
  assert.equal((await getTask(taskId))?.task.is_paused, 0);
  await cancelTask({ taskId, reason: 'Actual human cancellation' });
  db.prepare("UPDATE tasks SET agile_status = 'backlog' WHERE task_id = ?").run(taskId);
  await assert.rejects(pauseTask({ taskId }), /已结束/);
  db.prepare('UPDATE tasks SET is_paused = 1 WHERE task_id = ?').run(taskId);
  await assert.rejects(resumeTask({ taskId }), /已结束/);
});

test('old terminal labels neither cancel native work nor block its actual graph transitions', async () => {
  const { db, taskId, items } = await fixture();
  const context = items.find((item) => item.work_key === 'delivery:context')!;
  db.prepare("UPDATE tasks SET agile_status = 'cancelled', current_subagent = NULL, run_state = 'idle' WHERE task_id = ?").run(taskId);
  assert.equal(nativeWorkflowEndedInDb(db, taskId), false);
  assert.equal((await inspectTaskDispatchEnvelope(taskId))[0]?.agent, 'backlog-agent');
  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id = ?").run(taskId);
  transitionWorkItemInDb(db, { itemId: context.item_id, action: 'complete', eventKey: 'fixture-context-complete',
    actor: 'human', authority: 'human', reason: 'Actual human fixture completion' });
  assert.equal((await inspectTaskDispatchEnvelope(taskId))[0]?.agent, 'story-splitter-agent');
  assert.equal(nativeCancellationInDb(db, taskId), null);
});

for (const cancelledAt of ['2003-03-03 03:03:03', null]) test(`adoption preserves explicit historical cancellation and its ${cancelledAt ? 'actual' : 'unknown'} date once`, async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Historical cancellation' });
  db.prepare(`UPDATE tasks SET agile_status = 'cancelled', next_step = 'Original human cancellation reason',
    completed_at = ?, last_actor = 'human' WHERE task_id = ?`).run(cancelledAt, taskId);
  // Model a late old reservation observed during the upgrade boundary.
  const executionId = `late-cancel-reservation-${taskId}`;
  db.prepare(`INSERT INTO execution_attempts(execution_id, run_id, task_id, agent, pipeline, delegation_key,
    attempt, status, input_hash, input_json) VALUES(?, 'RUN-late-reservation', ?, 'backlog-agent', 'backlog', ?,
      1, 'running', 'original-input', '{"originalContext":true}')`).run(executionId, taskId, executionId);
  adoptNativeWorkflowInDb(db, taskId);
  assert.deepEqual(nativeCancellationInDb(db, taskId), { reason: 'Original human cancellation reason', cancelledAt });
  assert.equal((await getTask(taskId))?.task.agile_status, 'cancelled');
  assert.equal((db.prepare('SELECT completed_at FROM tasks WHERE task_id = ?').get(taskId) as { completed_at: string | null }).completed_at, cancelledAt);
  const execution = db.prepare(`SELECT status, input_json, work_item_id, dispatch_retry_consumed FROM execution_attempts WHERE execution_id = ?`)
    .get(executionId) as { status: string; input_json: string; work_item_id: string; dispatch_retry_consumed: number };
  assert.equal(execution.status, 'cancelled');
  assert.equal(execution.dispatch_retry_consumed, 0);
  assert.ok(execution.work_item_id);
  assert.equal(execution.input_json, '{"originalContext":true}');
  const events = db.prepare('SELECT * FROM workflow_item_events WHERE item_id IN (SELECT item_id FROM workflow_items WHERE task_id = ?)').all(taskId);
  db.prepare("UPDATE tasks SET agile_status = 'backlog', completed_at = '2010-01-01 00:00:00' WHERE task_id = ?").run(taskId);
  assert.equal((await inspectTaskDispatchEnvelope(taskId)).length, 0);
  assert.equal((await getTask(taskId))?.task.agile_status, 'cancelled');
  adoptNativeWorkflowInDb(db, taskId);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_item_events WHERE item_id IN (SELECT item_id FROM workflow_items WHERE task_id = ?)').all(taskId), events);
});

test('native cancellation stops live execution without rewriting historical failures or relying on the display label', async () => {
  const { db, taskId } = await fixture();
  const delegation = (await inspectTaskDispatchEnvelope(taskId))[0];
  const pastId = `past-failure-${taskId}`;
  db.prepare(`INSERT INTO execution_attempts(execution_id, work_item_id, run_id, task_id, agent, pipeline, delegation_key,
    attempt, work_item_attempt, status, input_hash, input_json, result_json, last_error, failure_kind, dispatch_retry_consumed)
      VALUES(?, ?, 'RUN-past-failure', ?, 'backlog-agent', 'backlog', ?, 1, 1, 'retryable_failed', 'old-input', '{}',
      '{"originalFailure":true}', 'Original CLI failure', 'agent-cli-exit', 1)`)
    .run(pastId, delegation.workItemId, taskId, pastId);
  const started = await beginTestExecutionAttempt({ runId: 'RUN-native-cancel', delegation, prompt: 'Original active context' });
  const executionId = started.attempt.execution_id;
  db.prepare("UPDATE tasks SET agile_status = 'cancelled' WHERE task_id = ?").run(taskId);
  assert.equal(await executionCancellationRequested(executionId), false);
  const past = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(pastId);
  const originalInput = started.attempt.input_json;
  // Historical blocked display can still be cancelled by an explicit human.
  db.prepare("UPDATE tasks SET agile_status = 'blocked', resume_status = 'backlog' WHERE task_id = ?").run(taskId);
  await cancelTask({ taskId, reason: 'Human cancelled the actual workflow' });
  assert.equal((await getTask(taskId))?.task.agile_status, 'cancelled');
  assert.equal(await executionCancellationRequested(executionId), true);
  const cancellation = nativeCancellationInDb(db, taskId)!;
  assert.equal(cancellation.reason, 'Human cancelled the actual workflow');
  assert.ok(cancellation.cancelledAt);
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(pastId), past);
  const stopped = db.prepare('SELECT status, dispatch_retry_consumed, failure_kind, input_json FROM execution_attempts WHERE execution_id = ?')
    .get(executionId) as { status: string; dispatch_retry_consumed: number; failure_kind: null; input_json: string };
  assert.deepEqual(stopped, { status: 'cancelled', dispatch_retry_consumed: 0, failure_kind: null, input_json: originalInput });
  const events = db.prepare('SELECT * FROM workflow_item_events WHERE item_id IN (SELECT item_id FROM workflow_items WHERE task_id = ?)').all(taskId);
  db.prepare("UPDATE tasks SET agile_status = 'backlog', current_subagent = 'backlog-agent', run_state = 'runnable' WHERE task_id = ?").run(taskId);
  assert.equal((await inspectTaskDispatchEnvelope(taskId)).length, 0);
  assert.equal((await getTask(taskId))?.task.agile_status, 'cancelled');
  await cancelTask({ taskId, reason: 'Duplicate cancellation request' });
  assert.deepEqual(db.prepare('SELECT * FROM workflow_item_events WHERE item_id IN (SELECT item_id FROM workflow_items WHERE task_id = ?)').all(taskId), events);
});

test('cancelling an unstarted input plan does not cancel its replacement workflow', async () => {
  const { db, taskId } = await fixture();
  db.prepare("UPDATE tasks SET item_type = 'direct' WHERE task_id = ?").run(taskId);
  replaceUnstartedNativeWorkflowInDb(db, taskId);
  assert.equal(nativeCancellationInDb(db, taskId), null);
  assert.equal(nativeWorkflowEndedInDb(db, taskId), false);
  assert.equal((await inspectTaskDispatchEnvelope(taskId))[0]?.agent, 'direct-agent');
});

test('native cancellation ledger failure rolls back the partial graph, live execution and task metadata', async () => {
  const { db, taskId, items } = await fixture();
  const delegation = (await inspectTaskDispatchEnvelope(taskId))[0];
  const started = await beginTestExecutionAttempt({ runId: 'RUN-cancel-rollback', delegation, prompt: 'Unchanged context after rollback' });
  const plan = items.find((item) => item.work_key === 'delivery:plan')!;
  await getTask(taskId);
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId);
  const execution = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(started.attempt.execution_id);
  const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
  const resources = db.prepare('SELECT * FROM resource_claims WHERE owner_task_id = ?').all(taskId);
  db.exec(`CREATE TRIGGER reject_native_cancellation_ledger BEFORE INSERT ON workflow_item_events
    WHEN NEW.event_key = 'task:cancelled' AND NEW.item_id = '${plan.item_id}'
    BEGIN SELECT RAISE(ABORT, 'cancellation ledger rejected'); END`);
  try {
    await assert.rejects(cancelTask({ taskId, reason: 'Cancellation must be atomic' }),
      (error) => /cancellation ledger rejected/.test(String((error as { message: string }).message)));
    assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId), graph);
    assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(started.attempt.execution_id), execution);
    assert.deepEqual(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId), task);
    assert.deepEqual(db.prepare('SELECT * FROM resource_claims WHERE owner_task_id = ?').all(taskId), resources);
    assert.equal(nativeCancellationInDb(db, taskId), null);
  } finally { db.exec('DROP TRIGGER reject_native_cancellation_ledger'); }
});

test('system assistance uses native lifecycle facts rather than stale terminal labels', async () => {
  const { db, taskId, items } = await fixture();
  db.prepare("UPDATE tasks SET agile_status = 'cancelled' WHERE task_id = ?").run(taskId);
  const intervention = await openIntervention({ taskId, itemId: items.find((item) => item.work_key === 'delivery:context')!.item_id,
    dedupeKey: 'native-assistance-controls', summary: 'Actual unresolved work needs assistance', requestedBy: 'backlog-agent', authority: 'standard' });
  const claim = await claimNextIntervention({ runId: 'RUN-native-assistance-controls', executorId: 'claude', executionOptions: {} });
  assert.equal(claim?.interventionId, intervention.intervention_id);
  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id = ?").run(taskId);
  await cancelInterventionAttempt(intervention.intervention_id, 'Observed manual Loop stop, not a domain completion');
  assert.equal((await interventionStatus(intervention.intervention_id))?.status, 'pending');
  await cancelTask({ taskId, reason: 'Actual human workflow cancellation' });
  assert.equal((await interventionStatus(intervention.intervention_id))?.status, 'cancelled');
  db.prepare("UPDATE tasks SET agile_status = 'backlog' WHERE task_id = ?").run(taskId);
  await assert.rejects(openIntervention({ taskId, itemId: items[0].item_id, dedupeKey: 'cannot-reopen-cancelled-work',
    summary: 'A stale label cannot reopen cancelled work', requestedBy: 'system' }), /已结束/);
});
