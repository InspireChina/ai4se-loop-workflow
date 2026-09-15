import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { createTask, pauseTask } from '../test/legacy-task-fixtures';
import { adoptNativeWorkflowInDb } from './work-item-transitions';
import { openIntervention, claimNextIntervention, finishInterventionAttempt, runHumanArbitrationCommand } from './interventions';
import { acquireResourceClaimInDb, BROWSER_EXCLUSIVE_RESOURCE, CODE_WORKSPACE_RESOURCE } from './resource-claims';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { toEnvelope } from './dispatch-planner';
import { getTask, getTaskContext, cancelTask } from './tasks';
import { buildAgentContextSnapshot, renderAgentContextOverview, renderAgentWorkingContextPack } from './agent-context';
import { cancelExecution, executionCancellationReason, executionCancellationRequested } from './executions';
import { applyAgentResult } from './agent-results';
import { agentResultSchema } from '../domain/agent-result';

async function setup(agent: 'dev-agent' | 'test-agent' | 'business-design-agent' = 'test-agent', human = true, activePrimary = false) {
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET is_paused = 1, agile_status = 'cancelled' WHERE agile_status NOT IN ('done', 'cancelled')").run();
  const taskId = await createTask({ title: 'Human arbitration', itemType: agent === 'business-design-agent' ? 'business-analysis' : 'feature' });
  if (agent === 'business-design-agent') db.prepare("UPDATE tasks SET current_subagent = 'business-design-agent' WHERE task_id = ?").run(taskId);
  else {
    db.prepare(`UPDATE tasks SET agile_status = 'in dev', current_subagent = ?, total_stories = 1,
      analysis_index = 1, spec_resolved_index = 1, dev_index = ?, test_index = 0 WHERE task_id = ?`).run(agent, agent === 'test-agent' ? 1 : 0, taskId);
    db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Arbitrated unit', 'story-001')").run(taskId);
  }
  const item = adoptNativeWorkflowInDb(db, taskId).find((item) => item.agent === agent)!;
  const executionId = randomUUID();
  db.prepare(`INSERT INTO execution_attempts(execution_id, work_item_id, run_id, task_id, agent, pipeline, story_index,
    delegation_key, attempt, work_item_attempt, status, input_hash, input_json, result_json)
    VALUES(?, ?, 'RUN-original-failure', ?, ?, ?, ?, ?, 1, 1, 'applied', 'input', '{}', ?)`)
    .run(executionId, item.item_id, taskId, agent, item.pipeline, item.story_index, executionId,
      JSON.stringify({ outcome: 'completed', verdict: 'failed', summary: 'Original observed contract conflict' }));
  const primary = activePrimary ? await beginTestExecutionAttempt({ runId: 'RUN-inflight-arbitration-primary', prompt: 'Domain-only active primary fixture',
    delegation: toEnvelope((await getTask(taskId))!.task, { taskId, lane: agent === 'business-design-agent' ? 'control' : 'delivery', pipeline: item.pipeline!, agent,
      storyIndex: item.story_index, resources: [], description: 'Active primary before an external arbitration',
      workItemId: item.item_id, workItemRevision: item.revision, workItemEpoch: item.dispatch_epoch }) }) : null;
  const intervention = await openIntervention({ taskId, itemId: item.item_id, requestedBy: agent, sourceExecutionId: executionId,
    dedupeKey: `arbitration:${executionId}`, summary: 'Resolve a contract conflict using existing commands', authority: 'arbitration',
    resolverStrategy: 'system_then_human', maxSystemAttempts: 3 });
  if (human) for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = await claimNextIntervention({ runId: 'RUN-system-arbitration', executorId: 'claude', executionOptions: {} });
    assert.equal(claimed?.interventionId, intervention.intervention_id);
    await finishInterventionAttempt({ interventionId: intervention.intervention_id, reason: `Cannot safely resolve ${attempt}`, outcome: 'deferred' });
  }
  return { db, taskId, item, executionId, primaryExecutionId: primary?.attempt.execution_id, interventionId: intervention.intervention_id };
}

