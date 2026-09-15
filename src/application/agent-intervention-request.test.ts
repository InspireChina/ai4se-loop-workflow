import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { databaseConnection } from '../infrastructure/database';
import { agentResultSchema, assertAgentResultRoleContract } from '../domain/agent-result';
import { createTask, pauseTask, cancelTask } from '../test/legacy-task-fixtures';
import { adoptNativeWorkflowInDb } from './work-item-transitions';
import { issueAgentCommandToken, readAgentCommandSubmission, runAgentCommand } from './agent-command-drafts';
import { applyAgentResult, applyNextQueuedAgentResult } from './agent-results';
import { completeExecution } from './executions';
import { acquireResourceClaimInDb, CODE_WORKSPACE_RESOURCE, BROWSER_EXCLUSIVE_RESOURCE } from './resource-claims';

const args = ['intervention', 'request', '--summary', '需要仲裁范围矛盾',
  '--reason', '当前阶段无法可靠化解冲突', '--evidence', '持久化契约与实际入口不一致，调查证据保留在当前执行记录'];

async function start(itemType: 'feature' | 'direct' | 'business-analysis', native: boolean) {
  const db = await databaseConnection();
  const taskId = await createTask({ title: '通用介入交接', itemType });
  if (native) adoptNativeWorkflowInDb(db, taskId);
  const delegation = (await inspectTaskDispatchEnvelope(taskId))[0];
  assert.ok(delegation);
  const begun = await beginTestExecutionAttempt({ runId: `RUN-${taskId}`, delegation, prompt: 'handoff' });
  const executionId = begun.attempt.execution_id;
  const token = await issueAgentCommandToken(executionId);
  assert.ok(token);
  const run = (command: string[]) => runAgentCommand({ executionId, token, args: command });
  await run(itemType === 'direct' ? ['direct', 'run'] : ['status']);
  return { db, taskId, delegation, executionId, run };
}

for (const native of [false, true]) for (const itemType of ['feature', 'direct', 'business-analysis'] as const) {
  test(`${itemType} supports durable, idempotent intervention handoff (${native ? 'native' : 'legacy'})`, async () => {
    const current = await start(itemType, native);
    const { db, taskId, delegation, executionId, run } = current;
    if (itemType === 'direct') acquireResourceClaimInDb(db, { resourceKey: CODE_WORKSPACE_RESOURCE,
      taskId, lane: 'control', executionId });
    await assert.rejects(run([...args, '--task-id', 'other-task']), /目标由当前 execution 决定/);
    assert.equal(await readAgentCommandSubmission(executionId), null);
    assert.match(await run(args), /Outcome: submitted/);
    assert.match(await run(args), /already_submitted/);
    await assert.rejects(run(args.map((value) => value === '需要仲裁范围矛盾' ? '改变历史请求' : value)), /不能改写历史请求/);
    await assert.rejects(run(itemType === 'direct' ? ['direct', 'submit', '--summary', '已完成'] : ['phase', 'complete']), /已提交介入请求/);
    const result = await readAgentCommandSubmission(executionId);
    assert.ok(result?.intervention);
    assert.doesNotThrow(() => assertAgentResultRoleContract(result, delegation.agent));
    await assert.rejects(applyAgentResult('RUN-forged', delegation,
      { ...result, intervention: { ...result.intervention, reason: '改写交接内容' } }), /已认证|提供来源执行/);
    assert.equal(await applyAgentResult('RUN-handoff', delegation, result, { executionId }), 'blocked');
    await completeExecution(executionId);
    assert.equal(await applyAgentResult('RUN-handoff', delegation, result, { executionId }), 'blocked');
    const rows = db.prepare('SELECT item_id, status, authority FROM interventions WHERE source_execution_id = ?')
      .all(executionId) as { item_id: string; status: string; authority: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].authority, 'arbitration');
    assert.ok(rows[0].item_id, 'legacy handoff also binds its projected Work Item');
    if (native) assert.equal(rows[0].item_id, delegation.workItemId);
    assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?')
      .get(rows[0].item_id) as { status: string }).status, 'waiting');
    assert.equal((db.prepare('SELECT dispatch_retry_consumed FROM execution_attempts WHERE execution_id = ?')
      .get(executionId) as { dispatch_retry_consumed: number }).dispatch_retry_consumed, 0);
    assert.equal((await inspectTaskDispatchEnvelope(taskId)).length, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM resource_claims WHERE owner_task_id = ?')
      .get(taskId) as { count: number }).count, 0);
  });
}

