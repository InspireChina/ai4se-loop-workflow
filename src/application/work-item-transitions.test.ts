import assert from 'node:assert/strict';
import test from 'node:test';
import type Database from 'better-sqlite3';
import { createTask } from '../test/legacy-task-fixtures';
import { databaseConnection } from '../infrastructure/database';
import { adoptNativeWorkflowInDb, appendDeliveryWorkItemsInDb, rewindWorkItemsInDb, transitionWorkItemInDb } from './work-item-transitions';
import { openInterventionInDb } from './interventions';
import { syncLegacyDeliveryWorkItemsInDb, readyWorkflowItemsForTaskInDb } from './work-items';

function execution(db: Database.Database, itemId: string, taskId: string, executionId: string) {
  db.prepare(`
    INSERT INTO execution_attempts(execution_id, work_item_id, run_id, task_id, agent, pipeline,
      delegation_key, attempt, status, input_hash, input_json)
    VALUES(?, ?, 'RUN-native', ?, 'backlog-agent', 'backlog', ?, 1, 'planned', 'input', '{}')
  `).run(executionId, itemId, taskId, executionId);
}

test('native lifecycle commits audited transitions, unlocks dependencies and rejects invalid or conflicting replays', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Native lifecycle' });
  const adopted = adoptNativeWorkflowInDb(db, taskId);
  const context = adopted.find((item) => item.work_key === 'delivery:context')!;
  const plan = adopted.find((item) => item.work_key === 'delivery:plan')!;
  assert.equal(plan.status, 'pending');
  execution(db, context.item_id, taskId, `EXEC-${taskId}`);
  const start = { itemId: context.item_id, action: 'start' as const, eventKey: 'start:1', actor: 'backlog-agent',
    authority: 'agent' as const, reason: 'Begin context', executionId: `EXEC-${taskId}` };
  assert.equal(transitionWorkItemInDb(db, start).status, 'running');
  assert.equal(transitionWorkItemInDb(db, start).status, 'running');
  assert.throws(() => transitionWorkItemInDb(db, { ...start, reason: 'Different start' }), /幂等键冲突/);
  const complete = { ...start, action: 'complete' as const, eventKey: 'complete:1', reason: 'Context submitted' };
  assert.equal(transitionWorkItemInDb(db, complete).completion_authority, 'agent');
  assert.equal(readyWorkflowItemsForTaskInDb(db, taskId).find((item) => item.item_id === plan.item_id)?.status, 'ready');
  assert.equal(transitionWorkItemInDb(db, complete).status, 'completed');
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workflow_item_events WHERE item_id = ? AND event_type = 'complete'")
    .get(context.item_id) as { count: number }).count, 1);
  assert.throws(() => transitionWorkItemInDb(db, { ...start, eventKey: 'start:again' }), /尚未就绪/);
  db.prepare("UPDATE tasks SET agile_status = 'backlog', current_subagent = 'backlog-agent', total_stories = 3 WHERE task_id = ?").run(taskId);
  const afterLegacyWrite = syncLegacyDeliveryWorkItemsInDb(db, taskId);
  assert.equal(afterLegacyWrite.items.length, adopted.length, 'cursor changes cannot manufacture new work after adoption');
  assert.equal(afterLegacyWrite.items.find((item) => item.item_id === context.item_id)?.status, 'completed');
});

