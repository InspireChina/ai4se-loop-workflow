import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
import { agentResultSchema } from '../domain/agent-result';
import { applyAgentResult } from './agent-results';
import { markExecutionOutput, completeExecution } from './executions';
import { createTask, getTask, getTaskContext, saveDeliverySpec, rewindTask, pauseTask, resumeTask, type DelegationEnvelope } from '../test/legacy-task-fixtures';
import { adoptNativeWorkflowInDb, rewindWorkItemsInDb } from './work-item-transitions';
import { createOrReopenRecoveryItem, listRecoveryItemsForStage, recordRecoveryClaims, resolveActiveRecoveryItems } from './recovery-items';
import { nativeRecoveryItemsInDb, createNativeRecoveryDirectiveInDb, recordNativeRecoveryClaimsInDb, recordNativeRecoveryVerificationInDb } from './work-item-recovery';
import { buildAgentContextSnapshot } from './agent-context';

async function setup(native = true) {
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET is_paused = 1, agile_status = 'cancelled' WHERE agile_status NOT IN ('done', 'cancelled')").run();
  const taskId = await createTask({ title: 'Native verification recovery' });
  db.prepare(`UPDATE tasks SET agile_status = 'in dev', current_subagent = 'test-agent',
    total_stories = 1, analysis_index = 1, spec_resolved_index = 1, dev_index = 1, test_index = 0 WHERE task_id = ?`).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Visible retry result', 'story-001')").run(taskId);
  await saveDeliverySpec({ taskId, storyIndex: 1, status: 'resolved', spec: deliverySpecFixture() });
  if (native) adoptNativeWorkflowInDb(db, taskId);
  return { db, taskId };
}

async function begin(delegation: DelegationEnvelope) {
  const result = await beginTestExecutionAttempt({ runId: `RUN-${delegation.taskId}`, delegation, prompt: 'Native recovery test' });
  return result.attempt.execution_id;
}

const failure = agentResultSchema.parse({ outcome: 'failed', summary: 'Retry displays the default result instead of the configured result',
  verdict: 'failed', failureKind: 'implementation', rewindTo: 'dev', rewindDeliveryUnit: 1,
  tests: [{ command: 'frontend retry result', passed: false, summary: 'Expected configured result, observed default result' }] });

async function fail(taskId: string) {
  const delegation = (await inspectTaskDispatchEnvelope(taskId)).find((item) => item.agent === 'test-agent')!;
  assert.ok(delegation);
  const executionId = await begin(delegation);
  await markExecutionOutput(executionId, failure);
  assert.equal(await applyAgentResult('RUN-failed-test', delegation, failure, { executionId }), 'rewound');
  return executionId;
}

