import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { beginRun, createTaskInDb, createTaskSchema, endRun, pauseTask } from './tasks';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { cancelExecution, executionCancellationReason, executionCancellationRequested, failExecutionWithRetryPolicy, reconcileInterruptedExecutions } from './executions';
import { claimNextIntervention, finishInterventionAttempt, openIntervention } from './interventions';
import { acquireResourceClaimInDb, activeResourceClaimInDb } from './resource-claims';

async function source(actualRun = false) {
  const db = await databaseConnection();
  const taskId = `REQ-${randomUUID()}`;
  db.transaction(() => createTaskInDb(db, createTaskSchema.parse({ title: 'Native cancellation provenance', itemType: 'direct' }), taskId))();
  const runId = actualRun ? await beginRun('Native cancellation ordering fixture') : `RUN-${randomUUID()}`;
  const work = (await inspectTaskDispatchEnvelope(taskId))[0];
  const started = await beginTestExecutionAttempt({ runId, delegation: work, prompt: 'Domain cancellation source fixture' });
  const executionId = started.attempt.execution_id;
  const read = () => db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId);
  return { db, taskId, runId, executionId, read };
}

test('manual Loop stop preserves cancellation provenance and does not turn late CLI exit into a task error', async () => {
  const { db, taskId, runId, executionId, read } = await source();
  const other = await source();
  acquireResourceClaimInDb(db, { resourceKey: 'code:workspace', taskId, lane: 'control', executionId });
  acquireResourceClaimInDb(db, { resourceKey: 'browser:exclusive', taskId: other.taskId, lane: 'control', executionId: other.executionId });
  const otherClaims = db.prepare('SELECT * FROM resource_claims WHERE owner_execution_id = ?').all(other.executionId);
  const before = read() as { input_json: string; input_hash: string; attempt: number; work_item_attempt: number };
  const reason = '用户手动结束本轮 Loop';
  await reconcileInterruptedExecutions(runId, reason, { countAsFailure: false });
  const stopped = read() as typeof before & { status: string; dispatch_retry_consumed: number; failure_kind: string | null };
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.dispatch_retry_consumed, 0);
  assert.equal(stopped.failure_kind, null);
  assert.equal(db.prepare('SELECT 1 FROM resource_claims WHERE owner_execution_id = ?').get(executionId), undefined);
  assert.deepEqual(db.prepare('SELECT * FROM resource_claims WHERE owner_execution_id = ?').all(other.executionId), otherClaims);
  for (const key of ['input_json','input_hash','attempt','work_item_attempt'] as const) assert.equal(stopped[key], before[key]);
  assert.equal(await executionCancellationReason(executionId), reason);
  const lateFailure = await failExecutionWithRetryPolicy(executionId, 'CLI killed during the requested stop', { kind: 'agent-cli-exit', maxRetries: 4 });
  assert.equal(lateFailure.ignored, true);
  await cancelExecution(executionId, 'Late generic CLI cancellation must not overwrite provenance');
  assert.deepEqual(read(), stopped);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM task_events WHERE summary LIKE ? AND event_type IN ('AgentExecutionRetryScheduled','AgentExecutionRetriesExhausted')").get(`%${executionId}%`) as { count: number }).count, 0);
});

test('late cancellation releases a cancelled code owner but preserves an applied source handoff', async () => {
  const { db, taskId, executionId, read } = await source();
  acquireResourceClaimInDb(db, { resourceKey: 'code:workspace', taskId, lane: 'control', executionId });
  // Domain boundary fixture: a completed source still owns a handoff claim.
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE execution_id = ?").run(executionId);
  const applied = read();
  const claim = db.prepare('SELECT * FROM resource_claims WHERE owner_execution_id = ?').get(executionId);
  await cancelExecution(executionId, 'Late callback cannot cancel applied work');
  assert.deepEqual(read(), applied);
  assert.deepEqual(db.prepare('SELECT * FROM resource_claims WHERE owner_execution_id = ?').get(executionId), claim);
  assert.deepEqual(activeResourceClaimInDb(db, 'code:workspace', taskId, { releaseStale: false }), claim);
  db.prepare("UPDATE execution_attempts SET status = 'cancelled', last_error = 'Actual domain cancellation' WHERE execution_id = ?").run(executionId);
  const cancelled = read();
  assert.equal(activeResourceClaimInDb(db, 'code:workspace', taskId, { releaseStale: false }), undefined);
  assert.deepEqual(db.prepare('SELECT * FROM resource_claims WHERE owner_execution_id = ?').get(executionId), claim);
  assert.equal(activeResourceClaimInDb(db, 'code:workspace', taskId), undefined);
  assert.equal(db.prepare('SELECT 1 FROM resource_claims WHERE owner_execution_id = ?').get(executionId), undefined);
  // Model a historical stale claim surviving to a late callback.
  acquireResourceClaimInDb(db, { resourceKey: 'code:workspace', taskId, lane: 'control', executionId });
  await cancelExecution(executionId, 'Late callback must preserve the cancellation reason');
  assert.deepEqual(read(), cancelled);
  assert.equal(db.prepare('SELECT 1 FROM resource_claims WHERE owner_execution_id = ?').get(executionId), undefined);
});