test('native waiting requires explicit submit/resume and cancellation does not reset retry epoch', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Native wait/resume' });
  const item = adoptNativeWorkflowInDb(db, taskId).find((item) => item.work_key === 'delivery:context')!;
  const base = { itemId: item.item_id, actor: 'system', authority: 'system' as const, reason: 'Input needed' };
  transitionWorkItemInDb(db, { ...base, action: 'wait', eventKey: 'wait' });
  const intervention = openInterventionInDb(db, { taskId, itemId: item.item_id, dedupeKey: 'input',
    requestedBy: 'backlog-agent', summary: 'Confirm target', resolverStrategy: 'human_only' });
  assert.throws(() => transitionWorkItemInDb(db, { ...base, action: 'resume', eventKey: 'too-early' }), /不能恢复/);
  db.prepare("UPDATE interventions SET status = 'resolved' WHERE intervention_id = ?").run(intervention.intervention_id);
  assert.equal(readyWorkflowItemsForTaskInDb(db, taskId).length, 0);
  const resumed = transitionWorkItemInDb(db, { ...base, action: 'resume', eventKey: 'submit' });
  assert.equal(resumed.dispatch_epoch, 1);
  assert.equal(resumed.resume_pending, 1);
  transitionWorkItemInDb(db, { ...base, action: 'wait', eventKey: 'wait:2' });
  assert.throws(() => transitionWorkItemInDb(db, { ...base, action: 'resume', eventKey: 'illegal-reset', resetRetryBudget: true }), /只有人工或仲裁/);
  assert.equal(transitionWorkItemInDb(db, { ...base, authority: 'human', action: 'resume', eventKey: 'human-reset', resetRetryBudget: true }).dispatch_epoch, 2);
  db.prepare('UPDATE tasks SET is_paused = 1 WHERE task_id = ?').run(taskId);
  assert.throws(() => transitionWorkItemInDb(db, { ...base, action: 'complete', eventKey: 'paused-complete' }), /暂停/);
  assert.equal(transitionWorkItemInDb(db, { ...base, action: 'cancel', eventKey: 'cancel' }).dispatch_epoch, 2);
});

test('native rewind versions dependent closure, preserves historical evidence and rebinds edges atomically', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Native rewind' });
  db.prepare(`UPDATE tasks SET agile_status = 'in dev', current_subagent = 'test-agent',
    total_stories = 2, analysis_index = 2, dev_index = 1, test_index = 0 WHERE task_id = ?`).run(taskId);
  db.prepare("UPDATE task_lanes SET status = 'completed' WHERE task_id = ? AND lane = 'analysis'").run(taskId);
  const adopted = adoptNativeWorkflowInDb(db, taskId);
  const analysis = adopted.find((item) => item.work_key === 'delivery:analysis:1')!;
  const dev = adopted.find((item) => item.work_key === 'delivery:dev:1')!;
  const testItem = adopted.find((item) => item.work_key === 'delivery:test:1')!;
  execution(db, testItem.item_id, taskId, `EXEC-rewind-${taskId}`);
  const intervention = openInterventionInDb(db, { taskId, itemId: testItem.item_id, dedupeKey: 'arbitration',
    summary: 'Contract conflict', requestedBy: 'test-agent', authority: 'arbitration' });
  const input = { taskId, targetItemId: dev.item_id, eventKey: 'rewind:1', actor: 'system-assistance-agent',
    authority: 'arbitration' as const, reason: 'Fix wrong acceptance ownership', preserveInterventionId: intervention.intervention_id };
  const { replacements } = rewindWorkItemsInDb(db, input);
  assert.deepEqual(rewindWorkItemsInDb(db, input).replacements, replacements);
  assert.ok(!replacements[analysis.item_id], 'unrelated completed analysis stays untouched');
  assert.ok(replacements[testItem.item_id]);
  const old = db.prepare('SELECT status, completed_at, superseded_by_item_id FROM workflow_items WHERE item_id = ?')
    .get(dev.item_id) as { status: string; completed_at: string; superseded_by_item_id: string };
  assert.equal(old.status, 'superseded');
  assert.ok(old.completed_at);
  assert.equal(old.superseded_by_item_id, replacements[dev.item_id]);
  assert.ok(db.prepare('SELECT 1 FROM workflow_dependencies WHERE item_id = ? AND depends_on_item_id = ?')
    .get(replacements[testItem.item_id], replacements[dev.item_id]));
  assert.equal((db.prepare('SELECT status FROM execution_attempts WHERE execution_id = ?').get(`EXEC-rewind-${taskId}`) as {status:string}).status, 'cancelled');
  assert.equal((db.prepare('SELECT item_id FROM interventions WHERE intervention_id = ?').get(intervention.intervention_id) as {item_id:string}).item_id, replacements[testItem.item_id]);
  assert.equal(readyWorkflowItemsForTaskInDb(db, taskId).find((item) => item.item_id === replacements[dev.item_id])?.revision, 2);
});

