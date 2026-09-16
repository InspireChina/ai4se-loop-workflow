import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { agentResultSchema } from '../domain/agent-result';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
import { createTask, saveDeliverySpec, upsertDocument, addDocumentComment, getTask,
  answerQuestion, submitClarificationAnswers, type DelegationEnvelope } from '../test/legacy-task-fixtures';
import { adoptNativeWorkflowInDb, appendDeliveryWorkItemsInDb, rewindWorkItemsInDb } from './work-item-transitions';
import { adoptFeedbackWorkItemsInDb, attachFeedbackUnitsInDb, feedbackSourceItemInDb } from './work-item-feedback';
import { applyAgentResult } from './agent-results';
import { completeExecution, markExecutionOutput } from './executions';
import { publishReviewReport } from './review-report-publication';
import { finalizeTaskAfterFeedbackInDb } from './feedback';

async function setup(native = true) {
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET is_paused = 1, agile_status = 'cancelled' WHERE agile_status NOT IN ('done', 'cancelled')").run();
  const taskId = await createTask({ title: 'Frozen Feedback work graph' });
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Original unit', 'story-001')").run(taskId);
  db.prepare('UPDATE tasks SET total_stories = 1 WHERE task_id = ?').run(taskId);
  await saveDeliverySpec({ taskId, storyIndex: 1, status: 'resolved', spec: deliverySpecFixture() });
  const documentId = await upsertDocument({ taskId, actor: 'review-agent', kind: 'review_v1', title: 'Original closure report', content: 'Original facts', format: 'markdown' });
  db.prepare(`UPDATE tasks SET agile_status = 'ready_to_close', current_subagent = NULL, run_state = 'idle',
    total_stories = 1, analysis_index = 1, spec_resolved_index = 1, dev_index = 1, test_index = 1,
    closure_status = 'awaiting_read', review_document_id = ?, review_revision = 1 WHERE task_id = ?`).run(documentId, taskId);
  if (native) adoptNativeWorkflowInDb(db, taskId);
  async function comment(content: string) {
    return addDocumentComment({ taskId, documentId, anchorType: 'file', intent: 'change_request', content });
  }
  return { db, taskId, documentId, comment };
}
async function delegation(taskId: string, pipeline: string) {
  const work = (await inspectTaskDispatchEnvelope(taskId)).find((item) => item.pipeline === pipeline);
  assert.ok(work, `Missing ${pipeline}`);
  return work;
}
async function apply(work: DelegationEnvelope, value: Record<string, unknown>) {
  const result = agentResultSchema.parse(value);
  const started = await beginTestExecutionAttempt({ runId: `RUN-${randomUUID()}`, delegation: work, prompt: 'Frozen Feedback test' });
  const executionId = started.attempt.execution_id;
  await markExecutionOutput(executionId, result);
  const outcome = await applyAgentResult(`RUN-${randomUUID()}`, work, result, { executionId });
  if (outcome === 'advanced' || result.outcome === 'needs_input') await completeExecution(executionId);
  return { executionId, outcome };
}
async function triage(taskId: string, ids: string[], workType = 'report_correction') {
  const work = await delegation(taskId, 'feedback-triage');
  const applied = await apply(work, { outcome: 'completed', summary: 'Frozen forward Feedback group', feedback: { mode: 'triage',
    groups: [{ groupKey: 'frozen-group', commentIds: ids, workType, title: 'Clarify reported boundary', affectedDeliveryUnits: [1],
      reason: 'Preserve original facts and change only the declared scope', acceptance: ['Boundary explicitly documented'] }] } });
  assert.equal(applied.outcome, 'advanced');
  return work;
}

test('appended feedback binds its replacement Review to verification and cold repair never re-adopts old terminal states', async () => {
  const { db, taskId, comment } = await setup();
  await triage(taskId, [await comment('Add permanent constructor regression guards')], 'technical_change');
  const split = await delegation(taskId, 'feedback-split');
  appendDeliveryWorkItemsInDb(db, { taskId, units: [{ storyIndex: 2, title: 'Permanent guards' }],
    eventKey: 'fixture:append-feedback', actor: 'story-splitter-agent', reason: 'Append the frozen requested guards' });
  attachFeedbackUnitsInDb(db, taskId, split.feedbackGroupId!, [2]);
  const review = db.prepare("SELECT item_id, status FROM workflow_items WHERE task_id = ? AND work_key = 'delivery:review' AND status != 'superseded'")
    .get(taskId) as { item_id: string; status: string };
  const verify = db.prepare("SELECT item_id FROM workflow_items WHERE task_id = ? AND pipeline = 'feedback-verify'")
    .get(taskId) as { item_id: string };
  const barrier = () => db.prepare('SELECT 1 FROM workflow_dependencies WHERE item_id = ? AND depends_on_item_id = ?').get(review.item_id, verify.item_id);
  assert.ok(barrier());
  assert.equal(review.status, 'pending');
  db.prepare('DELETE FROM workflow_dependencies WHERE item_id = ? AND depends_on_item_id = ?').run(review.item_id, verify.item_id);
  db.prepare("UPDATE feedback_batches SET status = 'cancelled' WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE feedback_groups SET status = 'completed' WHERE group_id = ?").run(split.feedbackGroupId);
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId);
  adoptFeedbackWorkItemsInDb(db, taskId);
  assert.ok(barrier());
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId), graph);
  assert.ok(!(await inspectTaskDispatchEnvelope(taskId)).some(work => work.pipeline === 'review'));
});

