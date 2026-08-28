import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import { reconcileInterruptedExecutions, recordCleanExitContinuationActivity } from './executions';
import { createTask } from './tasks';
import { applyNextQueuedAgentResult } from './agent-results';
import {
  BROWSER_EXCLUSIVE_RESOURCE,
  CODE_WORKSPACE_RESOURCE,
  releaseResourceClaimInDb,
  resourceClaimInDb,
} from './resource-claims';

test('recovers interrupted executions by durable checkpoint instead of a lease', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Interrupted execution recovery' });
  const insertAttempt = db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, agent, pipeline, lane, delegation_key,
      attempt, status, input_hash, input_json, result_json
    ) VALUES(?, 'run-interrupted', ?, ?, ?, ?, ?, 1, ?, ?, '{}', ?)
  `);
  insertAttempt.run('execution-no-output', taskId, 'backlog-agent', 'backlog', 'control', 'key-no-output', 'running', 'hash-no-output', null);
  insertAttempt.run('execution-verifying', taskId, 'dev-agent', 'dev', 'delivery', 'key-verifying', 'verifying', 'hash-verifying', '{"outcome":"completed"}');
  insertAttempt.run('execution-queued-output', taskId, 'backlog-agent', 'backlog', 'control', 'key-queued-output', 'running', 'hash-queued-output', null);
  db.prepare(`
    INSERT INTO resource_claims(resource_key, owner_task_id, owner_lane, owner_execution_id)
    VALUES(?, ?, 'control', 'execution-no-output')
  `).run(BROWSER_EXCLUSIVE_RESOURCE, taskId);
  db.prepare(`
    INSERT INTO resource_claims(resource_key, owner_task_id, owner_lane, owner_execution_id)
    VALUES(?, ?, 'delivery', 'execution-verifying')
  `).run(CODE_WORKSPACE_RESOURCE, taskId);
  db.prepare(`
    INSERT INTO agent_results(
      result_id, run_id, task_id, agent, pipeline, outcome, result_json,
      application_status, execution_id
    ) VALUES('result-queued-output', 'run-interrupted', ?, 'backlog-agent', 'backlog',
      'completed', '{}', 'pending', 'execution-queued-output')
  `).run(taskId);

  const recovered = await reconcileInterruptedExecutions('run-interrupted', 'runner crashed');
  assert.deepEqual(recovered, {
    failedCount: 1,
    retryableCount: 1,
    blockedCount: 0,
    deferredCount: 0,
    cancelledReservationCount: 0,
    recoverableCount: 1,
    pendingResultCount: 1,
  });
  const statuses = db.prepare(`
    SELECT execution_id, status FROM execution_attempts
    WHERE run_id = 'run-interrupted' ORDER BY execution_id
  `).all() as { execution_id: string; status: string }[];
  assert.deepEqual(statuses, [
    { execution_id: 'execution-no-output', status: 'retryable_failed' },
    { execution_id: 'execution-queued-output', status: 'running' },
    { execution_id: 'execution-verifying', status: 'verifying' },
  ]);
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE), undefined);
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE)?.owner_task_id, taskId);
  const failureEvent = db.prepare(`
    SELECT event_type, summary FROM task_events
    WHERE task_id = ? AND event_type = 'AgentExecutionRetryScheduled'
    ORDER BY rowid DESC LIMIT 1
  `).get(taskId) as { event_type: string; summary: string };
  assert.match(failureEvent.summary, /runner-interrupted.*execution=execution-no-output：runner crashed/);
  releaseResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, taskId);
  db.prepare("UPDATE agent_results SET application_status = 'applied' WHERE result_id = 'result-queued-output'").run();
});

test('blocks an interrupted execution after four retries and records the exact error', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Interrupted execution retry limit' });
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, agent, pipeline, lane, delegation_key,
      attempt, status, input_hash, input_json
    ) VALUES('execution-interrupted-limit', 'run-interrupted-limit', ?, 'dev-agent', 'dev', 'delivery',
      'key-interrupted-limit', 5, 'running', 'hash-interrupted-limit', '{}')
  `).run(taskId);

  const recovered = await reconcileInterruptedExecutions('run-interrupted-limit', 'runner crashed after retries');

  assert.deepEqual(recovered, {
    failedCount: 1,
    retryableCount: 0,
    blockedCount: 1,
    deferredCount: 0,
    cancelledReservationCount: 0,
    recoverableCount: 0,
    pendingResultCount: 0,
  });
  assert.deepEqual(
    db.prepare("SELECT status, failure_kind, last_error FROM execution_attempts WHERE execution_id = 'execution-interrupted-limit'").get(),
    { status: 'system_blocked', failure_kind: 'runner-interrupted', last_error: 'runner crashed after retries' },
  );
  assert.equal(
    (db.prepare("SELECT status FROM task_lanes WHERE task_id = ? AND lane = 'delivery'").get(taskId) as { status: string }).status,
    'system_blocked',
  );
  const failureEvent = db.prepare(`
    SELECT event_type, summary FROM task_events
    WHERE task_id = ? AND event_type = 'AgentExecutionRetriesExhausted'
    ORDER BY rowid DESC LIMIT 1
  `).get(taskId) as { event_type: string; summary: string };
  assert.match(failureEvent.summary, /第 5 次失败，4 次自动重试已耗尽.*runner-interrupted.*runner crashed after retries/);
});

