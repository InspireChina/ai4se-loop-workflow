import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { builtinWorkflow } from '../domain/builtin-workflow';
import { createTaskInDb, createTaskSchema, updateUnstartedTaskInput } from './tasks';
import { initializeNativeWorkflowInDb } from './work-item-transitions';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { agentResultSchema } from '../domain/agent-result';
import { applyAgentResult } from './agent-results';
import { markExecutionOutput, completeExecution } from './executions';

async function createNative(itemType: 'feature' | 'bug' | 'direct' | 'business-analysis' | 'end-to-end' = 'feature') {
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET is_paused = 1, agile_status = 'cancelled' WHERE agile_status NOT IN ('done', 'cancelled')").run();
  const task = db.transaction(() => createTaskInDb(db, createTaskSchema.parse({ title: 'Native creation', itemType }), `REQ-${randomUUID()}`))();
  return { db, taskId: task.task_id };
}

for (const type of ['feature', 'bug', 'direct', 'business-analysis', 'end-to-end'] as const) {
  test(`new ${type} is initialized from its explicit native pipeline with no adoption or invented completion`, async () => {
    const { db, taskId } = await createNative(type);
    const graph = builtinWorkflow(type);
    const nodes = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId) as
      { item_id: string; work_key: string; origin: string; status: string; completed_at: string | null }[];
    assert.deepEqual(nodes.map((item) => item.work_key), graph.items.map((item) => item.workKey));
    assert.ok(nodes.every((item) => item.origin === 'native' && item.completed_at === null));
    assert.deepEqual(nodes.map((item) => item.status), ['ready', ...graph.items.slice(1).map(() => 'pending')]);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workflow_item_events event JOIN workflow_items item ON item.item_id = event.item_id WHERE item.task_id = ? AND event_type = 'adopt'")
      .get(taskId) as { count: number }).count, 0);
    const dispatch = await inspectTaskDispatchEnvelope(taskId);
    assert.equal(dispatch.length, 1);
    assert.equal(dispatch[0].workItemId, nodes[0].item_id);
    assert.equal(dispatch[0].agent, graph.items[0].agent);
    const before = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId);
    initializeNativeWorkflowInDb(db, { taskId, eventKey: 'task:create', actor: 'human', reason: '按需求 Pipeline 建立原生工作图' });
    assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId), before);
    assert.throws(() => initializeNativeWorkflowInDb(db, { taskId, eventKey: 'task:create', actor: 'human', reason: 'Different input' }), /幂等键冲突/);
  });
}

test('changing an unstarted native Pipeline cancels the old plan and preserves versioned history', async () => {
  const { db, taskId } = await createNative();
  const old = db.prepare('SELECT item_id FROM workflow_items WHERE task_id = ?').all(taskId) as { item_id: string }[];
  await updateUnstartedTaskInput({ taskId, title: 'Native creation', itemType: 'business-analysis', description: 'Analyze instead of implementing' });
  let dispatch = await inspectTaskDispatchEnvelope(taskId);
  assert.equal(dispatch[0].agent, 'idea-context-agent');
  assert.ok(old.every((item) => (db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(item.item_id) as { status: string }).status === 'cancelled'));
  await updateUnstartedTaskInput({ taskId, title: 'Native creation', itemType: 'feature', description: 'Implement the clarified scope' });
  dispatch = await inspectTaskDispatchEnvelope(taskId);
  assert.equal(dispatch[0].agent, 'backlog-agent');
  assert.equal(dispatch[0].workItemRevision, 2);
  assert.ok(!old.some((item) => item.item_id === dispatch[0].workItemId));
  const before = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId);
  await updateUnstartedTaskInput({ taskId, title: 'Renamed requirement', itemType: 'feature', description: 'Only edit the input' });
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId), before);
  const started = await beginTestExecutionAttempt({ runId: `RUN-${randomUUID()}`, delegation: dispatch[0], prompt: 'Started native work' });
  assert.ok(started.attempt.execution_id);
  await assert.rejects(updateUnstartedTaskInput({ taskId, title: 'Must not change', itemType: 'direct' }), /已经由 Agent/);
});

test('native new-task creation rejects historical stage injection and rolls back without a partial graph', async () => {
  const db = await databaseConnection();
  const taskId = `REQ-${randomUUID()}`;
  assert.throws(() => db.transaction(() => createTaskInDb(db, createTaskSchema.parse({ title: 'Invalid native start', actor: 'system', status: 'in plan' }), taskId))(), /新建需求只能进入待梳理状态/);
  assert.equal(db.prepare('SELECT 1 FROM tasks WHERE task_id = ?').get(taskId), undefined);
  assert.equal(db.prepare('SELECT 1 FROM workflow_items WHERE task_id = ?').get(taskId), undefined);
});

test('a natively created Direct task finishes from its Work Item fact, not a legacy state transition', async () => {
  const { db, taskId } = await createNative('direct');
  const work = (await inspectTaskDispatchEnvelope(taskId))[0];
  const started = await beginTestExecutionAttempt({ runId: `RUN-${randomUUID()}`, delegation: work, prompt: 'Native Direct completion' });
  db.prepare("UPDATE tasks SET agile_status = 'in plan', current_subagent = 'backlog-agent' WHERE task_id = ?").run(taskId);
  const result = agentResultSchema.parse({ outcome: 'completed', summary: 'Direct result delivered',
    artifact: { title: 'Direct result', content: 'Requested output has been produced.' } });
  await markExecutionOutput(started.attempt.execution_id, result);
  assert.equal(await applyAgentResult(`RUN-${randomUUID()}`, work, result, { executionId: started.attempt.execution_id }), 'advanced');
  await completeExecution(started.attempt.execution_id);
  const item = db.prepare('SELECT status, completed_at FROM workflow_items WHERE item_id = ?').get(work.workItemId) as { status: string; completed_at: string };
  const task = db.prepare('SELECT agile_status, completed_at, closure_acknowledged_at FROM tasks WHERE task_id = ?')
    .get(taskId) as { agile_status: string; completed_at: string; closure_acknowledged_at: string };
  assert.equal(item.status, 'completed');
  assert.equal(task.agile_status, 'done');
  assert.equal(task.completed_at, item.completed_at);
  assert.equal(task.closure_acknowledged_at, item.completed_at);
  assert.deepEqual(await inspectTaskDispatchEnvelope(taskId), []);
});
