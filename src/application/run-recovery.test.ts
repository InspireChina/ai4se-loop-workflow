import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import { reconcileInterruptedExecutions } from './executions';
import { createTask } from './tasks';
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
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE), undefined);
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE)?.owner_task_id, taskId);
  releaseResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, taskId);
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