test('native Test rewind records an immutable Intervention, not a mutable Recovery state machine', async () => {
  const { db, taskId } = await setup();
  const failedExecutionId = await fail(taskId);
  const items = await listRecoveryItemsForStage({ taskId, storyIndex: 1, stage: 'dev' });
  assert.equal(items.length, 1);
  assert.match(items[0].recovery_id, /^INT-/);
  assert.equal(items[0].status, 'pending');
  const immutable = db.prepare('SELECT context_json, resolution FROM interventions WHERE intervention_id = ?').get(items[0].recovery_id);
  assert.match((immutable as { resolution: string }).resolution, /原测试失败保留/);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM recovery_items WHERE task_id = ?').get(taskId) as { count: number }).count, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM interventions WHERE task_id = ? AND status IN ('pending', 'running', 'awaiting_human')")
    .get(taskId) as { count: number }).count, 0, 'routing ordinary Dev work must not launch an auxiliary attempt');
  const dev = (await inspectTaskDispatchEnvelope(taskId))[0];
  assert.equal(dev.agent, 'dev-agent');
  const devExecutionId = await begin(dev);
  await recordRecoveryClaims({ taskId, storyIndex: 1, agent: 'dev-agent', executionId: devExecutionId,
    claims: [{ recoveryId: items[0].recovery_id, summary: 'DEV_CLAIM_MUST_NOT_BIAS_TEST', evidence: ['Inspected result wiring'] }] });
  await recordRecoveryClaims({ taskId, storyIndex: 1, agent: 'dev-agent', executionId: devExecutionId,
    claims: [{ recoveryId: items[0].recovery_id, summary: 'Changed claim must not rewrite a receipt', evidence: [] }] });
  assert.deepEqual(db.prepare('SELECT context_json, resolution FROM interventions WHERE intervention_id = ?').get(items[0].recovery_id), immutable);
  const receipt = db.prepare("SELECT payload_json FROM execution_receipts WHERE execution_id = ? AND kind = 'recovery_claim'")
    .get(devExecutionId) as { payload_json: string };
  assert.match(receipt.payload_json, /DEV_CLAIM_MUST_NOT_BIAS_TEST/);
  assert.doesNotMatch(receipt.payload_json, /Changed claim/);
  const completed = agentResultSchema.parse({ outcome: 'completed', summary: 'Inspected retry result wiring', changedFiles: [] });
  await markExecutionOutput(devExecutionId, completed);
  assert.equal(await applyAgentResult('RUN-recovery-dev', dev, completed, { executionId: devExecutionId }), 'advanced');
  await completeExecution(devExecutionId);
  const testDelegation = (await inspectTaskDispatchEnvelope(taskId))[0];
  const active = await listRecoveryItemsForStage({ taskId, storyIndex: 1, stage: 'test' });
  const snapshot = buildAgentContextSnapshot({ delegation: testDelegation, full: await getTaskContext(taskId), activeFeedback: [], activeRecovery: active });
  assert.doesNotMatch(JSON.stringify(snapshot), /DEV_CLAIM_MUST_NOT_BIAS_TEST/);
  assert.match(JSON.stringify(snapshot), /Expected configured result/);
  assert.equal((db.prepare('SELECT result_json FROM execution_attempts WHERE execution_id = ?').get(failedExecutionId) as { result_json: string }).result_json,
    JSON.stringify(failure));
});

test('native Dev and Test YAML command chains read recovery obligations from Interventions rather than the old table', async () => {
  const { issueAgentCommandToken, runAgentCommand } = await import('./agent-command-drafts');
  const { db, taskId } = await setup();
  await fail(taskId);
  const recovery = nativeRecoveryItemsInDb(db, taskId).find((item) => item.status === 'pending')!;
  assert.ok(recovery);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM recovery_items WHERE task_id = ?').get(taskId) as { count: number }).count, 0);
  const dev = (await inspectTaskDispatchEnvelope(taskId))[0];
  const devExecutionId = await begin(dev);
  const devToken = await issueAgentCommandToken(devExecutionId);
  assert.ok(devToken);
  await runAgentCommand({ executionId: devExecutionId, token: devToken, args: ['status'] });
  await runAgentCommand({ executionId: devExecutionId, token: devToken, args: ['delivery-spec', 'current'] });
  const status = await runAgentCommand({ executionId: devExecutionId, token: devToken, args: ['phase', 'complete'] });
  assert.ok(status.includes(recovery.recovery_id), 'the new Intervention must appear in Dev recovery requirements');
  await assert.rejects(runAgentCommand({ executionId: devExecutionId, token: devToken, args: ['phase', 'complete'] }),
    (error: unknown) => error instanceof Error && error.message.includes(recovery.recovery_id));
  // Domain fixture advances Dev to inspect the actual Test draft initializer;
  // this does not claim that a real Agent performed a code repair.
  await applyAgentResult('RUN-recovery-source-initializer', dev,
    agentResultSchema.parse({ outcome: 'completed', summary: 'Domain fixture repair stage', changedFiles: [] }), { executionId: devExecutionId });
  await completeExecution(devExecutionId);
  const testWork = (await inspectTaskDispatchEnvelope(taskId))[0];
  assert.equal(testWork.agent, 'test-agent');
  const testExecutionId = await begin(testWork);
  const testToken = await issueAgentCommandToken(testExecutionId);
  assert.ok(testToken);
  await runAgentCommand({ executionId: testExecutionId, token: testToken, args: ['status'] });
  const sources = db.prepare(`SELECT block.content FROM command_chain_artifact_blocks block
    JOIN agent_work_drafts draft ON draft.draft_id = block.draft_id
    WHERE draft.last_execution_id = ? AND block.artifact_id = 'verification' AND block.block_id = 'sources'`)
    .all(testExecutionId) as { content: string }[];
  assert.ok(sources.some((row) => row.content.includes(`RECOVERY:${recovery.recovery_id}`)),
    'independent Test must get a mandatory source for the original failed observation');
});