test('native Feedback dispatch and result authority do not consult mutable batch/group status or Lane cursors', async () => {
  const { db, taskId, comment } = await setup();
  const id = await comment('Clarify forward scope');
  await triage(taskId, [id], 'behavior_change');
  const before = await delegation(taskId, 'feedback-split');
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId);
  db.prepare("UPDATE feedback_batches SET status = 'cancelled' WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE feedback_groups SET status = 'completed' WHERE batch_id = ?").run(before.feedbackBatchId);
  db.prepare("UPDATE feedback_batches SET last_error = 'FAKE old error' WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE task_lanes SET status = 'system_blocked', current_agent = NULL WHERE task_id = ?").run(taskId);
  const after = await delegation(taskId, 'feedback-split');
  assert.equal(after.workItemId, before.workItemId);
  const projected = await getTask(taskId);
  assert.equal(projected?.feedbackBatches[0].status, 'executing');
  assert.equal(projected?.feedbackBatches[0].last_error, null);
  assert.equal(projected?.feedbackGroups[0].status, 'waiting_for_plan');
  assert.equal(projected?.feedbackGroups[0].completed_at, null);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId), graph);
  const started = await beginTestExecutionAttempt({ runId: 'RUN-frozen-status', delegation: after, prompt: 'Frozen binding' });
  assert.ok(feedbackSourceItemInDb(db, { taskId, batchId: after.feedbackBatchId!, groupId: after.feedbackGroupId!,
    executionId: started.attempt.execution_id, pipeline: 'feedback-split' }));
  assert.throws(() => feedbackSourceItemInDb(db, { taskId, batchId: 'Wrong batch', executionId: started.attempt.execution_id, pipeline: 'feedback-split' }), /归属不一致/);
  assert.throws(() => feedbackSourceItemInDb(db, { taskId, executionId: started.attempt.execution_id, pipeline: 'feedback-verify' }), /有效来源执行/);
});

test('each frozen comment has its own sequential verification Work Item and no early closure', async () => {
  const { db, taskId, comment } = await setup();
  const ids = [await comment('Clarify offline boundary'), await comment('Clarify browser boundary')];
  await triage(taskId, ids);
  const report = await delegation(taskId, 'feedback-report');
  assert.equal((await apply(report, { outcome: 'completed', summary: 'Updated declared boundaries', verdict: 'report_ready',
    artifact: { title: 'Closure report v2', content: '# Boundaries\nOffline and browser boundaries explicitly documented.' } })).outcome, 'advanced');
  const first = await delegation(taskId, 'feedback-verify');
  assert.deepEqual(first.feedbackIds?.slice().sort(), ids.slice().sort());
  const otherId = ids.find((id) => id !== first.feedbackId)!;
  assert.equal((await inspectTaskDispatchEnvelope(taskId)).filter((item) => item.pipeline === 'feedback-verify').length, 1);
  await apply(first, { outcome: 'completed', summary: 'First declared boundary observed', feedback: { mode: 'verify',
    commentId: first.feedbackId, verdict: 'resolved', reason: 'Observed in v2 report', evidence: ['Closure report v2'] } });
  assert.notEqual((await getTask(taskId))?.task.agile_status, 'ready_to_close');
  const second = await delegation(taskId, 'feedback-verify');
  assert.equal(second.feedbackId, otherId);
  assert.notEqual(second.workItemId, first.workItemId);
  db.prepare("UPDATE feedback_groups SET status = 'cancelled' WHERE batch_id = ?").run(second.feedbackBatchId);
  db.prepare("UPDATE feedback_batches SET status = 'cancelled' WHERE task_id = ?").run(taskId);
  await apply(second, { outcome: 'completed', summary: 'Second declared boundary observed', feedback: { mode: 'verify',
    commentId: second.feedbackId, verdict: 'resolved', reason: 'Observed in v2 report', evidence: ['Closure report v2'] } });
  assert.equal((await getTask(taskId))?.task.agile_status, 'ready_to_close');
  assert.equal((await getTask(taskId))?.feedbackGroups[0].status, 'completed');
  assert.equal((await getTask(taskId))?.feedbackBatches[0].status, 'completed');
  assert.equal((await getTask(taskId))?.task.review_revision, 2);
  assert.ok((await getTask(taskId))?.task.review_document_id);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workflow_items WHERE task_id = ? AND pipeline = 'feedback-verify' AND status = 'completed'")
    .get(taskId) as { count: number }).count, 2);
});

