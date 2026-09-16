import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { createTaskInDb, createTaskSchema, getTask, upsertDocument, cancelTask, acknowledgeClosure } from './tasks';
import { transitionWorkItemInDb, rewindWorkItemsInDb } from './work-item-transitions';
import { requirementDependencyGateOpenInDb, requirementDependencyCandidatesInDb,
  configureRequirementDependenciesInDb, requirementDeliveryReadyInDb, requirementDependencySatisfied } from './task-dependencies';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import type { WorkflowItemRow } from './work-items';
import { openInterventionInDb } from './interventions';
import { agentResultSchema } from '../domain/agent-result';
import { applyAgentResult } from './agent-results';
import { markExecutionOutput, completeExecution } from './executions';
import { nativeCompletionInDb, nativeWorkflowEndedInDb } from './work-item-controls';

async function native(itemType: 'feature' | 'business-analysis' | 'direct' = 'feature', dependsOnTaskIds: string[] = []) {
  const db = await databaseConnection();
  const task = db.transaction(() => createTaskInDb(db,
    createTaskSchema.parse({ title: `Native dependency ${randomUUID()}`, itemType, dependsOnTaskIds }), `REQ-${randomUUID()}`))();
  return { db, taskId: task.task_id };
}

async function deliveryReady(taskId: string) {
  const db = await databaseConnection();
  // Domain-only fixtures complete the actual graph in dependency order. They
  // are not Agent executions or a substitute for the real UI walkthrough.
  for (;;) {
    const item = db.prepare("SELECT * FROM workflow_items WHERE task_id = ? AND origin = 'native' AND status = 'ready' AND agent IS NOT NULL AND agent NOT IN ('review-agent','spec-review-agent') LIMIT 1")
      .get(taskId) as WorkflowItemRow | undefined;
    if (!item) break;
    transitionWorkItemInDb(db, { itemId: item.item_id, action: 'complete', eventKey: 'fixture:delivery-ready',
      actor: 'human', authority: 'human', reason: 'Complete fixture predecessor in dependency order' });
  }
  const publisher = (await inspectTaskDispatchEnvelope(taskId))[0];
  assert.ok(publisher && ['review-agent', 'spec-review-agent'].includes(publisher.agent));
  const result = agentResultSchema.parse({ outcome: 'completed', summary: 'Fixture final artifact is ready',
    ...(publisher.agent === 'review-agent' ? { verdict: 'report_ready' } : { businessAnalysis: { stage: 'review', disposition: 'approved' } }),
    artifact: { title: 'Actual fixture report', content: 'Report is ready for reading' } });
  const started = await beginTestExecutionAttempt({ runId: `RUN-${randomUUID()}`, delegation: publisher, prompt: 'Domain final artifact fixture' });
  await markExecutionOutput(started.attempt.execution_id, result);
  assert.equal(await applyAgentResult(`RUN-${randomUUID()}`, publisher, result, { executionId: started.attempt.execution_id }), 'advanced');
  await completeExecution(started.attempt.execution_id);
}

for (const type of ['feature', 'business-analysis'] as const) test(`native ${type} prerequisite opens from report-ready Closure before human acknowledgement`, async () => {
  const { db, taskId } = await native(type);
  const dependent = await native('direct', [taskId]);
  db.prepare("UPDATE tasks SET agile_status = 'done', completed_at = '2000-01-01' WHERE task_id = ?").run(taskId);
  assert.equal(requirementDependencyGateOpenInDb(db, dependent.taskId), false);
  assert.equal((await getTask(dependent.taskId))?.dependencies[0].delivery_ready, false);
  assert.equal(requirementDependencySatisfied((await getTask(dependent.taskId))!.dependencies[0]), false);
  await deliveryReady(taskId);
  db.prepare("UPDATE tasks SET agile_status = 'backlog' WHERE task_id = ?").run(taskId);
  assert.equal(requirementDeliveryReadyInDb(db, taskId), true);
  assert.equal(requirementDependencyGateOpenInDb(db, dependent.taskId), true);
  const closure = db.prepare("SELECT status,completion_authority FROM workflow_items WHERE task_id = ? AND kind = 'closure'")
    .get(taskId) as { status: string; completion_authority: string | null };
  assert.deepEqual(closure, { status: 'waiting', completion_authority: null });
  assert.equal(requirementDependencyCandidatesInDb(db).some(candidate => candidate.task_id === taskId), false);
  assert.equal((await inspectTaskDispatchEnvelope(dependent.taskId))[0]?.agent, 'direct-agent');
});