test('native Recovery reads do not adopt newly injected old-table rows or mutate the graph', async () => {
  const { db, taskId } = await setup();
  await fail(taskId);
  const before = nativeRecoveryItemsInDb(db, taskId);
  const interventions = db.prepare('SELECT * FROM interventions WHERE task_id = ? ORDER BY rowid').all(taskId);
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId);
  db.prepare(`INSERT INTO recovery_items(recovery_id, task_id, story_index, kind, source_agent, target_stage, status, summary, details_json)
    VALUES('RECOVERY-INJECTED-OLD-ROW', ?, 1, 'test_failure', 'test-agent', 'dev', 'pending', 'Old table cannot add obligations', '{}')`).run(taskId);
  assert.deepEqual(nativeRecoveryItemsInDb(db, taskId), before);
  assert.deepEqual(db.prepare('SELECT * FROM interventions WHERE task_id = ? ORDER BY rowid').all(taskId), interventions);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId), graph);
  assert.equal((db.prepare("SELECT intervention_id FROM recovery_items WHERE recovery_id = 'RECOVERY-INJECTED-OLD-ROW'")
    .get() as { intervention_id: string | null }).intervention_id, null);
});

test('a verification receipt alone cannot close recovery; actual Test completion does, and later rewinds do not resurrect old failures', async () => {
  const { db, taskId } = await setup();
  await fail(taskId);
  const dev = (await inspectTaskDispatchEnvelope(taskId))[0];
  const devExecutionId = await begin(dev);
  const result = agentResultSchema.parse({ outcome: 'completed', summary: 'Corrected the result wiring', changedFiles: [] });
  await applyAgentResult('RUN-dev-fix', dev, result, { executionId: devExecutionId });
  await completeExecution(devExecutionId);
  const testDelegation = (await inspectTaskDispatchEnvelope(taskId))[0];
  const testExecutionId = await begin(testDelegation);
  const closed = await resolveActiveRecoveryItems({ taskId, storyIndex: 1, kind: 'test_failure',
    verifier: 'test-agent', executionId: testExecutionId, summary: 'The configured result was independently observed' });
  assert.equal(closed.length, 1);
  assert.equal((await listRecoveryItemsForStage({ taskId, storyIndex: 1, stage: 'test' })).length, 1);
  const passed = agentResultSchema.parse({ outcome: 'completed', summary: 'Independent Test confirms the configured result', verdict: 'passed',
    tests: [{ command: 'frontend retry result', passed: true, summary: 'The configured result is visible' }] });
  await applyAgentResult('RUN-verified', testDelegation, passed, { executionId: testExecutionId });
  await completeExecution(testExecutionId);
  assert.deepEqual(await listRecoveryItemsForStage({ taskId, storyIndex: 1, stage: 'dev' }), []);
  assert.equal((await getTask(taskId))?.recoveryItems[0].status, 'resolved');
  const devItem = db.prepare("SELECT item_id FROM workflow_items WHERE task_id = ? AND work_key = 'delivery:dev:1' AND status = 'completed'")
    .get(taskId) as { item_id: string };
  rewindWorkItemsInDb(db, { taskId, targetItemId: devItem.item_id, eventKey: 'another-change', actor: 'human', authority: 'human', reason: 'Another change needs verification' });
  assert.deepEqual(await listRecoveryItemsForStage({ taskId, storyIndex: 1, stage: 'dev' }), []);
  assert.equal(nativeRecoveryItemsInDb(db, taskId)[0].status, 'resolved');
});