test('native Feedback finalization preserves artifact lineage and cannot manufacture reading readiness from a poisoned report', async () => {
  const { db, taskId, comment } = await setup();
  const id = await comment('Clarify declared boundaries');
  await triage(taskId, [id]);
  await apply(await delegation(taskId, 'feedback-report'), { outcome: 'completed', summary: 'Updated report', verdict: 'report_ready',
    artifact: { title: 'Verified report', content: '# Boundaries\nObserved declared boundaries.' } });
  const verify = await delegation(taskId, 'feedback-verify');
  await apply(verify, { outcome: 'completed', summary: 'Boundary observed', feedback: { mode: 'verify', commentId: id,
    verdict: 'resolved', reason: 'Observed in the revised report', evidence: ['Revised report'] } });
  const head = db.prepare('SELECT review_document_id, review_revision FROM tasks WHERE task_id = ?').get(taskId) as
    { review_document_id: string; review_revision: number };
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId);
  const events = db.prepare('SELECT * FROM workflow_item_events WHERE item_id IN (SELECT item_id FROM workflow_items WHERE task_id = ?) ORDER BY event_id').all(taskId);
  const document = db.prepare('SELECT content FROM documents WHERE document_id = ?').get(head.review_document_id) as { content: string };
  db.prepare("UPDATE documents SET content = 'Changed outside artifact publication' WHERE document_id = ?").run(head.review_document_id);
  finalizeTaskAfterFeedbackInDb(db, taskId, verify.feedbackBatchId!);
  const poisoned = db.prepare('SELECT review_document_id, review_revision, closure_status, next_step FROM tasks WHERE task_id = ?').get(taskId) as
    { review_document_id: string; review_revision: number; closure_status: string; next_step: string };
  assert.equal(poisoned.review_document_id, head.review_document_id);
  assert.equal(poisoned.review_revision, head.review_revision);
  assert.notEqual(poisoned.closure_status, 'awaiting_read');
  assert.match(poisoned.next_step, /可信最终文档/);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(taskId), graph);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_item_events WHERE item_id IN (SELECT item_id FROM workflow_items WHERE task_id = ?) ORDER BY event_id').all(taskId), events);
  db.prepare('UPDATE documents SET content = ? WHERE document_id = ?').run(document.content, head.review_document_id);
  finalizeTaskAfterFeedbackInDb(db, taskId, verify.feedbackBatchId!);
  assert.equal((await getTask(taskId))?.task.closure_status, 'awaiting_read');
});

test('a new comment is not admitted into an active frozen batch even if its legacy status is changed', async () => {
  const { db, taskId, comment } = await setup();
  const first = await comment('Frozen first boundary');
  const work = await delegation(taskId, 'feedback-triage');
  const next = await comment('Later boundary');
  db.prepare("UPDATE feedback_batches SET status = 'completed' WHERE task_id = ?").run(taskId);
  const same = await delegation(taskId, 'feedback-triage');
  assert.equal(same.workItemId, work.workItemId);
  assert.deepEqual(same.feedbackIds, [first]);
  assert.ok(!same.feedbackIds?.includes(next));
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM feedback_batches WHERE task_id = ?').get(taskId) as { count: number }).count, 1);
});

test('historical Feedback adoption rebinds waiting human inputs and old execution evidence once', async () => {
  const { db, taskId, comment } = await setup(false);
  const id = await comment('Reproduce Windows save failure');
  await triage(taskId, [id], 'bug');
  const repro = await delegation(taskId, 'feedback-repro');
  const first = await apply(repro, { outcome: 'needs_input', summary: 'Need exact Windows version', reproVerdict: 'not_reproduced',
    artifact: { title: 'Reproduction attempt', content: 'Exact operating system version is missing' },
    questions: [{ title: 'Windows version', question: 'Which Windows version?', why: 'Match runtime', recommendation: 'Provide exact version' }] });
  adoptNativeWorkflowInDb(db, taskId);
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId);
  adoptFeedbackWorkItemsInDb(db, taskId);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId), graph);
  const question = (await getTask(taskId))!.questions.find((item) => item.source_agent === 'repro-agent')!;
  const bound = db.prepare('SELECT item_id FROM interventions WHERE intervention_id = ?').get(question.intervention_id) as { item_id: string };
  assert.ok(bound.item_id);
  assert.equal((db.prepare('SELECT work_item_id FROM execution_attempts WHERE execution_id = ?').get(first.executionId) as { work_item_id: string }).work_item_id, bound.item_id);
  assert.ok((db.prepare('SELECT work_item_attempt FROM execution_attempts WHERE execution_id = ?').get(first.executionId) as { work_item_attempt: number }).work_item_attempt > 0);
  await answerQuestion({ taskId, questionId: question.question_id, answer: 'Windows 11 24H2' });
  await submitClarificationAnswers(taskId);
  const resumed = await delegation(taskId, 'feedback-repro');
  assert.equal(resumed.workItemId, bound.item_id);
  assert.equal(resumed.feedbackBatchId, repro.feedbackBatchId);
  assert.equal(resumed.feedbackGroupId, repro.feedbackGroupId);
});

async function historicalReport() {
  const fixture = await setup(false);
  const commentId = await fixture.comment('Historical report execution');
  await triage(fixture.taskId, [commentId]);
  const work = await delegation(fixture.taskId, 'feedback-report');
  const input = JSON.stringify({ delegation: work, historicalContext: 'retain verbatim' });
  function insert(status: string, generation = 'feedback-old-current') {
    const id = randomUUID();
    fixture.db.prepare(`INSERT INTO execution_attempts(execution_id, run_id, task_id, agent, pipeline, lane,
      story_index, delegation_key, attempt, status, input_hash, input_json, result_json,
      dispatch_generation_key, dispatch_retry_consumed)
      VALUES(?, 'RUN-history', ?, ?, ?, 'control', ?, ?, 1, ?, 'original-feedback-hash', ?,
        '{"historicalResult":"retain verbatim"}', ?, 0)`)
      .run(id, fixture.taskId, work.agent, work.pipeline, work.storyIndex, id, status, input, generation);
    return id;
  }
  return { ...fixture, work, insert };
}

