import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { createTask, addQuestion, answerQuestion, submitClarificationAnswers, addRuntimeInputRequest,
  answerRuntimeInput, submitRuntimeInputs, getTask, upsertDocument, acknowledgeClosure, releaseBlock, pauseTask, resumeTask } from '../test/legacy-task-fixtures';
import { adoptNativeWorkflowInDb, rewindWorkItemsInDb } from './work-item-transitions';
import { completeExecution, failExecutionWithRetryPolicy, reconcileInterruptedExecutions } from './executions';
import { openInterventionInDb } from './interventions';
import { applyAgentResult, applyNextQueuedAgentResult } from './agent-results';
import { agentResultSchema } from '../domain/agent-result';
import { nativeDeliveryReadyInDb } from './work-item-controls';

async function inputTask() {
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET is_paused = 1, agile_status = 'cancelled' WHERE agile_status NOT IN ('done', 'cancelled')").run();
  const taskId = await createTask({ title: 'Graph-scoped human input' });
  adoptNativeWorkflowInDb(db, taskId);
  const work = (await inspectTaskDispatchEnvelope(taskId))[0];
  assert.equal(work.agent, 'backlog-agent');
  const started = await beginTestExecutionAttempt({ runId: `RUN-${randomUUID()}`, delegation: work, prompt: 'Human input fixture' });
  return { db, taskId, work, itemId: work.workItemId!, executionId: started.attempt.execution_id };
}

for (const rewound of [false, true]) for (const queued of [false, true]) test(`late ${queued ? 'queued' : 'direct'} completion after ${rewound ? 'rewind' : 'pause/resume'} cannot consume current Work Item answers`, async () => {
  const { db, taskId, work, itemId, executionId } = await inputTask();
  if (rewound) rewindWorkItemsInDb(db, { taskId, targetItemId: itemId, eventKey: `replace-input-${queued}`, actor: 'human', authority: 'human', reason: 'Correct the requirement scope' });
  else {
    await pauseTask({ taskId });
    await resumeTask({ taskId });
  }
  const replacement = (await inspectTaskDispatchEnvelope(taskId))[0];
  if (rewound) assert.notEqual(replacement.workItemId, itemId);
  else assert.equal(replacement.workItemId, itemId);
  const started = await beginTestExecutionAttempt({ runId: `RUN-${randomUUID()}`, delegation: replacement, prompt: 'New revision input' });
  const requestId = await addRuntimeInputRequest({ taskId, sourceAgent: 'backlog-agent', sourceExecutionId: started.attempt.execution_id,
    title: 'New revision runtime', question: 'Which operating system?' });
  await completeExecution(started.attempt.execution_id);
  await answerRuntimeInput({ taskId, requestId, answer: 'Windows 11' });
  const before = db.prepare('SELECT * FROM runtime_input_requests WHERE request_id = ?').get(requestId);
  const documents = db.prepare('SELECT * FROM documents WHERE task_id = ? ORDER BY rowid').all(taskId);
  const result = agentResultSchema.parse({ outcome: 'completed', summary: 'Late old requirement result' });
  if (queued) {
    const resultId = randomUUID();
    db.prepare(`INSERT INTO agent_results(result_id, run_id, task_id, agent, pipeline, outcome, result_json, application_status, execution_id)
      VALUES(?, ?, ?, ?, ?, 'completed', ?, 'pending', ?)`).run(resultId, `RUN-${randomUUID()}`, taskId, work.agent, work.pipeline, JSON.stringify(result), executionId);
    const applied = await applyNextQueuedAgentResult();
    assert.equal(applied.status, 'applied');
    assert.equal(applied.status === 'applied' && applied.resultId, resultId);
    assert.equal(applied.status === 'applied' && applied.outcome, 'discarded');
  } else assert.equal(await applyAgentResult(`RUN-${randomUUID()}`, work, result, { executionId }), 'discarded');
  assert.deepEqual(db.prepare('SELECT * FROM runtime_input_requests WHERE request_id = ?').get(requestId), before);
  assert.deepEqual(db.prepare('SELECT * FROM documents WHERE task_id = ? ORDER BY rowid').all(taskId), documents);
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(replacement.workItemId) as { status: string }).status, 'waiting');
});