test('pause cancellation keeps the actual pause reason after a late CLI callback', async () => {
  const { taskId, executionId, read } = await source();
  await pauseTask({ taskId, reason: '用户暂停需求检查证据' });
  const paused = read();
  assert.match(await executionCancellationReason(executionId), /暂停/);
  await cancelExecution(executionId, await executionCancellationReason(executionId));
  assert.deepEqual(read(), paused);
});

test('late cancellation cannot erase an already observed execution failure or consume another retry', async () => {
  const { executionId, read } = await source();
  await failExecutionWithRetryPolicy(executionId, 'Original runtime context overflow', { kind: 'agent-cli-exit', maxRetries: 4 });
  const failed = read();
  await cancelExecution(executionId, 'Loop subsequently stopped');
  assert.deepEqual(read(), failed);
});

test('only the actual system resolver may run through its own task hold and legacy done labels cannot cancel it', async () => {
  const { db, taskId, executionId, runId } = await source();
  const opened = await openIntervention({ taskId, itemId: null, requestedBy: 'system', dedupeKey: 'fixture:task-global-hold',
    summary: 'Recover the task-wide external failure', resolverStrategy: 'system_then_human' });
  const resolver = await claimNextIntervention({ runId, executorId: 'claude', executionOptions: {} });
  assert.equal(resolver?.interventionId, opened.intervention_id);
  db.prepare("UPDATE tasks SET agile_status = 'done', current_subagent = NULL WHERE task_id = ?").run(taskId);
  assert.equal(await executionCancellationRequested(executionId), true);
  assert.equal(await executionCancellationRequested(executionId, { resolvingInterventionId: opened.intervention_id }), true);
  assert.equal(await executionCancellationRequested(resolver!.executionId), true);
  assert.equal(await executionCancellationRequested(resolver!.executionId, { resolvingInterventionId: opened.intervention_id }), false);
  await pauseTask({ taskId });
  assert.equal(await executionCancellationRequested(resolver!.executionId, { resolvingInterventionId: opened.intervention_id }), true);
});

test('normal endRun fences running sources before entering process termination and late failure is ignored', async () => {
  const { db, runId, executionId } = await source(true);
  db.exec(`CREATE TRIGGER verify_stop_fence BEFORE UPDATE OF status ON loop_runs
    WHEN NEW.status = 'stopping' AND EXISTS (SELECT 1 FROM execution_attempts source
      WHERE source.run_id = NEW.run_id AND source.status = 'running' AND source.result_json IS NULL)
    BEGIN SELECT RAISE(ABORT, 'Cancellation must precede process termination'); END;`);
  try {
    await endRun(runId, false, { reason: '用户停止' });
    assert.equal((db.prepare('SELECT status FROM loop_runs WHERE run_id = ?').get(runId) as { status: string }).status, 'stopped');
    assert.equal((db.prepare('SELECT status FROM execution_attempts WHERE execution_id = ?').get(executionId) as { status: string }).status, 'cancelled');
    assert.equal((await failExecutionWithRetryPolicy(executionId, 'Late SIGTERM', { kind: 'agent-cli-exit', maxRetries: 4 })).ignored, true);
  } finally { db.exec('DROP TRIGGER verify_stop_fence'); }
});

test('late auxiliary failure after a normal Loop stop cancels its attempt without consuming system recovery credit', async () => {
  const { db, taskId, runId } = await source();
  const opened = await openIntervention({ taskId, itemId: null, requestedBy: 'system', dedupeKey: 'fixture:auxiliary-stop-race',
    summary: 'Inspect the external runtime', resolverStrategy: 'system_then_human' });
  const resolver = await claimNextIntervention({ runId, executorId: 'claude', executionOptions: {} });
  assert.equal(resolver?.interventionId, opened.intervention_id);
  await reconcileInterruptedExecutions(runId, '用户正常停止本轮 Loop', { countAsFailure: false });
  const cancelledSource = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(resolver!.executionId);
  assert.equal((await finishInterventionAttempt({ interventionId: opened.intervention_id, reason: 'Late SIGTERM exit 1', outcome: 'failed' })).ignored, true);
  assert.equal((db.prepare('SELECT status FROM intervention_attempts WHERE execution_id = ?').get(resolver!.executionId) as { status: string }).status, 'cancelled');
  assert.equal((db.prepare('SELECT status FROM interventions WHERE intervention_id = ?').get(opened.intervention_id) as { status: string }).status, 'pending');
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(resolver!.executionId), cancelledSource);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM intervention_attempts WHERE intervention_id = ? AND status IN ('failed','deferred')").get(opened.intervention_id) as { count: number }).count, 0);
});

test('normal stop cancellation and reservation fence roll back together if the durable run fence cannot be written', async () => {
  const { db, runId, read } = await source(true);
  const before = read();
  const beforeRun = db.prepare('SELECT * FROM loop_runs WHERE run_id = ?').get(runId);
  db.exec("CREATE TRIGGER reject_stop_fence BEFORE UPDATE OF status ON loop_runs WHEN NEW.status = 'stopping' BEGIN SELECT RAISE(ABORT, 'Injected durable stop fence failure'); END;");
  try {
    await assert.rejects(endRun(runId, false, { reason: '用户停止' }), /Injected durable stop fence failure/);
    assert.deepEqual(read(), before);
    assert.deepEqual(db.prepare('SELECT * FROM loop_runs WHERE run_id = ?').get(runId), beforeRun);
  } finally {
    db.exec('DROP TRIGGER reject_stop_fence');
    await endRun(runId, false, { stopRunner: false });
  }
});