test('partial historical Feedback binding repair preserves the graph and does not guess new unbound ownership', async () => {
  const { db, taskId, insert, work } = await historicalReport();
  adoptNativeWorkflowInDb(db, taskId);
  const item = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? AND work_key = ?')
    .get(taskId, `feedback:report:${work.feedbackGroupId}`) as { item_id: string };
  const failed = insert('retryable_failed');
  const running = insert('running');
  const unbound = insert('output_received', 'untrusted-new-generation');
  db.prepare('UPDATE execution_attempts SET work_item_id = ? WHERE execution_id IN (?, ?)').run(item.item_id, failed, running);
  db.prepare("UPDATE feedback_batches SET status = 'cancelled' WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE feedback_groups SET status = 'completed' WHERE group_id = ?").run(work.feedbackGroupId);
  const input = db.prepare('SELECT input_json, result_json, status FROM execution_attempts WHERE execution_id = ?').get(running);
  adoptFeedbackWorkItemsInDb(db, taskId);
  const rows = db.prepare('SELECT work_item_id, work_item_attempt, dispatch_generation_key FROM execution_attempts WHERE execution_id IN (?, ?) ORDER BY work_item_attempt')
    .all(failed, running) as { work_item_id: string; work_item_attempt: number; dispatch_generation_key: string }[];
  assert.deepEqual(rows.map((row) => row.work_item_attempt), [1, 2]);
  assert.equal(rows[0].dispatch_generation_key, rows[1].dispatch_generation_key);
  assert.notEqual(rows[0].dispatch_generation_key, 'feedback-old-current');
  assert.equal((db.prepare('SELECT work_item_id FROM execution_attempts WHERE execution_id = ?').get(unbound) as { work_item_id: string | null }).work_item_id, null);
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(item.item_id) as { status: string }).status, 'running');
  assert.deepEqual(db.prepare('SELECT input_json, result_json, status FROM execution_attempts WHERE execution_id = ?').get(running), input);
  const after = db.prepare('SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY rowid').all(taskId);
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId);
  adoptFeedbackWorkItemsInDb(db, taskId);
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY rowid').all(taskId), after);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId), graph);
});

for (const mismatch of ['agent', 'pipeline']) test(`partial Feedback repair rejects mismatched already-bound ${mismatch} and rolls back identity edits`, async () => {
  const { db, taskId, insert, work } = await historicalReport();
  adoptNativeWorkflowInDb(db, taskId);
  const item = db.prepare('SELECT item_id FROM workflow_items WHERE task_id = ? AND work_key = ?')
    .get(taskId, `feedback:report:${work.feedbackGroupId}`) as { item_id: string };
  const id = insert('running');
  db.prepare(`UPDATE execution_attempts SET work_item_id = ?, ${mismatch} = ? WHERE execution_id = ?`)
    .run(item.item_id, mismatch === 'agent' ? 'test-agent' : 'feedback-verify', id);
  const before = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(id);
  assert.throws(() => adoptFeedbackWorkItemsInDb(db, taskId), /归属不一致/);
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(id), before);
});

for (const status of ['running', 'output_received', 'verifying', 'applying']) {
  test(`historical Feedback ${status} retains snapshots and current retry generation through adoption`, async () => {
    const { db, taskId, insert, work } = await historicalReport();
    const old = insert('retryable_failed', 'feedback-previous-generation');
    const failed = insert('retryable_failed');
    const live = insert(status);
    const before = db.prepare('SELECT input_hash, input_json, result_json, status FROM execution_attempts WHERE execution_id = ?').get(live);
    adoptNativeWorkflowInDb(db, taskId);
    const item = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? AND work_key = ?')
      .get(taskId, `feedback:report:${work.feedbackGroupId}`) as { item_id: string; status: string; dispatch_epoch: number };
    assert.equal(item.status, 'running');
    assert.equal(item.dispatch_epoch, 1);
    const rows = db.prepare('SELECT work_item_id, work_item_attempt, dispatch_generation_key, dispatch_retry_consumed FROM execution_attempts WHERE execution_id IN (?, ?, ?) ORDER BY work_item_attempt')
      .all(old, failed, live) as { work_item_id: string; work_item_attempt: number; dispatch_generation_key: string; dispatch_retry_consumed: number }[];
    assert.deepEqual(rows.map((row) => row.work_item_attempt), [1, 2, 3]);
    assert.ok(rows.every((row) => row.work_item_id === item.item_id));
    assert.equal(rows[0].dispatch_generation_key, 'feedback-previous-generation');
    assert.equal(rows[0].dispatch_retry_consumed, 0, 'historical binding must not recharge an unrelated retry generation');
    assert.equal(rows[1].dispatch_retry_consumed, 1);
    assert.equal(rows[1].dispatch_generation_key, rows[2].dispatch_generation_key);
    assert.notEqual(rows[1].dispatch_generation_key, 'feedback-old-current');
    assert.deepEqual(db.prepare('SELECT input_hash, input_json, result_json, status FROM execution_attempts WHERE execution_id = ?').get(live), before);
    const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId);
    const executions = db.prepare('SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY rowid').all(taskId);
    adoptFeedbackWorkItemsInDb(db, taskId);
    assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId), graph);
    assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY rowid').all(taskId), executions);
  });
}