test('native plan expansion gates review and unlocks Analysis and Dev using only explicit unit dependencies', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Native plan expansion' });
  const adopted = adoptNativeWorkflowInDb(db, taskId);
  const context = adopted.find((item) => item.work_key === 'delivery:context')!;
  const plan = adopted.find((item) => item.work_key === 'delivery:plan')!;
  const complete = (itemId: string, eventKey: string) => transitionWorkItemInDb(db, {
    itemId, action: 'complete', eventKey, actor: 'test-fixture', authority: 'human', reason: 'Verified fixture evidence',
  });
  complete(context.item_id, 'context:complete');
  assert.deepEqual(readyWorkflowItemsForTaskInDb(db, taskId).map((item) => item.work_key), ['delivery:plan']);
  const input = { taskId, units: [{ storyIndex: 1, title: 'Backend query' }, { storyIndex: 2, title: 'Frontend tab' }],
    eventKey: 'plan:units', actor: 'story-splitter-agent', reason: 'Create explicit unit graph' };
  appendDeliveryWorkItemsInDb(db, input);
  appendDeliveryWorkItemsInDb(db, input);
  assert.throws(() => appendDeliveryWorkItemsInDb(db, { ...input, units: [{ storyIndex: 1, title: 'Other plan' }] }), /幂等键冲突/);
  complete(plan.item_id, 'plan:complete');
  assert.deepEqual(readyWorkflowItemsForTaskInDb(db, taskId).map((item) => item.work_key), ['delivery:analysis:1']);
  const analysis = readyWorkflowItemsForTaskInDb(db, taskId)[0];
  complete(analysis.item_id, 'analysis:complete');
  assert.deepEqual(readyWorkflowItemsForTaskInDb(db, taskId).map((item) => item.work_key).sort(), ['delivery:analysis:2', 'delivery:dev:1']);
  const beforeInvalid = (db.prepare('SELECT COUNT(*) AS count FROM workflow_items WHERE task_id = ?').get(taskId) as {count:number}).count;
  assert.throws(() => appendDeliveryWorkItemsInDb(db, { ...input, eventKey: 'invalid-plan', units: [{ storyIndex: 4, title: 'Missing previous unit' }] }), /缺少上一单元/);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM workflow_items WHERE task_id = ?').get(taskId) as {count:number}).count, beforeInvalid, 'invalid expansions roll back the entire graph');
});

test('native Direct result completes its anchored Work Item and requirement without a legacy projection write', async () => {
  const { inspectTaskDispatchEnvelope } = await import('../test/dispatch-inspection-fixtures');
  const { beginTestExecutionAttempt } = await import('../test/execution-fixtures');
  const { parseAgentResult } = await import('../domain/agent-result');
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { getTask } = await import('../test/legacy-task-fixtures');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Native Direct result', itemType: 'direct' });
  const [item] = adoptNativeWorkflowInDb(db, taskId);
  const [delegation] = await inspectTaskDispatchEnvelope(taskId);
  const { attempt } = await beginTestExecutionAttempt({ runId: 'RUN-native-direct', delegation, prompt: 'Execute direct task' });
  const result = parseAgentResult(JSON.stringify({ outcome: 'completed', summary: 'Direct result published',
    artifact: { title: 'Result', content: '# Result\n\nVerified output' } }));
  assert.equal(await applyAgentResult('RUN-native-direct', delegation, result, { executionId: attempt.execution_id }), 'advanced');
  await completeExecution(attempt.execution_id);
  assert.equal((await getTask(taskId))?.task.agile_status, 'done');
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(item.item_id) as {status:string}).status, 'completed');
  assert.equal(await applyAgentResult('RUN-native-direct', delegation, result, { executionId: attempt.execution_id }), 'advanced');
});