test('downstream native context freezes arbitration reasons without turning an original Test failure into passed evidence', async () => {
  const { db, taskId, item, executionId, interventionId } = await setup();
  const reason = 'Reviewed unit ownership; this acceptance belongs to the downstream unit, not this Test step.';
  const original = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId);
  await runHumanArbitrationCommand({ taskId, interventionId,
    args: ['intervention', 'work-item-complete', '--reason', reason] });
  const full = await getTaskContext(taskId);
  const review = full.nativeWorkflow!.items.find(work => work.work_key === 'delivery:review')!;
  const snapshot = buildAgentContextSnapshot({ full, activeFeedback: [], activeRecovery: [],
    delegation: toEnvelope(full.task, { taskId, lane: 'delivery', pipeline: 'review', agent: 'review-agent',
      storyIndex: null, resources: [], description: 'Reconcile actual facts and arbitration', workItemId: review.item_id,
      workItemRevision: review.revision, workItemEpoch: review.dispatch_epoch }) });
  const control = snapshot.resources.find(resource => resource.ref === `WORKITEM:${item.item_id}:r${item.revision}`)!;
  assert.equal(control.kind, 'work_item');
  assert.equal(control.status, 'completed');
  assert.equal((control.content as { arbitrationReason: string }).arbitrationReason, reason);
  const resolution = snapshot.resources.find(resource => resource.ref === `INTERVENTION:${interventionId}`)!;
  assert.equal(resolution.status, 'resolved');
  assert.equal(resolution.authority, 'execution_evidence');
  assert.equal((resolution.content as { resolution: string }).resolution, reason);
  assert.ok(snapshot.requiredContextRefs.includes(control.ref));
  assert.match(renderAgentWorkingContextPack(snapshot), /仲裁完成不等于独立测试通过/);
  assert.match(renderAgentContextOverview(snapshot), /Original observed contract conflict/);
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId), original);
  db.prepare('UPDATE workflow_items SET completion_reason = ? WHERE item_id = ?').run('Later mutable display change', item.item_id);
  assert.equal((control.content as { arbitrationReason: string }).arbitrationReason, reason);
});

for (const agent of ['dev-agent', 'test-agent'] as const) test(`human completes the linked native ${agent} after three system attempts without falsifying evidence or consuming quota`, async () => {
  const { db, taskId, item, executionId, interventionId } = await setup(agent);
  const evidence = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId);
  const attempts = db.prepare('SELECT * FROM intervention_attempts WHERE intervention_id = ? ORDER BY attempt').all(interventionId);
  const args = ['intervention', 'work-item-complete', '--reason', 'UI acceptance belongs to the downstream unit; reviewed the frozen contract and unit ownership.'];
  assert.match(await runHumanArbitrationCommand({ taskId, interventionId, args }), /已由仲裁完成/);
  const completed = db.prepare('SELECT status, completion_authority FROM workflow_items WHERE item_id = ?').get(item.item_id) as { status: string; completion_authority: string };
  assert.equal(completed.status, 'completed');
  assert.equal(completed.completion_authority, 'arbitration');
  const resolved = db.prepare('SELECT status, resolved_by FROM interventions WHERE intervention_id = ?').get(interventionId) as { status: string; resolved_by: string };
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolved_by, 'human');
  assert.equal((db.prepare("SELECT actor FROM workflow_item_events WHERE item_id = ? AND event_type = 'complete'").get(item.item_id) as { actor: string }).actor, 'human');
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId), evidence);
  assert.deepEqual(db.prepare('SELECT * FROM intervention_attempts WHERE intervention_id = ? ORDER BY attempt').all(interventionId), attempts);
  const events = db.prepare('SELECT * FROM workflow_item_events WHERE item_id = ? ORDER BY rowid').all(item.item_id);
  assert.match(await runHumanArbitrationCommand({ taskId, interventionId, args }), /未重复推进/);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_item_events WHERE item_id = ? ORDER BY rowid').all(item.item_id), events);
  await assert.rejects(runHumanArbitrationCommand({ taskId, interventionId, args: ['intervention', 'task-rewind', '--to', 'delivery:plan', '--reason', args[3]] }), /不能改写/);
});