test('queued output recovery applies an intervention submission without repeating the Agent', async () => {
  const { db, taskId, executionId, run } = await start('feature', true);
  await run(args);
  const result = await readAgentCommandSubmission(executionId);
  assert.ok(result);
  db.prepare(`INSERT INTO agent_results(result_id, run_id, task_id, agent, pipeline, outcome, result_json, execution_id, application_status)
    VALUES(?, 'RUN-queued', ?, 'backlog-agent', 'backlog', 'needs_input', ?, ?, 'pending')`)
    .run(`RESULT-${executionId}`, taskId, JSON.stringify(result), executionId);
  const applied = await applyNextQueuedAgentResult();
  assert.equal(applied.status, 'applied');
  if (applied.status === 'applied') {
    assert.equal(applied.taskId, taskId);
    assert.equal(applied.outcome, 'blocked');
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM interventions WHERE source_execution_id = ?')
    .get(executionId) as { count: number }).count, 1);
});

test('native handoff releases only its source claims, not an independent Work Item code slot in the same control Lane', async () => {
  const { db, taskId, delegation, executionId, run } = await start('direct', true);
  try {
    const itemId = randomUUID();
    db.prepare(`INSERT INTO workflow_items(item_id, task_id, work_key, revision, kind, title, agent, pipeline, lane, status, origin)
      VALUES(?, ?, 'fixture:independent-code-owner', 1, 'fixture', 'Independent code owner', 'direct-agent', 'direct', 'control', 'ready', 'native')`)
      .run(itemId, taskId);
    const other = await beginTestExecutionAttempt({ runId: `RUN-independent-${taskId}`,
      delegation: { ...delegation, workItemId: itemId, workItemRevision: 1, workItemEpoch: 1 }, prompt: 'Domain-only independent ownership fixture' });
    acquireResourceClaimInDb(db, { resourceKey: CODE_WORKSPACE_RESOURCE, taskId, lane: 'control', executionId: other.attempt.execution_id });
    // Historical execution-scoped claim remains supported for migration.
    acquireResourceClaimInDb(db, { resourceKey: BROWSER_EXCLUSIVE_RESOURCE, taskId, lane: 'control', executionId });
    const claim = db.prepare('SELECT * FROM resource_claims WHERE owner_execution_id = ?').get(other.attempt.execution_id);
    await run(args);
    const result = await readAgentCommandSubmission(executionId);
    assert.ok(result);
    assert.equal(await applyAgentResult('RUN-isolated-handoff', delegation, result, { executionId }), 'blocked');
    assert.equal(db.prepare('SELECT 1 FROM resource_claims WHERE owner_execution_id = ?').get(executionId), undefined);
    assert.deepEqual(db.prepare('SELECT * FROM resource_claims WHERE owner_execution_id = ?').get(other.attempt.execution_id), claim);
    assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(itemId) as { status: string }).status, 'running');
    assert.equal((db.prepare('SELECT status FROM execution_attempts WHERE execution_id = ?').get(other.attempt.execution_id) as { status: string }).status, 'running');
  } finally { await cancelTask({ taskId, reason: 'Finish domain resource ownership fixture' }); }
});

test('a request returned after pause remains evidence and cannot re-activate the work', async () => {
  const { db, taskId, delegation, executionId, run } = await start('feature', true);
  await run(args);
  const result = await readAgentCommandSubmission(executionId);
  assert.ok(result);
  await pauseTask({ taskId });
  assert.equal(await applyAgentResult('RUN-paused-handoff', delegation, result, { executionId }), 'discarded');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM interventions WHERE source_execution_id = ?')
    .get(executionId) as { count: number }).count, 0);
});

test('intervention handoff cannot be mixed with fabricated completion or phase effects', () => {
  const result = agentResultSchema.parse({ outcome: 'needs_input', summary: '阻塞',
    intervention: { reason: '范围矛盾', evidence: '实际入口与冻结契约不同' } });
  for (const agent of ['dev-agent', 'test-agent', 'review-agent', 'direct-agent', 'spec-review-agent']) {
    assert.doesNotThrow(() => assertAgentResultRoleContract(result, agent));
    assert.throws(() => assertAgentResultRoleContract({ ...result, outcome: 'completed' }, agent), /不能声明完成/);
    assert.throws(() => assertAgentResultRoleContract({ ...result, verdict: 'passed' }, agent), /不能同时提交/);
  }
});
