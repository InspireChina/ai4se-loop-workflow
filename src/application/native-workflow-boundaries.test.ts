import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { createTaskInDb, createTaskSchema, cancelTask } from './tasks';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { issueAgentCommandToken, runAgentCommand, readAgentCommandSubmission } from './agent-command-drafts';
import { markExecutionOutput } from './executions';
import { applyNextQueuedAgentResult } from './agent-results';
import { adoptNativeWorkflowInDb, appendDeliveryWorkItemsInDb } from './work-item-transitions';
import { beginTaskContextChatTurn, submitTaskContextChatChangeRequest } from './task-context-chat';
import { openInterventionInDb } from './interventions';
import { progressDispatcher } from './progress-dispatch';
import { createLegacyTaskInDb } from '../test/legacy-task-fixtures';

async function native(itemType: 'direct' | 'feature' = 'direct') {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused = 1').run();
  const task = db.transaction(() => createTaskInDb(db, createTaskSchema.parse({ title: randomUUID(), itemType }),
    `REQ-${randomUUID()}`))();
  return { db, taskId: task.task_id };
}

async function queuedDirect(enqueue = true) {
  const { db, taskId } = await native();
  const work = (await inspectTaskDispatchEnvelope(taskId))[0];
  const runId = `RUN-${randomUUID()}`;
  const { attempt } = await beginTestExecutionAttempt({ runId, delegation: work, prompt: 'Signed Direct submission fixture' });
  const executionId = attempt.execution_id;
  const token = await issueAgentCommandToken(executionId);
  assert.ok(token);
  await runAgentCommand({ executionId, token, args: ['direct', 'run'] });
  await runAgentCommand({ executionId, token, args: ['direct', 'submit', '--summary', 'Result submitted', '--result', '# Fixture result'] });
  const result = await readAgentCommandSubmission(executionId);
  assert.ok(result);
  await markExecutionOutput(executionId, result);
  const resultId = randomUUID();
  if (enqueue) db.prepare(`INSERT INTO agent_results(result_id, run_id, task_id, agent, pipeline, outcome, result_json, application_status, execution_id)
    VALUES(?, ?, ?, 'direct-agent', 'direct', 'completed', ?, 'pending', ?)`).run(resultId, runId, taskId, JSON.stringify(result), executionId);
  return { db, taskId, executionId, resultId, result, runId };
}

test('native result queue ignores a stale blocked badge and applies the signed current Work Item result', async () => {
  const { db, taskId, executionId, resultId } = await queuedDirect();
  db.prepare("UPDATE tasks SET agile_status = 'blocked', run_state = 'system_blocked' WHERE task_id = ?").run(taskId);
  const applied = await applyNextQueuedAgentResult();
  assert.equal(applied.status, 'applied');
  assert.equal(applied.status === 'applied' && applied.resultId, resultId);
  assert.equal(applied.status === 'applied' && applied.outcome, 'advanced');
  assert.equal((db.prepare('SELECT status FROM execution_attempts WHERE execution_id = ?').get(executionId) as { status: string }).status, 'applied');
});

test('unadopted historical results cannot run or consume errors and do not starve a native result', async () => {
  const db = await databaseConnection();
  const taskId = `REQ-${randomUUID()}`;
  db.transaction(() => createLegacyTaskInDb(db, createTaskSchema.parse({ title: 'Unadopted queued history', itemType: 'direct' }), taskId))();
  const executionId = randomUUID(), resultId = randomUUID();
  db.prepare(`INSERT INTO execution_attempts(execution_id,run_id,task_id,agent,pipeline,lane,delegation_key,
    attempt,status,input_hash,input_json,result_json) VALUES(?,'old-run',?,'direct-agent','direct','control',?,1,
    'output_received','original-hash','{}','not-json')`).run(executionId,taskId,executionId);
  db.prepare(`INSERT INTO agent_results(result_id,run_id,task_id,agent,pipeline,outcome,result_json,
    application_status,execution_id,created_at) VALUES(?,'old-run',?,'direct-agent','direct','completed',
    'not-json','pending',?,'2000-01-01')`).run(resultId,taskId,executionId);
  const next = await queuedDirect();
  db.prepare('UPDATE tasks SET is_paused = 0 WHERE task_id = ?').run(taskId);
  const sourceBefore = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId);
  const resultBefore = db.prepare('SELECT * FROM agent_results WHERE result_id = ?').get(resultId);
  const taskBefore = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
  const graphBefore = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId);
  const applied = await applyNextQueuedAgentResult();
  assert.equal(applied.status === 'applied' && applied.resultId, next.resultId);
  assert.deepEqual(await applyNextQueuedAgentResult(), { status: 'none' });
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId), sourceBefore);
  assert.deepEqual(db.prepare('SELECT * FROM agent_results WHERE result_id = ?').get(resultId), resultBefore);
  assert.deepEqual(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId), taskBefore);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId), graphBefore);
  assert.equal(db.prepare("SELECT 1 FROM workflow_items WHERE task_id = ? AND origin = 'native'").get(taskId), undefined);
  assert.equal(db.prepare('SELECT 1 FROM interventions WHERE task_id = ?').get(taskId), undefined);
});