test('native clarification submission is Intervention-scoped, explicit, audited and independent of old task/Lane state', async () => {
  const { db, taskId, itemId, executionId } = await inputTask();
  const first = await addQuestion({ taskId, actor: 'backlog-agent', title: 'First input', question: 'Which user action?', kind: 'local' });
  const second = await addQuestion({ taskId, actor: 'backlog-agent', title: 'Second input', question: 'Which observable outcome?', kind: 'local' });
  await completeExecution(executionId);
  await answerQuestion({ taskId, questionId: first, answer: 'Save action' });
  await assert.rejects(submitClarificationAnswers(taskId), /未回答/);
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(itemId) as { status: string }).status, 'waiting');
  await answerQuestion({ taskId, questionId: second, answer: 'Updated value is visible' });
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(itemId) as { status: string }).status, 'waiting');
  assert.equal((await getTask(taskId))?.task.run_state, 'waiting_for_answers',
    'the last saved answer must keep the explicit batch-submit entry visible');
  db.prepare("UPDATE tasks SET current_subagent = 'test-agent', agile_status = 'in plan', run_state = 'idle', resume_pending = 0 WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE task_lanes SET status = 'completed', current_agent = NULL WHERE task_id = ?").run(taskId);
  await submitClarificationAnswers(taskId);
  assert.equal((await getTask(taskId))?.task.next_step, '人工澄清回答已提交，工作项恢复推进');
  const resumed = (await inspectTaskDispatchEnvelope(taskId))[0];
  assert.equal(resumed.workItemId, itemId);
  assert.equal(resumed.agent, 'backlog-agent');
  assert.equal(resumed.pipeline, 'resume');
  await submitClarificationAnswers(taskId);
  const events = db.prepare("SELECT payload_json FROM workflow_item_events WHERE item_id = ? AND event_key LIKE 'human-inputs:questions:%'")
    .all(itemId) as { payload_json: string }[];
  assert.equal(events.length, 1);
  assert.match(events[0].payload_json, /Save action/);
  assert.match(events[0].payload_json, /Updated value is visible/);
});

test('native runtime submission cannot bypass another active Intervention and rollback preserves waiting state', async () => {
  const { db, taskId, itemId, executionId } = await inputTask();
  const requestId = await addRuntimeInputRequest({ taskId, sourceAgent: 'backlog-agent', sourceExecutionId: executionId,
    title: 'Target runtime', question: 'Which runtime should be used?' });
  await completeExecution(executionId);
  await answerRuntimeInput({ taskId, requestId, answer: 'Windows 11' });
  assert.equal((await getTask(taskId))?.task.run_state, 'waiting_for_runtime_input',
    'answered runtime inputs still await explicit submission, not error recovery');
  const intervention = openInterventionInDb(db, { taskId, itemId, dedupeKey: 'another-human-gate', requestedBy: 'system',
    summary: 'Another unresolved gate', resolverStrategy: 'human_only' });
  await assert.rejects(submitRuntimeInputs(taskId), /不能恢复|介入仍未解决/);
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(itemId) as { status: string }).status, 'waiting');
  db.prepare("UPDATE interventions SET status = 'resolved', resolution = 'Explicitly resolved', resolved_by = 'human' WHERE intervention_id = ?")
    .run(intervention.intervention_id);
  db.prepare("UPDATE tasks SET current_subagent = NULL, run_state = 'idle', agile_status = 'in plan' WHERE task_id = ?").run(taskId);
  await submitRuntimeInputs(taskId);
  assert.equal((await inspectTaskDispatchEnvelope(taskId))[0].workItemId, itemId);
  assert.equal((db.prepare('SELECT dispatch_epoch FROM workflow_items WHERE item_id = ?').get(itemId) as { dispatch_epoch: number }).dispatch_epoch, 1);
  await submitRuntimeInputs(taskId);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workflow_item_events WHERE item_id = ? AND event_key LIKE 'human-inputs:runtime:%'")
    .get(itemId) as { count: number }).count, 1);
});

async function closureTask() {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Graph-scoped closure', itemType: 'business-analysis' });
  const documentId = await upsertDocument({ taskId, actor: 'review-agent', kind: 'review_v1', title: 'Reviewed specification', content: 'Verified final specification', format: 'markdown' });
  db.prepare(`UPDATE tasks SET agile_status = 'ready_to_close', closure_status = 'awaiting_read', run_state = 'idle',
    current_subagent = NULL, review_revision = 1, review_document_id = ? WHERE task_id = ?`).run(documentId, taskId);
  const items = adoptNativeWorkflowInDb(db, taskId);
  const closure = items.find((item) => item.kind === 'closure' && item.status === 'waiting')!;
  assert.ok(closure);
  return { db, taskId, closure, documentId };
}