for (const status of ['planned', 'running', 'output_received']) {
  test(`cancelled historical Feedback cancels its ${status} execution without creating runnable obligations`, async () => {
    const { db, taskId, insert } = await historicalReport();
    const id = insert(status);
    const before = db.prepare('SELECT input_hash, input_json, result_json FROM execution_attempts WHERE execution_id = ?').get(id);
    db.prepare("UPDATE feedback_batches SET status = 'cancelled' WHERE task_id = ?").run(taskId);
    db.prepare("UPDATE feedback_groups SET status = 'cancelled' WHERE batch_id IN (SELECT batch_id FROM feedback_batches WHERE task_id = ?)").run(taskId);
    adoptNativeWorkflowInDb(db, taskId);
    const row = db.prepare(`SELECT execution.status, dispatch_retry_consumed, work_item_attempt, item.status AS item_status
      FROM execution_attempts execution JOIN workflow_items item ON item.item_id = execution.work_item_id WHERE execution_id = ?`)
      .get(id) as { status: string; dispatch_retry_consumed: number; work_item_attempt: number; item_status: string };
    assert.equal(row.status, 'cancelled');
    assert.equal(row.item_status, 'cancelled');
    assert.equal(row.dispatch_retry_consumed, 0);
    assert.ok(row.work_item_attempt > 0);
    assert.deepEqual(db.prepare('SELECT input_hash, input_json, result_json FROM execution_attempts WHERE execution_id = ?').get(id), before);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workflow_items WHERE task_id = ? AND kind = 'feedback' AND status NOT IN ('completed', 'cancelled', 'superseded')")
      .get(taskId) as { count: number }).count, 0);
  });
}

test('ambiguous historical Feedback ownership rolls back the whole task adoption', async () => {
  const { db, taskId, insert } = await historicalReport();
  insert('running');
  insert('applying');
  const before = db.prepare('SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY rowid').all(taskId);
  assert.throws(() => adoptNativeWorkflowInDb(db, taskId), /多个历史活动执行/);
  assert.equal((db.prepare('SELECT workflow_engine FROM tasks WHERE task_id = ?').get(taskId) as { workflow_engine: string }).workflow_engine, 'legacy');
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY rowid').all(taskId), before);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workflow_items WHERE task_id = ? AND kind = 'feedback'").get(taskId) as { count: number }).count, 0);
});

test('versioned Feedback rewind preserves frozen context and rejects late source execution', async () => {
  const { db, taskId, comment } = await setup();
  const id = await comment('Declared report boundary');
  await triage(taskId, [id]);
  const report = await delegation(taskId, 'feedback-report');
  const started = await beginTestExecutionAttempt({ runId: 'RUN-before-feedback-rewind', delegation: report, prompt: 'Old report source' });
  const old = db.prepare('SELECT context_json FROM workflow_items WHERE item_id = ?').get(report.workItemId) as { context_json: string };
  rewindWorkItemsInDb(db, { taskId, targetItemId: report.workItemId!, eventKey: 'replace-feedback-report', actor: 'human', authority: 'human', reason: 'Reconsider declared boundary' });
  const replacement = await delegation(taskId, 'feedback-report');
  assert.notEqual(replacement.workItemId, report.workItemId);
  assert.equal((db.prepare('SELECT context_json FROM workflow_items WHERE item_id = ?').get(replacement.workItemId) as { context_json: string }).context_json, old.context_json);
  assert.throws(() => feedbackSourceItemInDb(db, { taskId, executionId: started.attempt.execution_id, pipeline: 'feedback-report' }), /有效来源执行/);
});

test('report correction waits for every non-report group verification in the same batch', async () => {
  const { db, taskId, comment } = await setup();
  const reportId = await comment('Clarify the updated report');
  const changeId = await comment('Add a user-visible behavior');
  const work = await delegation(taskId, 'feedback-triage');
  await apply(work, { outcome: 'completed', summary: 'Report must reflect the forward change', feedback: { mode: 'triage', groups: [
    { groupKey: 'report-first', commentIds: [reportId], workType: 'report_correction', title: 'Final report', affectedDeliveryUnits: [1],
      reason: 'Describe the implemented change', acceptance: ['Report accurately reflects behavior'] },
    { groupKey: 'forward-second', commentIds: [changeId], workType: 'behavior_change', title: 'Forward behavior', affectedDeliveryUnits: [1],
      reason: 'Implement the user-visible behavior', acceptance: ['Behavior independently observed'] },
  ] } });
  const lines = await inspectTaskDispatchEnvelope(taskId);
  assert.ok(lines.some((item) => item.pipeline === 'feedback-split'));
  assert.ok(!lines.some((item) => item.pipeline === 'feedback-report'));
  const barrier = db.prepare(`SELECT 1 FROM workflow_dependencies dependency
    JOIN workflow_items report ON report.item_id = dependency.item_id
    JOIN workflow_items verification ON verification.item_id = dependency.depends_on_item_id
    WHERE report.task_id = ? AND report.pipeline = 'feedback-report' AND verification.pipeline = 'feedback-verify'
      AND json_extract(report.context_json, '$.feedbackGroupId') != json_extract(verification.context_json, '$.feedbackGroupId')`).get(taskId);
  assert.ok(barrier);
});