test('native result queue rejects missing frozen input, records the actual diagnostic, and cannot complete from current task metadata', async () => {
  const { db, taskId, executionId, resultId } = await queuedDirect();
  db.prepare("UPDATE execution_attempts SET input_json = '{}' WHERE execution_id = ?").run(executionId);
  const applied = await applyNextQueuedAgentResult();
  assert.equal(applied.status, 'failed');
  assert.ok(applied.status === 'failed' && applied.reason.includes(executionId) && /缺少冻结 delegation/.test(applied.reason));
  const row = db.prepare('SELECT application_status, application_error FROM agent_results WHERE result_id = ?').get(resultId) as { application_status: string; application_error: string };
  assert.equal(row.application_status, 'failed');
  assert.ok(row.application_error.includes(executionId));
  assert.equal(db.prepare("SELECT 1 FROM workflow_items WHERE task_id = ? AND status = 'completed'").get(taskId), undefined);
});

test('a current node Intervention holds both recovery channels without starving independent results', async () => {
  const held = await queuedDirect();
  const source = held.db.prepare('SELECT work_item_id FROM execution_attempts WHERE execution_id = ?').get(held.executionId) as { work_item_id: string };
  const intervention = openInterventionInDb(held.db, { taskId: held.taskId, itemId: source.work_item_id,
    dedupeKey: 'fixture:pending-result-obligation', summary: 'Resolve before applying this node', requestedBy: 'direct-agent' });
  const next = await queuedDirect();
  held.db.prepare('UPDATE tasks SET is_paused = 0 WHERE task_id = ?').run(held.taskId);
  held.db.prepare("UPDATE execution_attempts SET created_at = '2000-01-01' WHERE execution_id = ?").run(held.executionId);
  held.db.prepare("UPDATE agent_results SET created_at = '2000-01-01' WHERE result_id = ?").run(held.resultId);
  assert.equal((await progressDispatcher.nextRecovery())?.attempt.execution_id, next.executionId);
  assert.equal((await applyNextQueuedAgentResult()).status, 'applied');
  assert.equal((held.db.prepare('SELECT application_status FROM agent_results WHERE result_id = ?').get(held.resultId) as { application_status: string }).application_status, 'pending');
  assert.equal((held.db.prepare('SELECT status FROM execution_attempts WHERE execution_id = ?').get(held.executionId) as { status: string }).status, 'output_received');
  // Domain fixture of successful resolver settlement; it is not an asserted
  // real system-agent attempt or a fabricated three-attempt UI run.
  held.db.prepare("UPDATE interventions SET status = 'resolved' WHERE intervention_id = ?").run(intervention.intervention_id);
  assert.equal((await progressDispatcher.nextRecovery())?.attempt.execution_id, held.executionId);
  assert.equal((await applyNextQueuedAgentResult()).status, 'applied');
});

test('cancelled historical queued source with missing input is discarded without inventing a current work binding', async () => {
  const { db, executionId, resultId } = await queuedDirect();
  db.prepare("UPDATE execution_attempts SET status = 'cancelled', input_json = '{}', work_item_id = NULL WHERE execution_id = ?").run(executionId);
  const sourceBefore = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId);
  const applied = await applyNextQueuedAgentResult();
  assert.equal(applied.status === 'applied' && applied.resultId, resultId);
  assert.equal(applied.status === 'applied' && applied.outcome, 'discarded');
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId), sourceBefore);
});