test('native reading closes only the current graph obligation, ignores old display guards and is idempotent', async () => {
  const { db, taskId, closure, documentId } = await closureTask();
  db.prepare("UPDATE tasks SET agile_status = 'in plan', closure_status = 'none', current_subagent = 'backlog-agent', run_state = 'runnable' WHERE task_id = ?").run(taskId);
  const batchId = randomUUID();
  db.prepare("INSERT INTO feedback_batches(batch_id, task_id, batch_number, status) VALUES(?, ?, 1, 'triaging')").run(batchId, taskId);
  // There is no frozen comment or unfinished graph obligation: the old
  // batch status by itself must not become a new scheduling fact.
  await acknowledgeClosure({ taskId, reviewRevision: 1 });
  await acknowledgeClosure({ taskId, reviewRevision: 1 });
  const result = await getTask(taskId);
  assert.equal(result?.task.agile_status, 'done');
  assert.equal(result?.closureAcknowledgements.length, 1);
  const event = db.prepare("SELECT payload_json FROM workflow_item_events WHERE item_id = ? AND event_type = 'complete'")
    .get(closure.item_id) as { payload_json: string };
  assert.equal(JSON.parse(event.payload_json).reviewDocumentId, documentId);
  await assert.rejects(acknowledgeClosure({ taskId, reviewRevision: 2 }), /版本已变化/);
});

test('native reading cannot bypass a pending graph Work Item even when old cursors claim closure is ready', async () => {
  const { db, taskId, closure } = await closureTask();
  const itemId = randomUUID();
  db.prepare(`INSERT INTO workflow_items(item_id, task_id, work_key, revision, kind, title, status, origin)
    VALUES(?, ?, 'required:verification', 1, 'verification', 'Still required verification', 'pending', 'native')`).run(itemId, taskId);
  await assert.rejects(acknowledgeClosure({ taskId, reviewRevision: 1 }), /未完成的工作项/);
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(closure.item_id) as { status: string }).status, 'waiting');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM closure_acknowledgements WHERE task_id = ?').get(taskId) as { count: number }).count, 0);
});

for (const mutation of ['document', 'revision', 'content', 'damaged-proof'] as const) test(`historical Closure adoption seals the final artifact and rejects later ${mutation} changes`, async () => {
  const { db, taskId, closure, documentId } = await closureTask();
  assert.equal(nativeDeliveryReadyInDb(db, taskId), true);
  if (mutation === 'document') {
    const unrelated = await upsertDocument({ taskId, actor: 'human', kind: 'context', title: 'Not the final artifact', content: 'Unreviewed context' });
    db.prepare('UPDATE tasks SET review_document_id = ? WHERE task_id = ?').run(unrelated, taskId);
  } else if (mutation === 'revision') db.prepare('UPDATE tasks SET review_revision = 2 WHERE task_id = ?').run(taskId);
  else if (mutation === 'content') db.prepare("UPDATE documents SET content = 'Changed without a new publication' WHERE document_id = ?").run(documentId);
  else db.prepare("UPDATE workflow_item_events SET payload_json = '{broken' WHERE item_id = ? AND event_key = 'native:adopt'").run(closure.item_id);
  const before = db.prepare("SELECT payload_json FROM workflow_item_events WHERE item_id = ? AND event_key = 'native:adopt'").get(closure.item_id);
  // Ordinary reads/adoption calls must not reseal a mutable document head.
  adoptNativeWorkflowInDb(db, taskId);
  assert.deepEqual(db.prepare("SELECT payload_json FROM workflow_item_events WHERE item_id = ? AND event_key = 'native:adopt'").get(closure.item_id), before);
  assert.equal(nativeDeliveryReadyInDb(db, taskId), false);
  await assert.rejects(acknowledgeClosure({ taskId, reviewRevision: mutation === 'revision' ? 2 : 1 }), /可信产物来源/);
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(closure.item_id) as { status: string }).status, 'waiting');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM closure_acknowledgements WHERE task_id = ?').get(taskId) as { count: number }).count, 0);
});