test('human arbitration reuses generic BA graph rewind and cannot bypass the required artifact by completing it', async () => {
  const { db, taskId, item, interventionId } = await setup('business-design-agent');
  await assert.rejects(runHumanArbitrationCommand({ taskId, interventionId, args: ['intervention', 'work-item-complete', '--reason', 'Skip design'] }), /当前 Dev\/Test/);
  const intent = db.prepare("SELECT item_id, completed_at FROM workflow_items WHERE task_id = ? AND work_key = 'ba:intent'").get(taskId) as { item_id: string; completed_at: string };
  await runHumanArbitrationCommand({ taskId, interventionId, args: ['intervention', 'task-rewind', '--to', 'ba:intent', '--reason', 'The upstream intention contradicts the requested behavior.'] });
  const old = db.prepare('SELECT status, completed_at FROM workflow_items WHERE item_id = ?').get(intent.item_id) as { status: string; completed_at: string };
  assert.equal(old.status, 'superseded');
  assert.equal(old.completed_at, intent.completed_at);
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(item.item_id) as { status: string }).status, 'superseded');
  assert.equal((db.prepare("SELECT actor FROM workflow_item_events WHERE item_id = ? AND event_type = 'rewind'").get(intent.item_id) as { actor: string }).actor, 'human');
  assert.ok(db.prepare("SELECT 1 FROM workflow_items WHERE task_id = ? AND work_key = 'ba:intent' AND revision = 2 AND status = 'ready'").get(taskId));
});

test('human arbitration rejects wrong task, early takeover, pause and non-arbitration input without graph effects', async () => {
  const { db, taskId, item, interventionId } = await setup('test-agent', false);
  const args = ['intervention', 'work-item-complete', '--reason', 'Reviewed original evidence'];
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId);
  await assert.rejects(runHumanArbitrationCommand({ taskId: 'Other task', interventionId, args }), /没有该仲裁/);
  await assert.rejects(runHumanArbitrationCommand({ taskId, interventionId, args }), /尚未交接人工/);
  const standard = await openIntervention({ taskId, itemId: item.item_id, requestedBy: 'human', dedupeKey: 'ordinary-human-input',
    summary: 'Ordinary input', resolverStrategy: 'human_only' });
  await assert.rejects(runHumanArbitrationCommand({ taskId, interventionId: standard.intervention_id, args }), /没有该仲裁/);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId), graph);
  db.prepare("UPDATE interventions SET status = 'awaiting_human' WHERE intervention_id = ?").run(interventionId);
  await pauseTask({ taskId });
  await assert.rejects(runHumanArbitrationCommand({ taskId, interventionId, args }), /已暂停/);
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(item.item_id) as { status: string }).status, 'waiting');
});

test('native arbitration rolls back completion, events and resolution when the resolution transaction fails', async () => {
  const { db, taskId, item, interventionId } = await setup('test-agent', true, true);
  const graph = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId);
  const sources = db.prepare('SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY execution_id').all(taskId);
  const events = db.prepare('SELECT * FROM workflow_item_events WHERE item_id = ? ORDER BY rowid').all(item.item_id);
  db.exec("CREATE TRIGGER reject_arbitration_resolution BEFORE UPDATE OF status ON interventions WHEN NEW.status = 'resolved' BEGIN SELECT RAISE(ABORT, 'Injected resolution failure'); END;");
  try {
    await assert.rejects(runHumanArbitrationCommand({ taskId, interventionId, args: ['intervention', 'work-item-complete', '--reason', 'Reviewed the frozen contract and downstream ownership.'] }), /Injected resolution failure/);
    assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY rowid').all(taskId), graph);
    assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY execution_id').all(taskId), sources);
    assert.deepEqual(db.prepare('SELECT * FROM workflow_item_events WHERE item_id = ? ORDER BY rowid').all(item.item_id), events);
    assert.equal((db.prepare('SELECT status FROM interventions WHERE intervention_id = ?').get(interventionId) as { status: string }).status, 'awaiting_human');
  } finally { db.exec('DROP TRIGGER reject_arbitration_resolution'); }
});

