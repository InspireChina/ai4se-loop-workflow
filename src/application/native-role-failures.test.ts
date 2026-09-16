import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { agentResultSchema } from '../domain/agent-result';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { createTask, saveDeliverySpec, getTask, updateTask, initializeTaskContext, setTaskLaneState, cancelTask } from '../test/legacy-task-fixtures';
import { adoptNativeWorkflowInDb, reconcileNativeWorkItemExecutionsInDb, rewindWorkItemsInDb } from './work-item-transitions';
import { applyAgentResult, blockDelegation } from './agent-results';
import { markExecutionOutput, completeExecution } from './executions';
import { resourceClaimInDb, acquireResourceClaimInDb, CODE_WORKSPACE_RESOURCE } from './resource-claims';

async function fixture(testStage = false) {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Native role failure recovery' });
  if (testStage) {
    db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Verification target', 'unit-1')").run(taskId);
    db.prepare(`UPDATE tasks SET agile_status = 'in dev', current_subagent = 'test-agent',
      total_stories = 1, analysis_index = 1, spec_resolved_index = 1, dev_index = 1, test_index = 0 WHERE task_id = ?`).run(taskId);
    await saveDeliverySpec({ taskId, storyIndex: 1, status: 'resolved', spec: deliverySpecFixture() });
  }
  adoptNativeWorkflowInDb(db, taskId);
  const work = (await inspectTaskDispatchEnvelope(taskId)).find((candidate) => candidate.agent === (testStage ? 'test-agent' : 'backlog-agent'))!;
  assert.ok(work);
  const started = await beginTestExecutionAttempt({ runId: `RUN-role-${taskId}`, delegation: work, prompt: 'Native role failure source' });
  return { db, taskId, work, executionId: started.attempt.execution_id };
}