test('waiting Closure alone cannot open the gate without completed prerequisites and a real report head', async () => {
  const { db, taskId } = await native();
  const closure = db.prepare("SELECT item_id FROM workflow_items WHERE task_id = ? AND kind = 'closure'").get(taskId) as { item_id: string };
  transitionWorkItemInDb(db, { itemId: closure.item_id, action: 'wait', eventKey: 'fixture:early-wait',
    actor: 'human', authority: 'human', reason: 'Hold a not-yet-ready closure' });
  assert.equal(requirementDeliveryReadyInDb(db, taskId), false);
  db.prepare("UPDATE workflow_items SET status = 'completed' WHERE task_id = ? AND kind != 'closure'").run(taskId);
  assert.equal(requirementDeliveryReadyInDb(db, taskId), false);
  const unrelated = await native();
  const foreignReport = await upsertDocument({ taskId: unrelated.taskId, kind: 'review_v1', content: 'Foreign report', actor: 'human' });
  db.prepare('UPDATE tasks SET review_document_id = ?, review_revision = 1 WHERE task_id = ?').run(foreignReport, taskId);
  assert.equal(requirementDeliveryReadyInDb(db, taskId), false);
});

test('a report-ready Closure cannot bypass an unfinished native obligation outside its dependency edges', async () => {
  const { db, taskId } = await native();
  await deliveryReady(taskId);
  const dependent = await native('direct', [taskId]);
  assert.equal(requirementDependencyGateOpenInDb(db, dependent.taskId), true);
  const itemId = randomUUID();
  db.prepare(`INSERT INTO workflow_items(item_id, task_id, work_key, revision, kind, title, status, origin)
    VALUES(?, ?, 'required:independent-validation', 1, 'verification', 'Independent validation obligation', 'ready', 'native')`)
    .run(itemId, taskId);
  assert.equal(requirementDeliveryReadyInDb(db, taskId), false);
  assert.equal(requirementDependencyGateOpenInDb(db, dependent.taskId), false);
  assert.equal((await getTask(dependent.taskId))?.dependencies[0].delivery_ready, false);
  transitionWorkItemInDb(db, { itemId, action: 'complete', eventKey: 'fixture:independent-validation-complete',
    actor: 'human', authority: 'human', reason: 'Complete the independent domain fixture obligation' });
  assert.equal(requirementDependencyGateOpenInDb(db, dependent.taskId), true);
});

for (const type of ['feature', 'business-analysis'] as const) test(`acknowledged native ${type} closure cannot hide a new independent obligation`, async () => {
  const { db, taskId } = await native(type);
  await deliveryReady(taskId);
  const head = db.prepare('SELECT review_revision FROM tasks WHERE task_id = ?').get(taskId) as { review_revision: number };
  await acknowledgeClosure({ taskId, reviewRevision: head.review_revision });
  assert.equal(nativeWorkflowEndedInDb(db, taskId), true);
  const closure = db.prepare("SELECT * FROM workflow_items WHERE task_id = ? AND kind = 'closure'").get(taskId);
  const events = db.prepare('SELECT * FROM workflow_item_events WHERE item_id IN (SELECT item_id FROM workflow_items WHERE task_id = ?) ORDER BY event_id').all(taskId);
  const itemId = randomUUID();
  // Domain-only graph extension: no smoke DB or Agent result is fabricated.
  db.prepare(`INSERT INTO workflow_items(item_id, task_id, work_key, revision, kind, title, status, origin)
    VALUES(?, ?, 'required:post-closure-validation', 1, 'verification', 'New independent obligation', 'ready', 'native')`).run(itemId, taskId);
  const dependent = await native('direct', [taskId]);
  assert.equal(nativeCompletionInDb(db, taskId), false);
  assert.equal(nativeWorkflowEndedInDb(db, taskId), false);
  assert.equal(requirementDependencyGateOpenInDb(db, dependent.taskId), false);
  assert.deepEqual(db.prepare("SELECT * FROM workflow_items WHERE task_id = ? AND kind = 'closure'").get(taskId), closure);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_item_events WHERE item_id IN (SELECT item_id FROM workflow_items WHERE task_id = ?) ORDER BY event_id').all(taskId), events);
  transitionWorkItemInDb(db, { itemId, action: 'complete', eventKey: 'fixture:post-closure-validation-complete',
    actor: 'human', authority: 'human', reason: 'Complete new independent domain fixture obligation' });
  assert.equal(nativeWorkflowEndedInDb(db, taskId), true);
  assert.equal(requirementDependencyGateOpenInDb(db, dependent.taskId), true);
});