test('cancelled historical Feedback is captured without creating new obligations', async () => {
  const { db, taskId, comment } = await setup(false);
  const id = await comment('Cancelled old feedback');
  const work = await delegation(taskId, 'feedback-triage');
  await triage(taskId, [id], 'bug');
  db.prepare("UPDATE feedback_batches SET status = 'cancelled' WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE feedback_groups SET status = 'cancelled' WHERE batch_id = ?").run(work.feedbackBatchId);
  adoptNativeWorkflowInDb(db, taskId);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workflow_items WHERE task_id = ? AND kind = 'feedback' AND status NOT IN ('completed', 'cancelled', 'superseded')")
    .get(taskId) as { count: number }).count, 0);
});

test('historical terminal dates are captured once, never replaced by adoption time or old mutable status', async () => {
  const { db, taskId, comment } = await setup(false);
  const id = await comment('Historical finished report correction');
  const work = await triage(taskId, [id]);
  const finished = '2026-08-17 08:13:19';
  db.prepare("UPDATE feedback_batches SET status = 'completed', completed_at = ? WHERE task_id = ?").run(finished, taskId);
  db.prepare("UPDATE feedback_groups SET status = 'completed', completed_at = ? WHERE batch_id = ?").run(finished, work.feedbackBatchId);
  db.prepare("UPDATE document_comments SET status = 'resolved', feedback_status = 'resolved' WHERE comment_id = ?").run(id);
  adoptNativeWorkflowInDb(db, taskId);
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId);
  db.prepare("UPDATE feedback_batches SET status = 'triaging', completed_at = NULL WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE feedback_groups SET status = 'planned', completed_at = NULL WHERE batch_id = ?").run(work.feedbackBatchId);
  adoptFeedbackWorkItemsInDb(db, taskId);
  const projected = await getTask(taskId);
  assert.equal(projected?.feedbackBatches[0].status, 'completed');
  assert.equal(projected?.feedbackBatches[0].completed_at, finished);
  assert.equal(projected?.feedbackGroups[0].status, 'completed');
  assert.equal(projected?.feedbackGroups[0].completed_at, finished);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId), graph);
});

test('immediate reply completion is read from frozen triage metadata, not mutable group type', async () => {
  const { db, taskId, comment } = await setup();
  const id = await comment('Explain the existing boundary');
  const work = await delegation(taskId, 'feedback-triage');
  await apply(work, { outcome: 'completed', summary: 'Explanation only', feedback: { mode: 'triage', groups: [{
    groupKey: 'reply', commentIds: [id], workType: 'reply', affectedDeliveryUnits: [1], reason: 'No behavior changes needed',
    acceptance: [], response: 'The report describes the existing boundary accurately.' }] } });
  db.prepare("UPDATE feedback_groups SET status = 'planned', work_type = 'bug', completed_at = NULL WHERE batch_id = ?").run(work.feedbackBatchId);
  db.prepare("UPDATE feedback_batches SET status = 'triaging', completed_at = NULL WHERE task_id = ?").run(taskId);
  const projected = await getTask(taskId);
  assert.equal(projected?.feedbackGroups[0].status, 'completed');
  assert.ok(projected?.feedbackGroups[0].completed_at);
  assert.equal(projected?.feedbackBatches[0].status, 'completed');
});

test('reopened verification read model uses the completed Work Item receipt, not mutable comments or group status', async () => {
  const { db, taskId, comment } = await setup();
  const id = await comment('Clarify the disputed boundary');
  const triaged = await triage(taskId, [id]);
  await apply(await delegation(taskId, 'feedback-report'), { outcome: 'completed', summary: 'Updated disputed boundary', verdict: 'report_ready',
    artifact: { title: 'Disputed boundary report', content: '# Boundary\nUpdated wording.' } });
  const verification = await delegation(taskId, 'feedback-verify');
  await apply(verification, { outcome: 'completed', summary: 'The boundary remains incorrect', feedback: { mode: 'verify', commentId: id,
    verdict: 'reopened', reason: 'Observed wording contradicts the request', evidence: ['Report content reviewed'] } });
  db.prepare("UPDATE feedback_groups SET status = 'completed' WHERE batch_id = ?").run(triaged.feedbackBatchId);
  db.prepare("UPDATE document_comments SET verification_json = NULL WHERE comment_id = ?").run(id);
  const projected = await getTask(taskId);
  assert.equal(projected?.feedbackGroups.find((group) => group.batch_id === triaged.feedbackBatchId)?.status, 'reopened');
  assert.ok(db.prepare("SELECT 1 FROM execution_receipts WHERE kind = 'feedback_verification' AND json_extract(payload_json, '$.verdict') = 'reopened'").get());
});