for (const agent of ['dev-agent','test-agent'] as const) test(`arbitration completion cancels the in-flight ${agent} source but retains the original failure evidence`, async () => {
  const { db, taskId, item, executionId, primaryExecutionId, interventionId } = await setup(agent, true, true);
  assert.ok(primaryExecutionId);
  const original = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId);
  const primary = db.prepare('SELECT input_json, input_hash, result_json FROM execution_attempts WHERE execution_id = ?').get(primaryExecutionId);
  assert.equal(await executionCancellationRequested(primaryExecutionId), false);
  await runHumanArbitrationCommand({ taskId, interventionId, args: ['intervention','work-item-complete','--reason', 'Reviewed the contract and replaced the active work with the authoritative disposition.'] });
  assert.equal(await executionCancellationRequested(primaryExecutionId), true);
  const cancellationReason = await executionCancellationReason(primaryExecutionId);
  assert.match(cancellationReason, /仲裁/);
  assert.doesNotMatch(cancellationReason, /需求已取消/);
  const cancelledSource = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(primaryExecutionId);
  await cancelExecution(primaryExecutionId, cancellationReason);
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(primaryExecutionId), cancelledSource);
  assert.equal((db.prepare('SELECT status FROM execution_attempts WHERE execution_id = ?').get(primaryExecutionId) as { status: string }).status, 'cancelled');
  assert.equal(await applyAgentResult('RUN-late-after-arbitration', toEnvelope((await getTask(taskId))!.task, {
    taskId, lane: 'delivery', pipeline: item.pipeline!, agent, storyIndex: item.story_index, resources: [], description: 'Late cancelled primary',
    workItemId: item.item_id, workItemRevision: item.revision, workItemEpoch: item.dispatch_epoch }),
    agentResultSchema.parse({ outcome: 'completed', summary: 'Late output after authoritative replacement' }), { executionId: primaryExecutionId }), 'discarded');
  assert.deepEqual(db.prepare('SELECT input_json, input_hash, result_json FROM execution_attempts WHERE execution_id = ?').get(primaryExecutionId), primary);
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId), original);
  assert.equal((db.prepare('SELECT completion_authority FROM workflow_items WHERE item_id = ?').get(item.item_id) as { completion_authority: string }).completion_authority, 'arbitration');
});

for (const decision of ['complete', 'rewind-dev', 'rewind-plan'] as const) test(`native Test arbitration ${decision} releases only affected Work Item resources, not another source code slot`, async () => {
  const { db, taskId, item, executionId, interventionId } = await setup();
  try {
    const otherItemId = randomUUID();
    db.prepare(`INSERT INTO workflow_items(item_id, task_id, work_key, revision, kind, title, agent, pipeline, lane, status, origin)
      VALUES(?, ?, 'fixture:arbitration-other-source', 1, 'fixture', 'Independent code source', 'direct-agent', 'direct', 'control', 'ready', 'native')`)
      .run(otherItemId, taskId);
    const detail = await getTask(taskId);
    const other = await beginTestExecutionAttempt({ runId: 'RUN-arbitration-independent-source', prompt: 'Domain-only ownership fixture',
      delegation: toEnvelope(detail!.task, { taskId, lane: 'control', pipeline: 'direct', agent: 'direct-agent', storyIndex: null,
        resources: [CODE_WORKSPACE_RESOURCE], description: 'Independent source', workItemId: otherItemId,
        workItemRevision: 1, workItemEpoch: 1 }) });
    acquireResourceClaimInDb(db, { resourceKey: CODE_WORKSPACE_RESOURCE, taskId, lane: 'control', executionId: other.attempt.execution_id });
    acquireResourceClaimInDb(db, { resourceKey: BROWSER_EXCLUSIVE_RESOURCE, taskId, lane: 'delivery', executionId });
    const otherClaim = db.prepare('SELECT * FROM resource_claims WHERE owner_execution_id = ?').get(other.attempt.execution_id);
    const originalFailure = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId);
    await runHumanArbitrationCommand({ taskId, interventionId,
      args: decision === 'complete'
        ? ['intervention', 'work-item-complete', '--reason', 'Reviewed the frozen contract conflict and its downstream ownership.']
        : ['intervention', 'task-rewind', '--to', decision === 'rewind-dev' ? 'delivery:dev:1' : 'delivery:plan',
          '--reason', 'Reviewed the frozen contract conflict and its downstream ownership.'] });
    assert.equal(db.prepare('SELECT * FROM resource_claims WHERE owner_execution_id = ?').get(executionId), undefined);
    assert.deepEqual(db.prepare('SELECT * FROM resource_claims WHERE owner_execution_id = ?').get(other.attempt.execution_id), otherClaim);
    assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(executionId), originalFailure);
    assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(otherItemId) as { status: string }).status, 'running');
    assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(item.item_id) as { status: string }).status,
      decision === 'complete' ? 'completed' : 'superseded');
  } finally { await cancelTask({ taskId, reason: 'Finish domain arbitration ownership fixture' }); }
});
