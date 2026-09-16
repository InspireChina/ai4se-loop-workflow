import { createLegacyTaskInDb } from '../test/legacy-task-fixtures';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { createTaskInDb, createTaskSchema } from './tasks';
import type { DelegationEnvelope } from './tasks';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { markExecutionOutput, type ExecutionAttempt } from './executions';
import { adoptNativeWorkflowInDb } from './work-item-transitions';
import { restoreExecutionDelegationInDb } from './execution-delegation';
import { progressDispatcher } from './progress-dispatch';

async function fixture(engine: 'native' | 'legacy' = 'native') {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused = 1').run();
  const task = db.transaction(() => (engine === 'legacy' ? createLegacyTaskInDb : createTaskInDb)(db, createTaskSchema.parse({ title: 'Frozen source recovery', itemType: 'direct' }),
    `REQ-${randomUUID()}`))();
  const work = (await inspectTaskDispatchEnvelope(task.task_id))[0];
  const { attempt } = await beginTestExecutionAttempt({ runId: `RUN-${randomUUID()}`, delegation: work, prompt: 'Domain fixture, not a real CLI run' });
  await markExecutionOutput(attempt.execution_id, { outcome: 'completed', summary: 'Captured fixture output' });
  function source() { return db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(attempt.execution_id) as ExecutionAttempt; }
  return { db, taskId: task.task_id, work, source };
}

test('historical source recovery translates its adopted binding without changing frozen input or reading poisoned display cursors', async () => {
  const { db, taskId, source } = await fixture('legacy');
  const input = source().input_json;
  assert.equal((JSON.parse(input).delegation as DelegationEnvelope).workItemId, undefined);
  const item = adoptNativeWorkflowInDb(db, taskId).find(node => node.work_key === 'direct:execute')!;
  db.prepare("UPDATE tasks SET agile_status = 'done', total_stories = 99, current_subagent = 'review-agent' WHERE task_id = ?").run(taskId);
  const recovery = await progressDispatcher.nextRecovery();
  assert.equal(recovery?.attempt.execution_id, source().execution_id);
  assert.equal(recovery?.work.workItemId, item.item_id);
  assert.equal(recovery?.work.workItemRevision, item.revision);
  assert.equal(recovery?.work.workItemEpoch, item.dispatch_epoch);
  assert.equal(source().input_json, input);
  assert.equal(source().status, 'output_received');
});

for (const poison of ['json', 'missing-snapshot', 'task', 'role', 'pipeline', 'story', 'binding', 'revision', 'epoch', 'missing-generation'] as const) {
  test(`native source recovery rejects ${poison} rather than falling back to legacy task metadata`, async () => {
    const { db, source, work } = await fixture();
    const current = source();
    const snapshot = JSON.parse(current.input_json) as { delegation: DelegationEnvelope };
    if (poison === 'task') snapshot.delegation.taskId = 'REQ-foreign';
    if (poison === 'role') snapshot.delegation.agent = 'dev-agent';
    if (poison === 'pipeline') snapshot.delegation.pipeline = 'development';
    if (poison === 'story') snapshot.delegation.storyIndex = 99;
    if (poison === 'binding') snapshot.delegation.workItemId = randomUUID();
    if (poison === 'revision') snapshot.delegation.workItemRevision = 99;
    if (poison === 'epoch') snapshot.delegation.workItemEpoch = 99;
    if (poison === 'missing-generation') db.prepare('UPDATE execution_attempts SET dispatch_generation_key = NULL WHERE execution_id = ?').run(current.execution_id);
    db.prepare('UPDATE execution_attempts SET input_json = ? WHERE execution_id = ?')
      .run(poison === 'json' ? '{' : poison === 'missing-snapshot' ? '{}' : JSON.stringify(snapshot), current.execution_id);
    const before = source();
    assert.throws(() => restoreExecutionDelegationInDb(db, before, work), /快照无法读取|缺少冻结|不一致|代次已失效|缺少可确认/);
    assert.deepEqual(source(), before, 'diagnosis must not rewrite input, result or retry audit');
  });
}

test('superseded recovery keeps the original node and never binds the result to a newer revision', async () => {
  const { db, source, work } = await fixture();
  db.prepare("UPDATE workflow_items SET status = 'superseded' WHERE item_id = ?").run(work.workItemId);
  const original = restoreExecutionDelegationInDb(db, source());
  assert.equal(original.workItemId, work.workItemId);
  assert.equal(original.workItemRevision, work.workItemRevision);
});

test('a historical task hold cannot starve recovery of another requirement; applied source settlement remains available', async () => {
  const held = await fixture('legacy');
  const heldInput = held.source().input_json;
  held.db.prepare("UPDATE tasks SET agile_status = 'blocked', blocked_reason = 'Historical human hold' WHERE task_id = ?").run(held.taskId);
  adoptNativeWorkflowInDb(held.db, held.taskId);
  // Model a late durable recovery entry behind the captured hold; this is a
  // domain database fixture, not a claim that a cancelled CLI continued.
  held.db.prepare("UPDATE execution_attempts SET status = 'applying', input_json = ?, created_at = '2000-01-01' WHERE execution_id = ?")
    .run(heldInput, held.source().execution_id);
  const next = await fixture();
  held.db.prepare('UPDATE tasks SET is_paused = 0 WHERE task_id = ?').run(held.taskId);
  assert.equal((await progressDispatcher.nextRecovery())?.attempt.execution_id, next.source().execution_id);
  assert.equal(held.source().status, 'applying');
  held.db.prepare(`INSERT INTO agent_results(result_id,run_id,task_id,agent,pipeline,outcome,result_json,application_status,effect_outcome,execution_id)
    VALUES(?,?,?,'direct-agent','direct','completed','{}','applied','blocked',?)`)
    .run(randomUUID(), held.source().run_id, held.taskId, held.source().execution_id);
  assert.equal((await progressDispatcher.nextRecovery())?.attempt.execution_id, held.source().execution_id);
});