async function pendingReport(work: DelegationEnvelope) {
  const db = await databaseConnection();
  const result = agentResultSchema.parse({ outcome: 'completed', summary: 'Report reflects independently established facts',
    verdict: 'report_ready', artifact: { title: 'Audited report', content: '# Verified facts\nDeclared boundaries are explicit.' } });
  const started = await beginTestExecutionAttempt({ runId: `RUN-${randomUUID()}`, delegation: work, prompt: 'Atomic publication' });
  const executionId = started.attempt.execution_id;
  await markExecutionOutput(executionId, result);
  const resultId = randomUUID();
  db.prepare(`INSERT INTO agent_results(result_id, run_id, task_id, agent, pipeline, outcome, result_json, application_status, execution_id)
    VALUES(?, ?, ?, 'review-agent', ?, 'completed', ?, 'pending', ?)`)
    .run(resultId, `RUN-${randomUUID()}`, work.taskId, work.pipeline, JSON.stringify(result), executionId);
  return { delegation: work, result, resultId, executionId };
}

for (const feedback of [false, true]) for (const staleStatus of ['in plan', 'done', 'cancelled', 'blocked']) test(`native ${feedback ? 'Feedback' : 'main'} report publication is atomic and ignores old ${staleStatus} fields`, async () => {
  const { db, taskId, comment } = await setup();
  if (feedback) {
    await triage(taskId, [await comment('Clarify the final report')]);
  } else {
    const review = db.prepare("SELECT item_id FROM workflow_items WHERE task_id = ? AND work_key = 'delivery:review' AND status = 'completed'")
      .get(taskId) as { item_id: string };
    rewindWorkItemsInDb(db, { taskId, targetItemId: review.item_id, eventKey: 'new-main-report', actor: 'human', authority: 'human', reason: 'Reconcile final report facts' });
  }
  const work = await delegation(taskId, feedback ? 'feedback-report' : 'review');
  const input = await pendingReport(work);
  db.prepare(`UPDATE tasks SET agile_status = 'in plan', current_subagent = 'backlog-agent', total_stories = 99,
    analysis_index = 0, dev_index = 0, test_index = 0, spec_resolved_index = 0, closure_status = 'none', run_state = 'waiting_for_answers' WHERE task_id = ?`).run(taskId);
  db.prepare('UPDATE tasks SET agile_status = ? WHERE task_id = ?').run(staleStatus, taskId);
  if (feedback) {
    db.prepare("UPDATE feedback_batches SET status = 'cancelled' WHERE task_id = ?").run(taskId);
    db.prepare("UPDATE feedback_groups SET status = 'cancelled' WHERE batch_id = ?").run(work.feedbackBatchId);
  }
  assert.equal(await publishReviewReport(input), 'advanced');
  const item = db.prepare('SELECT status, completion_reason FROM workflow_items WHERE item_id = ?').get(work.workItemId) as { status: string; completion_reason: string };
  assert.equal(item.status, 'completed');
  assert.equal(item.completion_reason, input.result.summary);
  assert.equal((db.prepare('SELECT application_status FROM agent_results WHERE result_id = ?').get(input.resultId) as { application_status: string }).application_status, 'applied');
  const receipt = db.prepare("SELECT payload_json FROM execution_receipts WHERE execution_id = ? AND kind = 'work_item_artifact'")
    .get(input.executionId) as { payload_json: string };
  const artifact = JSON.parse(receipt.payload_json) as { documentId: string; itemId: string };
  assert.equal(artifact.itemId, work.workItemId);
  assert.ok(db.prepare('SELECT 1 FROM documents WHERE document_id = ?').get(artifact.documentId));
  assert.equal((await getTask(taskId))?.task.total_stories, 1);
  assert.equal((await getTask(taskId))?.task.agile_status, feedback ? 'in feedback' : 'ready_to_close');
  assert.equal(await applyAgentResult('RUN-restart-applied-report', work, input.result, { executionId: input.executionId }), 'advanced');
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM workflow_item_events WHERE item_id = ? AND event_type = 'complete'")
    .get(work.workItemId) as { count: number }).count, 1);
});

test('native report publication rolls back artifact, receipt and result application if graph completion is blocked', async () => {
  const { db, taskId } = await setup();
  const old = db.prepare("SELECT item_id FROM workflow_items WHERE task_id = ? AND work_key = 'delivery:review' AND status = 'completed'").get(taskId) as { item_id: string };
  rewindWorkItemsInDb(db, { taskId, targetItemId: old.item_id, eventKey: 'blocked-new-report', actor: 'human', authority: 'human', reason: 'New report reconciliation' });
  const work = await delegation(taskId, 'review');
  const input = await pendingReport(work);
  const prerequisite = randomUUID();
  db.prepare(`INSERT INTO workflow_items(item_id, task_id, work_key, revision, kind, title, status, origin)
    VALUES(?, ?, 'extra:report-evidence', 1, 'evidence', 'Required new evidence', 'pending', 'native')`).run(prerequisite, taskId);
  db.prepare('INSERT INTO workflow_dependencies(item_id, depends_on_item_id) VALUES(?, ?)').run(work.workItemId, prerequisite);
  const documents = db.prepare('SELECT * FROM documents WHERE task_id = ? ORDER BY rowid').all(taskId);
  const head = db.prepare('SELECT review_revision, review_document_id FROM tasks WHERE task_id = ?').get(taskId);
  await assert.rejects(publishReviewReport(input), /门禁/);
  assert.deepEqual(db.prepare('SELECT * FROM documents WHERE task_id = ? ORDER BY rowid').all(taskId), documents);
  assert.deepEqual(db.prepare('SELECT review_revision, review_document_id FROM tasks WHERE task_id = ?').get(taskId), head);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM execution_receipts WHERE execution_id = ? AND kind = 'work_item_artifact'")
    .get(input.executionId) as { count: number }).count, 0);
  assert.equal((db.prepare('SELECT application_status FROM agent_results WHERE result_id = ?').get(input.resultId) as { application_status: string }).application_status, 'pending');
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(work.workItemId) as { status: string }).status, 'running');
});