test('each repeated failure is immutable history, while only the latest unverified directive is hot context', async () => {
  const { db, taskId } = await setup();
  const first = await fail(taskId);
  const dev = (await inspectTaskDispatchEnvelope(taskId))[0];
  const devExecutionId = await begin(dev);
  await applyAgentResult('RUN-dev-again', dev, agentResultSchema.parse({ outcome: 'completed', summary: 'Attempted result fix', changedFiles: [] }), { executionId: devExecutionId });
  await completeExecution(devExecutionId);
  const second = await fail(taskId);
  assert.notEqual(first, second);
  const history = nativeRecoveryItemsInDb(db, taskId);
  assert.equal(history.length, 2);
  assert.equal(history[0].status, 'superseded');
  assert.equal(history[1].failure_count, 2);
  assert.equal((await listRecoveryItemsForStage({ taskId, storyIndex: 1, stage: 'dev' })).length, 1);
  await rewindTask({ taskId, actor: 'human', to: 'plan', reason: 'Correct contradictory unit ownership' });
  assert.ok(nativeRecoveryItemsInDb(db, taskId).every((item) => item.status === 'superseded'));
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM recovery_items WHERE task_id = ?').get(taskId) as { count: number }).count, 0);
});

test('adoption snapshots legacy Recovery with claims once and ignores later changes to its old status', async () => {
  const { db, taskId } = await setup(false);
  const old = await createOrReopenRecoveryItem({ taskId, storyIndex: 1, kind: 'test_failure', sourceAgent: 'test-agent',
    targetStage: 'dev', summary: 'Legacy retry failure', details: { expected: 'Configured result', actual: 'Default result' }, sourceExecutionId: 'HISTORICAL-MISSING-EXECUTION' });
  await recordRecoveryClaims({ taskId, storyIndex: 1, agent: 'dev-agent', claims: [{ recoveryId: old.recovery_id, summary: 'Legacy investigation', evidence: ['Original wiring inspection'] }] });
  adoptNativeWorkflowInDb(db, taskId);
  const before = (await getTask(taskId))!.recoveryItems;
  assert.equal(before.length, 1);
  assert.equal(before[0].recovery_id, old.recovery_id);
  assert.equal(before[0].status, 'claimed');
  assert.match(before[0].resolution_json || '', /Legacy investigation/);
  const id = (db.prepare('SELECT intervention_id FROM recovery_items WHERE recovery_id = ?').get(old.recovery_id) as { intervention_id: string }).intervention_id;
  assert.ok(id);
  db.prepare("UPDATE recovery_items SET status = 'resolved', failure_count = 999, summary = 'Old table must not be truth' WHERE recovery_id = ?").run(old.recovery_id);
  adoptNativeWorkflowInDb(db, taskId);
  assert.deepEqual((await getTask(taskId))!.recoveryItems, before);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM interventions WHERE task_id = ? AND dedupe_key = ?")
    .get(taskId, `legacy-recovery:${old.recovery_id}`) as { count: number }).count, 1);
});

test('directive replay preserves its old identity after a plan reset and rejects changing the failure evidence', async () => {
  const { taskId } = await setup();
  const sourceExecutionId = await fail(taskId);
  const input = { taskId, storyIndex: 1, kind: 'test_failure', sourceAgent: 'test-agent', targetStage: 'dev', summary: failure.summary,
    details: { verdict: failure.verdict, expected: '当前交付单元满足已收敛的交付规格与验收标准', actual: failure.summary,
      tests: failure.tests || [], failureKind: 'implementation', rewindTo: 'dev' }, sourceExecutionId };
  const first = await createOrReopenRecoveryItem(input);
  await rewindTask({ taskId, actor: 'human', to: 'plan', reason: 'New plan' });
  assert.equal((await createOrReopenRecoveryItem(input)).recovery_id, first.recovery_id);
  await assert.rejects(createOrReopenRecoveryItem({ ...input, summary: 'Modified historical failure' }), /不能改写历史失败/);
});