test('native system recovery uses the latest execution failure and resets only its Work Item retry epoch', async () => {
  const { db, taskId, itemId, executionId } = await inputTask();
  await failExecutionWithRetryPolicy(executionId, 'Provider did not accept the context', { kind: 'agent-cli-exit', maxRetries: 0 });
  db.prepare("UPDATE tasks SET resume_status = NULL, current_subagent = 'test-agent' WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE task_lanes SET status = 'completed', current_agent = NULL WHERE task_id = ?").run(taskId);
  await releaseBlock(taskId);
  const work = (await inspectTaskDispatchEnvelope(taskId))[0];
  assert.equal(work.workItemId, itemId);
  assert.equal(work.agent, 'backlog-agent');
  assert.equal(work.workItemEpoch, 2);
  await releaseBlock(taskId);
  assert.equal((db.prepare('SELECT dispatch_epoch FROM workflow_items WHERE item_id = ?').get(itemId) as { dispatch_epoch: number }).dispatch_epoch, 2);
  const event = db.prepare("SELECT payload_json, authority FROM workflow_item_events WHERE item_id = ? AND event_key = ?")
    .get(itemId, `human-unblock:${executionId}`) as { payload_json: string; authority: string };
  assert.equal(event.authority, 'human');
  assert.match(event.payload_json, /Provider did not accept the context/);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM execution_attempts WHERE execution_id = ? AND status = ?')
    .get(executionId, 'system_blocked') as { count: number }).count, 1, 'old failure evidence remains intact');
});

for (const interrupted of [false, true]) test(`native ${interrupted ? 'Runner interruption' : 'CLI failure'} settles its graph immediately without writing a legacy task block`, async () => {
  const { db, taskId, itemId, executionId } = await inputTask();
  if (interrupted) {
    db.prepare('UPDATE execution_attempts SET attempt = 5 WHERE execution_id = ?').run(executionId);
    const execution = db.prepare('SELECT run_id FROM execution_attempts WHERE execution_id = ?').get(executionId) as { run_id: string };
    await reconcileInterruptedExecutions(execution.run_id, 'Runner lost its heartbeat');
  } else await failExecutionWithRetryPolicy(executionId, 'CLI transport failed', { kind: 'agent-cli-exit', maxRetries: 0 });
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(itemId) as { status: string }).status, 'waiting');
  assert.deepEqual(db.prepare('SELECT agile_status, run_state, resume_status FROM tasks WHERE task_id = ?').get(taskId),
    { agile_status: 'backlog', run_state: 'waiting_for_runtime_input', resume_status: null });
  const recovery = db.prepare(`SELECT source_execution_id, item_id, status, resolver_strategy, authority, max_system_attempts
    FROM interventions WHERE task_id = ? AND dedupe_key = ?`).get(taskId, `native:execution-failure:${executionId}`);
  assert.deepEqual(recovery, { source_execution_id: executionId, item_id: itemId, status: 'pending',
    resolver_strategy: 'system_then_human', authority: 'arbitration', max_system_attempts: 3 });
  assert.deepEqual(await inspectTaskDispatchEnvelope(taskId), []);
  const events = db.prepare("SELECT * FROM workflow_item_events WHERE item_id = ? AND event_key = ?").all(itemId, `execution-settled:${executionId}`);
  assert.equal(events.length, 1);
  await releaseBlock(taskId);
  const work = (await inspectTaskDispatchEnvelope(taskId))[0];
  assert.equal(work.workItemId, itemId);
  assert.equal(work.workItemEpoch, 2);
  assert.equal((db.prepare('SELECT status FROM execution_attempts WHERE execution_id = ?').get(executionId) as { status: string }).status, 'system_blocked');
  assert.deepEqual(db.prepare('SELECT status, resolved_by FROM interventions WHERE source_execution_id = ?').get(executionId),
    { status: 'resolved', resolved_by: 'human' });
});

test('native retryable failure releases the same Work Item without resetting its retry epoch', async () => {
  const { db, taskId, itemId, executionId } = await inputTask();
  await failExecutionWithRetryPolicy(executionId, 'Transient unknown provider error', { kind: 'agent-cli-exit', maxRetries: 4 });
  assert.deepEqual(db.prepare('SELECT status, dispatch_epoch FROM workflow_items WHERE item_id = ?').get(itemId),
    { status: 'ready', dispatch_epoch: 1 });
  assert.equal((db.prepare('SELECT run_state FROM tasks WHERE task_id = ?').get(taskId) as { run_state: string }).run_state, 'runnable');
  assert.equal((db.prepare('SELECT status FROM execution_attempts WHERE execution_id = ?').get(executionId) as { status: string }).status, 'retryable_failed');
});

test('an old blocked label alone cannot manufacture a native retry-budget reset', async () => {
  const { db, taskId, itemId } = await inputTask();
  db.prepare("UPDATE tasks SET agile_status = 'blocked', resume_status = 'backlog', run_state = 'system_blocked' WHERE task_id = ?").run(taskId);
  await assert.rejects(releaseBlock(taskId), /没有可恢复/);
  assert.equal((db.prepare('SELECT dispatch_epoch FROM workflow_items WHERE item_id = ?').get(itemId) as { dispatch_epoch: number }).dispatch_epoch, 1);
});