test('normal native result application also bypasses obsolete Feedback report guards', async () => {
  const { db, taskId, comment } = await setup();
  await triage(taskId, [await comment('Clarify report boundary')]);
  const work = await delegation(taskId, 'feedback-report');
  const input = await pendingReport(work);
  db.prepare("UPDATE tasks SET agile_status = 'in plan', current_subagent = 'backlog-agent', closure_status = 'none' WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE feedback_batches SET status = 'cancelled' WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE feedback_groups SET status = 'cancelled' WHERE batch_id = ?").run(work.feedbackBatchId);
  assert.equal(await applyAgentResult('RUN-native-pending-publication', work, input.result, { executionId: input.executionId }), 'advanced');
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(work.workItemId) as { status: string }).status, 'completed');
  assert.equal((await getTask(taskId))?.task.agile_status, 'in feedback');
});

test('cancelled native report execution is discarded without publishing or counting a new failure', async () => {
  const { db, taskId, comment } = await setup();
  await triage(taskId, [await comment('Cancelled pending report')]);
  const work = await delegation(taskId, 'feedback-report');
  const input = await pendingReport(work);
  const documents = db.prepare('SELECT * FROM documents WHERE task_id = ? ORDER BY rowid').all(taskId);
  db.prepare("UPDATE execution_attempts SET status = 'cancelled', dispatch_retry_consumed = 0 WHERE execution_id = ?").run(input.executionId);
  assert.equal(await publishReviewReport(input), 'discarded');
  assert.deepEqual(db.prepare('SELECT * FROM documents WHERE task_id = ? ORDER BY rowid').all(taskId), documents);
  assert.equal((db.prepare('SELECT dispatch_retry_consumed FROM execution_attempts WHERE execution_id = ?').get(input.executionId) as { dispatch_retry_consumed: number }).dispatch_retry_consumed, 0);
});

for (const poison of ['snapshot-json', 'snapshot-revision', 'snapshot-epoch', 'snapshot-head', 'missing-generation', 'caller-revision', 'caller-epoch', 'caller-head'] as const) {
  test(`native report publication rejects ${poison} without changing artifacts or source evidence`, async () => {
    const { db, taskId, comment } = await setup();
    await triage(taskId, [await comment('Check exact publication lineage')]);
    const work = await delegation(taskId, 'feedback-report');
    const input = await pendingReport(work);
    const source = db.prepare('SELECT input_json FROM execution_attempts WHERE execution_id = ?')
      .get(input.executionId) as { input_json: string };
    const snapshot = JSON.parse(source.input_json) as { delegation: DelegationEnvelope };
    if (poison === 'snapshot-revision') snapshot.delegation.workItemRevision = 99;
    if (poison === 'snapshot-epoch') snapshot.delegation.workItemEpoch = 99;
    if (poison === 'snapshot-head') snapshot.delegation.reviewRevision = 99;
    if (poison.startsWith('snapshot')) db.prepare('UPDATE execution_attempts SET input_json = ? WHERE execution_id = ?')
      .run(poison === 'snapshot-json' ? '{' : JSON.stringify(snapshot), input.executionId);
    if (poison === 'missing-generation') db.prepare('UPDATE execution_attempts SET dispatch_generation_key = NULL WHERE execution_id = ?').run(input.executionId);
    if (poison === 'caller-revision') input.delegation = { ...work, workItemRevision: 99 };
    if (poison === 'caller-epoch') input.delegation = { ...work, workItemEpoch: 99 };
    if (poison === 'caller-head') {
      input.delegation = { ...work, reviewRevision: 99 };
      db.prepare('UPDATE tasks SET review_revision = 99 WHERE task_id = ?').run(taskId);
    }
    const before = {
      source: db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(input.executionId),
      documents: db.prepare('SELECT * FROM documents WHERE task_id = ? ORDER BY rowid').all(taskId),
      item: db.prepare('SELECT * FROM workflow_items WHERE item_id = ?').get(work.workItemId),
      head: db.prepare('SELECT review_revision, review_document_id FROM tasks WHERE task_id = ?').get(taskId),
    };
    await assert.rejects(publishReviewReport(input), /快照无法读取|不一致|代次已失效|缺少可确认/);
    assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(input.executionId), before.source);
    assert.deepEqual(db.prepare('SELECT * FROM documents WHERE task_id = ? ORDER BY rowid').all(taskId), before.documents);
    assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE item_id = ?').get(work.workItemId), before.item);
    assert.deepEqual(db.prepare('SELECT review_revision, review_document_id FROM tasks WHERE task_id = ?').get(taskId), before.head);
    assert.equal((db.prepare('SELECT application_status FROM agent_results WHERE result_id = ?').get(input.resultId) as { application_status: string }).application_status, 'pending');
  });
}