for (const type of ['feature','business-analysis'] as const) test(`native ${type} final artifact proof rejects poisoned heads, content, result and execution evidence`, async () => {
  const { db, taskId } = await native(type);
  await deliveryReady(taskId);
  const head = db.prepare('SELECT review_document_id, review_revision FROM tasks WHERE task_id = ?').get(taskId) as
    { review_document_id: string; review_revision: number };
  const source = db.prepare(`SELECT execution_id, input_json FROM execution_attempts WHERE task_id = ? AND status = 'applied' ORDER BY rowid DESC LIMIT 1`)
    .get(taskId) as { execution_id: string; input_json: string };
  const document = db.prepare('SELECT content FROM documents WHERE document_id = ?').get(head.review_document_id) as { content: string };
  const unrelated = await upsertDocument({ taskId, kind: 'context', title: 'Unreviewed context', content: 'Not the final report', actor: 'human' });
  db.prepare('UPDATE tasks SET review_document_id = ? WHERE task_id = ?').run(unrelated, taskId);
  assert.equal(requirementDeliveryReadyInDb(db, taskId), false);
  await assert.rejects(acknowledgeClosure({ taskId, reviewRevision: head.review_revision }), /可信产物来源/);
  assert.notEqual((await getTask(taskId))?.task.closure_status, 'awaiting_read');
  db.prepare('UPDATE tasks SET review_document_id = ? WHERE task_id = ?').run(head.review_document_id, taskId);
  assert.equal(requirementDeliveryReadyInDb(db, taskId), true);
  db.prepare("UPDATE documents SET content = 'Changed after publication' WHERE document_id = ?").run(head.review_document_id);
  assert.equal(requirementDeliveryReadyInDb(db, taskId), false);
  db.prepare('UPDATE documents SET content = ? WHERE document_id = ?').run(document.content, head.review_document_id);
  db.prepare("UPDATE agent_results SET application_status = 'failed' WHERE execution_id = ?").run(source.execution_id);
  assert.equal(requirementDeliveryReadyInDb(db, taskId), false);
  db.prepare("UPDATE agent_results SET application_status = 'applied' WHERE execution_id = ?").run(source.execution_id);
  const submitted = db.prepare('SELECT result_json FROM agent_results WHERE execution_id = ?').get(source.execution_id) as { result_json: string };
  const altered = JSON.parse(submitted.result_json);
  altered.artifact.content = 'Changed source artifact evidence';
  db.prepare('UPDATE agent_results SET result_json = ? WHERE execution_id = ?').run(JSON.stringify(altered), source.execution_id);
  assert.equal(requirementDeliveryReadyInDb(db, taskId), false);
  db.prepare('UPDATE agent_results SET result_json = ? WHERE execution_id = ?').run(submitted.result_json, source.execution_id);
  db.prepare("UPDATE execution_attempts SET input_json = '{broken' WHERE execution_id = ?").run(source.execution_id);
  assert.equal(requirementDeliveryReadyInDb(db, taskId), false);
  assert.ok(await getTask(taskId), 'damaged evidence must remain readable, not throw in projection');
  db.prepare('UPDATE execution_attempts SET input_json = ? WHERE execution_id = ?').run(source.input_json, source.execution_id);
  assert.equal(requirementDeliveryReadyInDb(db, taskId), true);
  const receipt = db.prepare("SELECT receipt_id, payload_json FROM execution_receipts WHERE execution_id = ? AND kind = 'work_item_artifact'")
    .get(source.execution_id) as { receipt_id: string; payload_json: string };
  db.prepare("UPDATE execution_receipts SET payload_json = '{broken' WHERE receipt_id = ?").run(receipt.receipt_id);
  assert.equal(requirementDeliveryReadyInDb(db, taskId), false);
  db.prepare('UPDATE execution_receipts SET payload_json = ? WHERE receipt_id = ?').run(receipt.payload_json, receipt.receipt_id);
  assert.equal(requirementDeliveryReadyInDb(db, taskId), true);
  if (type === 'feature') {
    const olderReceipt = JSON.parse(receipt.payload_json);
    delete olderReceipt.contentHash;
    db.prepare('UPDATE execution_receipts SET payload_json = ? WHERE receipt_id = ?').run(JSON.stringify(olderReceipt), receipt.receipt_id);
    assert.equal(requirementDeliveryReadyInDb(db, taskId), true, 'older native Review receipts still require exact applied source artifact content');
    db.prepare("UPDATE documents SET content = 'Changed after older publication' WHERE document_id = ?").run(head.review_document_id);
    assert.equal(requirementDeliveryReadyInDb(db, taskId), false);
    db.prepare('UPDATE documents SET content = ? WHERE document_id = ?').run(document.content, head.review_document_id);
    assert.equal(requirementDeliveryReadyInDb(db, taskId), true);
  }
});