for (const failureKind of [undefined, 'environment', 'inconclusive']) test(`native ${failureKind || 'control'} role failure enters source-bound arbitration without a legacy block`, async () => {
  const { db, taskId, work, executionId } = await fixture(Boolean(failureKind));
  const result = agentResultSchema.parse({ outcome: 'failed', summary: 'The current execution cannot establish a safe result.',
    ...(failureKind ? { verdict: 'failed', failureKind } : {}) });
  await markExecutionOutput(executionId, result);
  const source = db.prepare('SELECT input_json, result_json FROM execution_attempts WHERE execution_id = ?').get(executionId);
  assert.equal(await applyAgentResult(`RUN-role-${taskId}`, work, result, { executionId }), 'blocked');
  await completeExecution(executionId);
  reconcileNativeWorkItemExecutionsInDb(db, taskId);
  const item = db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(work.workItemId) as { status: string };
  assert.equal(item.status, 'waiting');
  const intervention = db.prepare('SELECT item_id, source_execution_id, authority, resolver_strategy, status, max_system_attempts FROM interventions WHERE task_id = ?')
    .get(taskId) as Record<string, unknown>;
  assert.deepEqual(intervention, { item_id: work.workItemId, source_execution_id: executionId,
    authority: 'arbitration', resolver_strategy: 'system_then_human', status: 'pending', max_system_attempts: 3 });
  const detail = await getTask(taskId);
  assert.notEqual(detail?.task.agile_status, 'blocked');
  assert.equal(detail?.task.run_state, 'waiting_for_runtime_input');
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM execution_attempts WHERE execution_id = ?
    AND dispatch_retry_consumed = 1 AND status IN ('retryable_failed', 'system_blocked')`).get(executionId) as { count: number }).count, 0,
    'applied domain failures are Intervention obligations, not CLI retry failures');
  assert.deepEqual(db.prepare('SELECT input_json, result_json FROM execution_attempts WHERE execution_id = ?').get(executionId), source);
  if (failureKind) assert.equal(resourceClaimInDb(db, 'code:workspace', taskId), undefined);
  assert.equal(await applyAgentResult(`RUN-role-${taskId}`, work, result, { executionId }), 'blocked');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM interventions WHERE task_id = ?').get(taskId) as { count: number }).count, 1);
});

test('native role block rejects missing, cross-task and cancelled execution provenance', async () => {
  const first = await fixture();
  const other = await fixture();
  await assert.rejects(blockDelegation(first.work, 'No source'), /来源执行/);
  await assert.rejects(blockDelegation(first.work, 'Wrong source', other.executionId), /执行绑定/);
  rewindWorkItemsInDb(first.db, { taskId: first.taskId, targetItemId: first.work.workItemId!, eventKey: 'replace-block-source',
    actor: 'human', authority: 'human', reason: 'Replace the obsolete execution before it reports a failure' });
  await assert.rejects(blockDelegation(first.work, 'Late source', first.executionId), /已失效/);
  assert.equal((first.db.prepare('SELECT COUNT(*) AS count FROM interventions WHERE task_id = ?').get(first.taskId) as { count: number }).count, 0);
});

for (const poison of ['snapshot-json', 'missing-generation', 'current-epoch', 'caller-revision'] as const) {
  test(`native role block rejects ${poison} without creating an Intervention or rewriting evidence`, async () => {
    const { db, taskId, work, executionId } = await fixture();
    if (poison === 'snapshot-json') db.prepare("UPDATE execution_attempts SET input_json = '{' WHERE execution_id = ?").run(executionId);
    if (poison === 'missing-generation') db.prepare('UPDATE execution_attempts SET dispatch_generation_key = NULL WHERE execution_id = ?').run(executionId);
    if (poison === 'current-epoch') db.prepare('UPDATE workflow_items SET dispatch_epoch = dispatch_epoch + 1 WHERE item_id = ?').run(work.workItemId);
    const before = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId);
    const item = db.prepare('SELECT * FROM workflow_items WHERE item_id = ?').get(work.workItemId);
    await assert.rejects(blockDelegation(poison === 'caller-revision' ? { ...work, workItemRevision: 99 } : work,
      'Cannot publish an unbound domain failure', executionId), /快照无法读取|缺少可确认|代次已失效|不一致/);
    assert.equal(db.prepare('SELECT 1 FROM interventions WHERE task_id = ?').get(taskId), undefined);
    assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId), before);
    assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE item_id = ?').get(work.workItemId), item);
  });
}

for (const outcome of ['block', 'passed'] as const) test(`native Test ${outcome} cannot release the code slot of another independent source in its requirement`, async () => {
  const { db, taskId, work, executionId } = await fixture(true);
  try {
    const itemId = randomUUID();
    db.prepare(`INSERT INTO workflow_items(item_id, task_id, work_key, revision, kind, title, agent, pipeline, lane, status, origin)
      VALUES(?, ?, 'fixture:other-code-source', 1, 'fixture', 'Other code source', 'direct-agent', 'direct', 'control', 'ready', 'native')`)
      .run(itemId, taskId);
    const other = await beginTestExecutionAttempt({ runId: `RUN-other-code-${taskId}`, prompt: 'Domain-only source ownership fixture',
      delegation: { ...work, agent: 'direct-agent', pipeline: 'direct', lane: 'control', storyIndex: null,
        workItemId: itemId, workItemRevision: 1, workItemEpoch: 1 } });
    acquireResourceClaimInDb(db, { resourceKey: CODE_WORKSPACE_RESOURCE, taskId, lane: 'control', executionId: other.attempt.execution_id });
    const claim = db.prepare('SELECT * FROM resource_claims WHERE owner_execution_id = ?').get(other.attempt.execution_id);
    if (outcome === 'block') await blockDelegation(work, 'Cannot establish the Test result safely', executionId);
    else {
      const result = agentResultSchema.parse({ outcome: 'completed', verdict: 'passed', summary: 'Independent verification passed.' });
      await markExecutionOutput(executionId, result);
      assert.equal(await applyAgentResult(`RUN-role-${taskId}`, work, result, { executionId }), 'advanced');
    }
    assert.deepEqual(db.prepare('SELECT * FROM resource_claims WHERE owner_execution_id = ?').get(other.attempt.execution_id), claim);
    assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(itemId) as { status: string }).status, 'running');
  } finally { await cancelTask({ taskId, reason: 'Finish domain Test ownership fixture' }); }
});

test('legacy task update cannot bypass native Work Item gates but metadata remains editable', async () => {
  const { db, taskId } = await fixture();
  const before = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId);
  for (const changes of [{ agile_status: 'blocked' as const }, { dev_index: 1 }, { run_state: 'runnable' as const },
    { current_subagent: 'review-agent' }, { review_document_id: 'invented-report' }, { item_type: 'direct' }]) {
    await assert.rejects(updateTask(taskId, 'system', changes), /不能通过旧任务状态接口/);
  }
  await assert.rejects(initializeTaskContext({ taskId, actor: 'human', status: 'in plan' }), /旧上下文初始化接口/);
  await assert.rejects(setTaskLaneState({ taskId, lane: 'delivery', status: 'completed' }), /显示投影/);
  await updateTask(taskId, 'human', { priority: '8', title: 'Updated native metadata' });
  const detail = await getTask(taskId);
  assert.equal(detail?.task.priority, '8');
  assert.equal(detail?.task.title, 'Updated native metadata');
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId), before);
});

test('native role-block transaction rolls back Intervention, graph and resources if display publication fails', async () => {
  const { db, taskId, work, executionId } = await fixture(true);
  const result = agentResultSchema.parse({ outcome: 'failed', verdict: 'failed', failureKind: 'environment', summary: 'Runtime cannot start.' });
  await markExecutionOutput(executionId, result);
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId);
  const claim = resourceClaimInDb(db, 'code:workspace', taskId);
  db.exec(`CREATE TRIGGER reject_role_block_display BEFORE UPDATE OF next_step ON tasks
    WHEN NEW.task_id = '${taskId}' BEGIN SELECT RAISE(ABORT, 'role block publication rejected'); END`);
  try {
    await assert.rejects(applyAgentResult(`RUN-role-${taskId}`, work, result, { executionId }),
      (error) => /role block publication rejected/.test(String((error as { message: string }).message)));
    assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId), graph);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM interventions WHERE task_id = ?').get(taskId) as { count: number }).count, 0);
    assert.deepEqual(resourceClaimInDb(db, 'code:workspace', taskId), claim);
  } finally { db.exec('DROP TRIGGER reject_role_block_display'); }
});
