import assert from 'node:assert/strict';
import test from 'node:test';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';

test('an expected CLI exit during a user stop preserves the retry budget and resume work', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { beginRun, createTask, endRun } = await import('./tasks');
  const { failExecutionWithRetryPolicy, reconcileInterruptedExecutions } = await import('./executions');
  const taskId = await createTask({ title: 'Stop without spending a failure attempt' });
  const runId = await beginRun('stop-boundary-test');
  const delegation = (await inspectTaskDispatch(taskId))[0];
  const { attempt } = await beginTestExecutionAttempt({ runId, delegation, prompt: 'Original task work' });
  const db = await databaseConnection();
  try {
    db.prepare("UPDATE loop_runs SET status='stopping',stop_requested_at=CURRENT_TIMESTAMP WHERE run_id=?").run(runId);
    assert.equal((await failExecutionWithRetryPolicy(attempt.execution_id, 'CLI exited during user stop', { kind:'agent-cli-exit',maxRetries:4 })).ignored, true);
    await reconcileInterruptedExecutions(runId, 'User stopped the loop', { countAsFailure:false });
    const row = db.prepare('SELECT status,attempt,retry_not_before,failure_kind FROM execution_attempts WHERE execution_id=?').get(attempt.execution_id) as {status:string;attempt:number;retry_not_before:string|null;failure_kind:string|null};
    assert.notEqual(row.status,'retryable_failed');
    assert.equal(row.attempt,attempt.attempt);
    assert.equal(row.retry_not_before,null);
    assert.equal(row.failure_kind,null);
  } finally {await endRun(runId,false,{stopRunner:false});}
});

test('a Runner stop retains a committed result for replay while an explicit task pause revokes this shortcut', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { beginRun, createTask, endRun } = await import('./tasks');
  const { markExecutionOutput, preserveSubmittedExecutionOnRunStop } = await import('./executions');
  const taskId = await createTask({ title: 'Preserve a formal submission on Runner stop', itemType:'direct' });
  const runId = await beginRun('stop-after-submission-test');
  const delegation = (await inspectTaskDispatch(taskId))[0];
  const { attempt } = await beginTestExecutionAttempt({ runId, delegation, prompt:'Run → Submit' });
  const db = await databaseConnection();
  const submitted = {outcome:'completed',summary:'Formal result already persisted'};
  try {
    assert.equal(await preserveSubmittedExecutionOnRunStop(attempt.execution_id),false);
    await markExecutionOutput(attempt.execution_id,submitted);
    assert.equal(await preserveSubmittedExecutionOnRunStop(attempt.execution_id),false, 'A running Loop must apply results normally');
    db.prepare("UPDATE loop_runs SET status='stopping' WHERE run_id=?").run(runId);
    assert.equal(await preserveSubmittedExecutionOnRunStop(attempt.execution_id),true);
    const row=db.prepare('SELECT status,result_json FROM execution_attempts WHERE execution_id=?').get(attempt.execution_id) as {status:string;result_json:string};
    assert.equal(row.status,'output_received');
    assert.deepEqual(JSON.parse(row.result_json),submitted);
    db.prepare('UPDATE tasks SET is_paused=1 WHERE task_id=?').run(taskId);
    assert.equal(await preserveSubmittedExecutionOnRunStop(attempt.execution_id),false);
  } finally {await endRun(runId,false,{stopRunner:false});}
});