test('releases a cancelled requirement execution when its runner has already exited', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Cancelled execution recovery' });
  db.prepare("UPDATE tasks SET agile_status = 'cancelled', run_state = 'idle' WHERE task_id = ?").run(taskId);
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, agent, pipeline, lane, delegation_key,
      attempt, status, input_hash, input_json
    ) VALUES('execution-cancelled-run', 'run-cancelled', ?, 'dev-agent', 'dev', 'delivery',
      'key-cancelled-run', 1, 'running', 'hash-cancelled-run', '{}')
  `).run(taskId);

  const recovered = await reconcileInterruptedExecutions('run-cancelled', 'runner crashed');

  assert.deepEqual(recovered, {
    failedCount: 0,
    retryableCount: 0,
    blockedCount: 0,
    deferredCount: 0,
    cancelledReservationCount: 0,
    recoverableCount: 0,
    pendingResultCount: 0,
  });
  assert.equal(
    (db.prepare("SELECT status FROM execution_attempts WHERE execution_id = 'execution-cancelled-run'").get() as { status: string }).status,
    'cancelled',
  );
});

test('manual Loop stop defers a running execution without consuming a failure retry', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Manual Loop stop is not an execution failure' });
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, agent, pipeline, lane, delegation_key,
      dispatch_generation_key, dispatch_retry_consumed,
      attempt, status, input_hash, input_json
    ) VALUES('execution-manual-loop-stop', 'run-manual-loop-stop', ?, 'dev-agent', 'dev', 'delivery',
      'key-manual-loop-stop', 'generation-manual-loop-stop', 1,
      1, 'running', 'hash-manual-loop-stop', '{}')
  `).run(taskId);

  const recovered = await reconcileInterruptedExecutions(
    'run-manual-loop-stop',
    'Loop 已停止（用户停止），执行尚未返回结构化结果',
    { countAsFailure: false },
  );

  assert.deepEqual(recovered, {
    failedCount: 0,
    retryableCount: 0,
    blockedCount: 0,
    deferredCount: 1,
    cancelledReservationCount: 0,
    recoverableCount: 0,
    pendingResultCount: 0,
  });
  assert.deepEqual(
    db.prepare(`
      SELECT status, failure_kind, retry_not_before, dispatch_retry_consumed
      FROM execution_attempts WHERE execution_id = 'execution-manual-loop-stop'
    `).get(),
    { status: 'cancelled', failure_kind: null, retry_not_before: null, dispatch_retry_consumed: 0 },
  );
  assert.equal(
    (db.prepare(`
      SELECT COALESCE(MAX(attempt), 0) AS attempt
      FROM execution_attempts
      WHERE dispatch_generation_key = 'generation-manual-loop-stop'
        AND dispatch_retry_consumed = 1
    `).get() as { attempt: number }).attempt,
    0,
  );
  const events = db.prepare(`
    SELECT event_type, summary FROM task_events
    WHERE task_id = ? AND event_type IN ('AgentExecutionDeferredByLoopStop', 'AgentExecutionRetryScheduled')
    ORDER BY rowid
  `).all(taskId) as Array<{ event_type: string; summary: string }>;
  assert.deepEqual(events.map((event) => event.event_type), ['AgentExecutionDeferredByLoopStop']);
  assert.match(events[0].summary, /不消耗失败重试额度.*下次运行将重新派发/);
});

