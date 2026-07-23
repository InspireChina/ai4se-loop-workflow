import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import { reconcileInterruptedExecutions } from './executions';
import { beginRun, createTask, endRun, getRunStatus, heartbeatRun, registerRunProcess } from './tasks';

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
    INSERT INTO agent_results(
      result_id, run_id, task_id, agent, pipeline, outcome, result_json,
      application_status, execution_id
    ) VALUES('result-queued-output', 'run-interrupted', ?, 'backlog-agent', 'backlog',
      'completed', '{}', 'pending', 'execution-queued-output')
  `).run(taskId);

  const recovered = await reconcileInterruptedExecutions('run-interrupted', 'runner crashed');
  assert.deepEqual(recovered, { failedCount: 1, recoverableCount: 1, pendingResultCount: 1 });
  const statuses = db.prepare(`
    SELECT execution_id, status FROM execution_attempts
    WHERE run_id = 'run-interrupted' ORDER BY execution_id
  `).all() as { execution_id: string; status: string }[];
  assert.deepEqual(statuses, [
    { execution_id: 'execution-no-output', status: 'retryable_failed' },
    { execution_id: 'execution-queued-output', status: 'running' },
    { execution_id: 'execution-verifying', status: 'verifying' },
  ]);
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

  assert.deepEqual(recovered, { failedCount: 0, recoverableCount: 0, pendingResultCount: 0 });
  assert.equal(
    (db.prepare("SELECT status FROM execution_attempts WHERE execution_id = 'execution-cancelled-run'").get() as { status: string }).status,
    'cancelled',
  );
});

test('marks a dead previous run crashed before starting a new run', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Dead run replacement' });
  db.prepare(`
    INSERT INTO loop_runs(run_id, owner, status, runner_pid, started_at, heartbeat_at)
    VALUES('run-dead', 'agent-runner', 'running', 99999999, datetime('now', '-10 minutes'), datetime('now', '-10 minutes'))
  `).run();
  db.prepare(`
    INSERT INTO loop_meta(key, value) VALUES('active_run', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify({ runId: 'run-dead', owner: 'agent-runner', startedAt: new Date(Date.now() - 600_000).toISOString() }));
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, agent, pipeline, lane, delegation_key,
      attempt, status, input_hash, input_json
    ) VALUES('execution-dead-run', 'run-dead', ?, 'backlog-agent', 'backlog', 'control',
      'key-dead-run', 1, 'running', 'hash-dead-run', '{}')
  `).run(taskId);

  const nextRunId = await beginRun('agent-runner');
  const deadRun = db.prepare("SELECT status FROM loop_runs WHERE run_id = 'run-dead'").get() as { status: string };
  const attempt = db.prepare("SELECT status FROM execution_attempts WHERE execution_id = 'execution-dead-run'").get() as { status: string };
  assert.equal(deadRun.status, 'crashed');
  assert.equal(attempt.status, 'retryable_failed');
  assert.equal((await getRunStatus())?.runId, nextRunId);

  await registerRunProcess(nextRunId, 'agent-runner', process.pid);
  await heartbeatRun(nextRunId, 'agent-runner');
  assert.equal((await getRunStatus())?.active, true);
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, agent, pipeline, lane, delegation_key,
      attempt, status, input_hash, input_json
    ) VALUES('execution-stopped-run', ?, ?, 'backlog-agent', 'backlog', 'control',
      'key-stopped-run', 1, 'running', 'hash-stopped-run', '{}')
  `).run(nextRunId, taskId);
  await endRun(nextRunId, false, { stopRunner: false });
  assert.equal(await getRunStatus(), null);
  assert.equal((db.prepare("SELECT status FROM execution_attempts WHERE execution_id = 'execution-stopped-run'").get() as { status: string }).status, 'retryable_failed');
});

test('refreshes heartbeat without replacing the detached runner process leader', async () => {
  const db = await databaseConnection();
  const runId = await beginRun('agent-runner');
  const processLeaderPid = process.ppid;
  await registerRunProcess(runId, 'agent-runner', processLeaderPid);
  db.prepare("UPDATE loop_runs SET heartbeat_at = datetime('now', '-10 minutes') WHERE run_id = ?").run(runId);

  await heartbeatRun(runId, 'agent-runner');

  const persisted = db.prepare(`
    SELECT runner_pid, process_kind, heartbeat_at
    FROM loop_runs
    WHERE run_id = ?
  `).get(runId) as { runner_pid: number; process_kind: string; heartbeat_at: string };
  assert.equal(persisted.runner_pid, processLeaderPid);
  assert.equal(persisted.process_kind, 'agent-runner');
  assert.ok(Date.now() - new Date(`${persisted.heartbeat_at.replace(' ', 'T')}Z`).getTime() < 5_000);
  assert.equal((await getRunStatus())?.active, true);

  await endRun(runId, false, { stopRunner: false });
});