test('native cancellation and candidate configuration use cancellation intent, not a stale display label', async () => {
  const { db, taskId } = await native();
  db.prepare("UPDATE tasks SET agile_status = 'cancelled' WHERE task_id = ?").run(taskId);
  assert.ok(requirementDependencyCandidatesInDb(db).some(candidate => candidate.task_id === taskId));
  const dependent = await native('direct', [taskId]);
  await cancelTask({ taskId, reason: 'Actual prerequisite cancellation' });
  db.prepare("UPDATE tasks SET agile_status = 'ready_to_close' WHERE task_id = ?").run(taskId);
  assert.equal(requirementDependencyGateOpenInDb(db, dependent.taskId), false);
  assert.equal(requirementDependencyCandidatesInDb(db).some(candidate => candidate.task_id === taskId), false);
  assert.throws(() => configureRequirementDependenciesInDb(db, dependent.taskId, [taskId]), /不能依赖已取消/);
});

test('a new feedback obligation closes only unstarted dependent gates, never an already reserved requirement', async () => {
  const { db, taskId } = await native();
  await deliveryReady(taskId);
  const startedTask = await native('direct', [taskId]);
  const waitingTask = await native('direct', [taskId]);
  const work = (await inspectTaskDispatchEnvelope(startedTask.taskId))[0];
  await beginTestExecutionAttempt({ runId: 'RUN-native-dependency-latch', delegation: work, prompt: 'Actual reservation fixture' });
  db.prepare(`INSERT INTO workflow_items(item_id,task_id,work_key,revision,kind,title,status,origin)
    VALUES(?,?,?,1,'feedback','New explicit feedback obligation','pending','native')`).run(randomUUID(), taskId, `feedback:${randomUUID()}`);
  assert.equal(requirementDependencyGateOpenInDb(db, waitingTask.taskId), false);
  assert.equal(requirementDependencyGateOpenInDb(db, startedTask.taskId), true);
});

test('superseded Closure and an old report cannot satisfy a new plan generation', async () => {
  const { db, taskId } = await native();
  await deliveryReady(taskId);
  const context = db.prepare("SELECT item_id FROM workflow_items WHERE task_id = ? AND work_key = 'delivery:context'")
    .get(taskId) as { item_id: string };
  rewindWorkItemsInDb(db, { taskId, targetItemId: context.item_id, eventKey: 'fixture:dependency-new-generation',
    actor: 'human', authority: 'human', reason: 'New requirement scope needs a new report' });
  db.prepare("UPDATE tasks SET agile_status = 'ready_to_close' WHERE task_id = ?").run(taskId);
  assert.equal(requirementDeliveryReadyInDb(db, taskId), false);
});

test('report-ready Closure cannot open a dependency gate while a current Intervention is unresolved', async () => {
  const { db, taskId } = await native();
  await deliveryReady(taskId);
  const closure = db.prepare("SELECT item_id FROM workflow_items WHERE task_id = ? AND kind = 'closure'").get(taskId) as { item_id: string };
  const intervention = openInterventionInDb(db, { taskId, itemId: closure.item_id, dedupeKey: 'fixture:closure-hold',
    requestedBy: 'human', summary: 'Report still has a current unresolved obligation', resolverStrategy: 'human_only' });
  assert.equal(requirementDeliveryReadyInDb(db, taskId), false);
  db.prepare("UPDATE interventions SET status = 'resolved' WHERE intervention_id = ?").run(intervention.intervention_id);
  assert.equal(requirementDeliveryReadyInDb(db, taskId), true);
});

test('dependency service configuration rolls back earlier inserts if any later prerequisite is invalid', async () => {
  const upstream = await native();
  const dependent = await native('direct');
  assert.throws(() => configureRequirementDependenciesInDb(upstream.db, dependent.taskId, [upstream.taskId, 'REQ-absent']), /前置需求不存在/);
  assert.deepEqual(upstream.db.prepare('SELECT * FROM task_dependencies WHERE task_id = ?').all(dependent.taskId), []);
});