test('recovery evidence rejects cross-task, wrong-role and superseded execution bindings', async () => {
  const { db, taskId } = await setup();
  await fail(taskId);
  const recovery = nativeRecoveryItemsInDb(db, taskId)[0];
  const dev = (await inspectTaskDispatchEnvelope(taskId))[0];
  const executionId = await begin(dev);
  const otherTaskId = await createTask({ title: 'Other recovery owner' });
  const claims = [{ recoveryId: recovery.recovery_id, summary: 'Invalid binding', evidence: [] }];
  recordNativeRecoveryClaimsInDb(db, { taskId: otherTaskId, storyIndex: 1, agent: 'dev-agent', executionId, claims });
  recordNativeRecoveryClaimsInDb(db, { taskId, storyIndex: 1, agent: 'test-agent', executionId, claims });
  recordNativeRecoveryVerificationInDb(db, { taskId, storyIndex: 1, executionId, summary: 'Dev is not an independent Test' });
  assert.throws(() => createNativeRecoveryDirectiveInDb(db, { taskId, storyIndex: 1, sourceAgent: 'test-agent',
    sourceExecutionId: executionId, targetStage: 'dev', summary: 'Invalid Test source', details: {} }), /Test 执行与工作项/);
  const source = db.prepare('SELECT work_item_id FROM execution_attempts WHERE execution_id = ?').get(executionId) as { work_item_id: string };
  rewindWorkItemsInDb(db, { taskId, targetItemId: source.work_item_id, eventKey: 'invalid-old-claim', actor: 'human', authority: 'human', reason: 'Replace source revision' });
  recordNativeRecoveryClaimsInDb(db, { taskId, storyIndex: 1, agent: 'dev-agent', executionId, claims });
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM execution_receipts WHERE execution_id = ? AND kind IN ('recovery_claim', 'recovery_verification')")
    .get(executionId) as { count: number }).count, 0);
});

for (const agent of ['dev-agent','test-agent'] as const) test(`cancelled ${agent} cannot add recovery evidence after pause/resume preserves the same Work Item`, async () => {
  const { db, taskId } = await setup();
  if (agent === 'dev-agent') await fail(taskId);
  const work = (await inspectTaskDispatchEnvelope(taskId)).find(item => item.agent === agent)!;
  assert.ok(work);
  const executionId = await begin(work);
  await pauseTask({ taskId });
  await resumeTask({ taskId });
  assert.equal((await inspectTaskDispatchEnvelope(taskId))[0].workItemId, work.workItemId);
  assert.equal((db.prepare('SELECT status FROM execution_attempts WHERE execution_id = ?').get(executionId) as { status: string }).status, 'cancelled');
  const interventions = db.prepare('SELECT * FROM interventions WHERE task_id = ? ORDER BY intervention_id').all(taskId);
  const recovery = nativeRecoveryItemsInDb(db, taskId)[0];
  recordNativeRecoveryClaimsInDb(db, { taskId, storyIndex: 1, agent, executionId,
    claims: [{ recoveryId: recovery?.recovery_id || 'nonexistent', summary: 'Late cancelled source claim', evidence: [] }] });
  recordNativeRecoveryVerificationInDb(db, { taskId, storyIndex: 1, executionId, summary: 'Late cancelled source verification' });
  if (agent === 'test-agent') assert.throws(() => createNativeRecoveryDirectiveInDb(db, { taskId, storyIndex: 1, sourceAgent: agent,
    sourceExecutionId: executionId, targetStage: 'dev', summary: 'Late cancelled source failure', details: {} }), /已取消/);
  assert.deepEqual(db.prepare('SELECT * FROM interventions WHERE task_id = ? ORDER BY intervention_id').all(taskId), interventions);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM execution_receipts WHERE execution_id = ? AND kind IN ('recovery_claim','recovery_verification')")
    .get(executionId) as { count: number }).count, 0);
});