test('an actual task-wide Intervention holds its queued result without starving another ready requirement', async () => {
  const held = await queuedDirect();
  held.db.prepare("UPDATE tasks SET agile_status = 'blocked', blocked_reason = 'Historical operator hold' WHERE task_id = ?").run(held.taskId);
  adoptNativeWorkflowInDb(held.db, held.taskId);
  const next = await queuedDirect();
  held.db.prepare('UPDATE tasks SET is_paused = 0 WHERE task_id = ?').run(held.taskId);
  held.db.prepare("UPDATE tasks SET agile_status = 'backlog' WHERE task_id = ?").run(held.taskId);
  // Force queue ordering without pretending that these are real Agent runs.
  held.db.prepare("UPDATE agent_results SET created_at = '2000-01-01' WHERE result_id = ?").run(held.resultId);
  const applied = await applyNextQueuedAgentResult();
  assert.equal(applied.status === 'applied' && applied.resultId, next.resultId);
  assert.equal((held.db.prepare('SELECT application_status FROM agent_results WHERE result_id = ?').get(held.resultId) as { application_status: string }).application_status, 'pending');
  await cancelTask({ taskId: held.taskId, reason: 'Clean up held fixture' });
});

test('discarding a terminal requirement queued result does not overwrite an earlier actual failure or its quota', async () => {
  const { db, taskId, executionId, resultId, result, runId } = await queuedDirect(false);
  db.prepare(`UPDATE execution_attempts SET status = 'retryable_failed', failure_kind = 'agent-cli-exit',
    last_error = 'Original CLI failure', dispatch_retry_consumed = 1, finished_at = '2000-01-01' WHERE execution_id = ?`).run(executionId);
  await cancelTask({ taskId, reason: 'Operator cancelled after failure' });
  // Model a late arrival after cancellation, not an already drained result.
  db.prepare(`INSERT INTO agent_results(result_id, run_id, task_id, agent, pipeline, outcome, result_json, application_status, execution_id)
    VALUES(?, ?, ?, 'direct-agent', 'direct', 'completed', ?, 'pending', ?)`).run(resultId, runId, taskId, JSON.stringify(result), executionId);
  const before = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId);
  const applied = await applyNextQueuedAgentResult();
  assert.equal(applied.status === 'applied' && applied.resultId, resultId);
  assert.equal(applied.status === 'applied' && applied.outcome, 'discarded');
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId), before);
});

async function changeInput(withUnit = true) {
  const { db, taskId } = await native('feature');
  if (withUnit) {
    db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Real unit fixture', 'story-001')").run(taskId);
    appendDeliveryWorkItemsInDb(db, { taskId, units: [{ storyIndex: 1, title: 'Real unit fixture' }],
      eventKey: 'fixture:unit', actor: 'human', reason: 'Create domain-only unit fixture' });
  }
  const turn = await beginTaskContextChatTurn(taskId, 'Change the current delivery', 'claude');
  const input = { sessionId: turn.session.sessionId, messageId: turn.messageId, token: turn.commandToken,
    requestKey: 'current-change', title: 'Current change', request: 'Adjust the actual current delivery unit' };
  return { db, taskId, input };
}

test('native context Chat submits against the current delivery graph despite stale done and zero-unit labels', async () => {
  const { db, taskId, input } = await changeInput();
  db.prepare("UPDATE tasks SET agile_status = 'done', total_stories = 0 WHERE task_id = ?").run(taskId);
  assert.equal((await submitTaskContextChatChangeRequest(input)).created, true);
  assert.equal((await submitTaskContextChatChangeRequest(input)).created, false);
});

test('native context Chat rejects an invented unit count without an actual current plan unit', async () => {
  const { db, taskId, input } = await changeInput(false);
  db.prepare('UPDATE tasks SET total_stories = 99 WHERE task_id = ?').run(taskId);
  await assert.rejects(submitTaskContextChatChangeRequest(input), /尚未形成交付单元/);
  assert.equal((db.prepare('SELECT COUNT(*) count FROM task_context_chat_change_requests WHERE session_id = ?').get(input.sessionId) as { count: number }).count, 0);
});

test('native context Chat cannot use superseded plan units as a current delivery fact', async () => {
  const { db, taskId, input } = await changeInput();
  db.prepare("UPDATE workflow_items SET status = 'superseded' WHERE task_id = ? AND kind = 'development'").run(taskId);
  db.prepare('UPDATE tasks SET total_stories = 99 WHERE task_id = ?').run(taskId);
  await assert.rejects(submitTaskContextChatChangeRequest(input), /尚未形成交付单元/);
});

test('native context Chat respects actual cancellation even when the compatibility label says backlog', async () => {
  const { db, taskId, input } = await changeInput();
  await cancelTask({ taskId, reason: 'Cancel the domain fixture' });
  db.prepare("UPDATE tasks SET agile_status = 'backlog' WHERE task_id = ?").run(taskId);
  await assert.rejects(submitTaskContextChatChangeRequest(input), /终态需求/);
});
