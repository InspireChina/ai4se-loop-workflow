import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { createTaskInDb, createTaskSchema, getTask, pauseTask } from './tasks';
import { markExecutionOutput, type ExecutionAttempt } from './executions';
import { createExecutionCoordinator } from './execution-coordinator';

async function fixture() {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused = 1').run();
  const taskId = `REQ-${randomUUID()}`;
  createTaskInDb(db, createTaskSchema.parse({ title: 'Coordinator durable recovery', itemType: 'direct' }), taskId);
  const work = (await inspectTaskDispatchEnvelope(taskId))[0];
  const runId = `RUN-${randomUUID()}`;
  const { attempt } = await beginTestExecutionAttempt({ runId, delegation: work, prompt: 'Frozen original invocation' });
  await markExecutionOutput(attempt.execution_id, {
    outcome: 'completed', summary: 'Recovered original result',
    artifact: { title: 'Recovered document', content: '# Original result\n\nDurable evidence.' },
  });
  const read = () => db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(attempt.execution_id) as ExecutionAttempt & {
    work_item_revision: number; dispatch_retry_consumed: number;
  };
  let cyclesStarted = 0;
  let cyclesFinished = 0;
  const coordinator = createExecutionCoordinator({
    runId, isRunActive: async () => true,
    buildPrompt: async () => { throw new Error('Recovery must not rebuild a prompt'); },
    invoke: async () => { throw new Error('Recovery must not invoke a CLI'); },
    evaluate: async () => undefined,
    scheduleEvaluation: (evaluation) => { void evaluation; },
    controllers: new Map(),
    cycleStarted: async (source) => { cyclesStarted += 1; return { executionId: source.execution_id, eventFromId: null }; },
    cycleFinished: async () => { cyclesFinished += 1; },
  });
  return { db, taskId, work, coordinator, read, cycles: () => [cyclesStarted, cyclesFinished] };
}

test('recovers a saved result and applies it once without a Runner or another CLI invocation', async () => {
  const h = await fixture();
  const before = h.read();
  await h.coordinator.recover(before, h.work);
  const after = h.read();
  assert.equal(after.status, 'applied');
  for (const key of ['input_json', 'input_hash', 'result_json', 'attempt', 'work_item_revision'] as const) {
    assert.equal(after[key], before[key]);
  }
  const detail = await getTask(h.taskId);
  assert.equal(detail?.task.agile_status, 'done');
  assert.equal(detail?.documents.find((doc) => doc.kind === 'direct_result')?.content, '# Original result\n\nDurable evidence.');
  await h.coordinator.recover(before, h.work);
  assert.equal((h.db.prepare('SELECT COUNT(*) AS count FROM agent_results WHERE execution_id = ?').get(before.execution_id) as { count: number }).count, 1);
  assert.deepEqual(h.cycles(), [2, 2]);
});

test('paused recovery retains the result as evidence without applying business effects or charging a retry', async () => {
  const h = await fixture();
  const before = h.read();
  await pauseTask({ taskId: h.taskId, reason: 'User paused before recovery' });
  await h.coordinator.recover(h.read(), h.work);
  const after = h.read();
  assert.equal(after.status, 'applied', 'already saved output is settled as discarded evidence, not a failed invocation');
  assert.equal((h.db.prepare('SELECT effect_outcome FROM agent_results WHERE execution_id = ?').get(after.execution_id) as { effect_outcome: string }).effect_outcome, 'discarded');
  assert.equal(after.result_json, before.result_json);
  assert.equal(after.dispatch_retry_consumed, before.dispatch_retry_consumed, 'settling saved evidence does not charge another retry');
  const detail = await getTask(h.taskId);
  assert.equal(detail?.task.is_paused, 1);
  assert.notEqual(detail?.task.agile_status, 'done');
  assert.equal(detail?.documents.some((doc) => doc.kind === 'direct_result'), false);
  assert.deepEqual(h.cycles(), [1, 1]);
});