test('routes queued result application failures through the same retry policy and activity log', async () => {
  const db = await databaseConnection();
  const insertFailure = async (suffix: string, attempt: number) => {
    const taskId = await createTask({ title: `Queued result failure ${suffix}` });
    const executionId = `execution-queued-failure-${suffix}`;
    db.prepare(`
      INSERT INTO execution_attempts(
        execution_id, run_id, task_id, agent, pipeline, lane, delegation_key,
        attempt, status, input_hash, input_json, result_json
      ) VALUES(?, ?, ?, 'backlog-agent', 'backlog', 'control', ?, ?, 'output_received', ?, '{}', 'not-json')
    `).run(executionId, `run-queued-failure-${suffix}`, taskId, `key-queued-failure-${suffix}`, attempt, `hash-queued-failure-${suffix}`);
    db.prepare(`
      INSERT INTO agent_results(
        result_id, run_id, task_id, agent, pipeline, outcome, result_json,
        application_status, execution_id
      ) VALUES(?, ?, ?, 'backlog-agent', 'backlog', 'completed', 'not-json', 'pending', ?)
    `).run(`result-queued-failure-${suffix}`, `run-queued-failure-${suffix}`, taskId, executionId);
    return { taskId, executionId };
  };

  const retryable = await insertFailure('retryable', 1);
  const first = await applyNextQueuedAgentResult();
  assert.equal(first.status, 'failed');
  if (first.status === 'failed') assert.equal(first.willRetry, true);
  assert.deepEqual(
    db.prepare('SELECT status, failure_kind FROM execution_attempts WHERE execution_id = ?').get(retryable.executionId),
    { status: 'retryable_failed', failure_kind: 'agent-result-application' },
  );
  const retryEvent = db.prepare(`
    SELECT summary FROM task_events
    WHERE task_id = ? AND event_type = 'AgentExecutionRetryScheduled'
    ORDER BY rowid DESC LIMIT 1
  `).get(retryable.taskId) as { summary: string };
  assert.match(retryEvent.summary, /应用排队中的 Agent 结果失败.*JSON/);

  const exhausted = await insertFailure('exhausted', 5);
  const fifth = await applyNextQueuedAgentResult();
  assert.equal(fifth.status, 'failed');
  if (fifth.status === 'failed') assert.equal(fifth.willRetry, false);
  assert.deepEqual(
    db.prepare('SELECT status, failure_kind FROM execution_attempts WHERE execution_id = ?').get(exhausted.executionId),
    { status: 'system_blocked', failure_kind: 'agent-result-application' },
  );
  assert.equal(
    (db.prepare('SELECT run_state FROM tasks WHERE task_id = ?').get(exhausted.taskId) as { run_state: string }).run_state,
    'system_blocked',
  );
  const exhaustedEvent = db.prepare(`
    SELECT summary FROM task_events
    WHERE task_id = ? AND event_type = 'AgentExecutionRetriesExhausted'
    ORDER BY rowid DESC LIMIT 1
  `).get(exhausted.taskId) as { summary: string };
  assert.match(exhaustedEvent.summary, /第 5 次失败，4 次自动重试已耗尽.*应用排队中的 Agent 结果失败.*JSON/);
});

test('records clean-exit continuation phases in the requirement activity feed', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Terminal recovery activity' });
  const executionId = 'execution-terminal-recovery-activity';
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, agent, pipeline, lane, delegation_key,
      attempt, status, input_hash, input_json
    ) VALUES(?, 'run-terminal-recovery', ?, 'dev-agent', 'dev', 'delivery',
      'key-terminal-recovery', 1, 'running', 'hash-terminal-recovery', '{}')
  `).run(executionId, taskId);

  await recordCleanExitContinuationActivity(executionId, 'scheduled', 1);
  await recordCleanExitContinuationActivity(executionId, 'scheduled', 2);
  await recordCleanExitContinuationActivity(executionId, 'failed', 2, 'CLI 退出码 1');
  await recordCleanExitContinuationActivity(executionId, 'succeeded', 2);

  const events = db.prepare(`
    SELECT event_type, summary FROM task_events
    WHERE task_id = ? AND event_type LIKE 'AgentCleanExitContinuation%'
    ORDER BY rowid
  `).all(taskId) as Array<{ event_type: string; summary: string }>;
  assert.deepEqual(events.map((event) => event.event_type), [
    'AgentCleanExitContinuationScheduled',
    'AgentCleanExitContinuationScheduled',
    'AgentCleanExitContinuationFailed',
    'AgentCleanExitContinuationSucceeded',
  ]);
  assert.match(events[0].summary, /exit 0.*第 1 次.*不消耗失败重试额度/);
  assert.match(events[1].summary, /第 2 次/);
  assert.match(events[2].summary, /CLI 退出码 1/);
  assert.match(events[3].summary, /角色终止提交/);
});
