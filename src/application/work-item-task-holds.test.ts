import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { databaseConnection, hash } from '../infrastructure/database';
import { createTask, getTask, releaseBlock, cancelTask } from '../test/legacy-task-fixtures';
import { adoptNativeWorkflowInDb, transitionWorkItemInDb } from './work-item-transitions';
import { nativeTaskHoldInDb, workflowBlockedInDb } from './work-item-controls';
import { openInterventionInDb, claimNextIntervention } from './interventions';
import { inspectTaskDispatchEnvelope } from '../test/dispatch-inspection-fixtures';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { agentCommandProfile } from '../domain/agent-command-profile';
import { issueAgentCommandToken } from './agent-command-drafts';

async function legacyBlocked() {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused = 1').run();
  const taskId = await createTask({ title: 'Historical human hold' });
  db.prepare(`UPDATE tasks SET agile_status = 'blocked', run_state = 'system_blocked',
    blocked_reason = 'Operator explicitly stopped this requirement', last_actor = 'human',
    resume_status = 'backlog' WHERE task_id = ?`).run(taskId);
  const nodes = adoptNativeWorkflowInDb(db, taskId);
  return { db, taskId, context: nodes.find(item => item.work_key === 'delivery:context')! };
}

for (const [workKey, pipeline] of [['delivery:plan', 'split'], ['delivery:review', 'review']] as const) {
  test(`native ${pipeline} recovery retains its supported pipeline instead of inventing resume protocol`, async () => {
    const db = await databaseConnection();
    db.prepare('UPDATE tasks SET is_paused = 1').run();
    const taskId = await createTask({ title: `Actual ${pipeline} recovery protocol` });
    const items = adoptNativeWorkflowInDb(db, taskId);
    const target = items.find(item => item.work_key === workKey)!;
    db.prepare("UPDATE workflow_items SET status = 'completed' WHERE task_id = ? AND item_id != ? AND kind != 'closure'").run(taskId, target.item_id);
    db.prepare("UPDATE workflow_items SET status = 'ready', resume_pending = 1 WHERE item_id = ?").run(target.item_id);
    const work = (await inspectTaskDispatchEnvelope(taskId))[0];
    assert.equal(work.workItemId, target.item_id);
    assert.equal(work.pipeline, pipeline);
    assert.ok(agentCommandProfile(work.agent, work.pipeline));
    assert.equal(agentCommandProfile(work.agent, 'resume'), null);
    const started = await beginTestExecutionAttempt({ runId: 'RUN-protocol-recovery', delegation: work, prompt: 'Supported recovery protocol' });
    assert.ok(await issueAgentCommandToken(started.attempt.execution_id));
  });
}

test('legacy task block becomes one task-wide human Intervention with preserved intent, explicit recovery and replay', async () => {
  const { db, taskId, context } = await legacyBlocked();
  const hold = nativeTaskHoldInDb(db, taskId)!;
  assert.equal(hold.summary, 'Operator explicitly stopped this requirement');
  assert.equal(JSON.parse(hold.context_json).originalTask.last_actor, 'human');
  assert.equal(workflowBlockedInDb(db, taskId), true);
  assert.deepEqual(await inspectTaskDispatchEnvelope(taskId), []);
  assert.equal((await getTask(taskId))?.task.blocked_reason, hold.summary);
  db.prepare("UPDATE tasks SET agile_status = 'backlog', run_state = 'runnable', blocked_reason = NULL WHERE task_id = ?").run(taskId);
  assert.deepEqual(await inspectTaskDispatchEnvelope(taskId), []);
  assert.throws(() => transitionWorkItemInDb(db, { itemId: context.item_id, action: 'resume', eventKey: 'illegal-bypass',
    actor: 'system', authority: 'arbitration', reason: 'Do not bypass an operator hold' }), /暂停或结束/);
  await releaseBlock(taskId);
  assert.equal(nativeTaskHoldInDb(db, taskId), undefined);
  assert.equal((await inspectTaskDispatchEnvelope(taskId))[0]?.agent, 'backlog-agent');
  const events = db.prepare('SELECT * FROM workflow_item_events WHERE item_id = ? ORDER BY rowid').all(context.item_id);
  db.prepare("UPDATE tasks SET agile_status = 'blocked', resume_status = 'in dev' WHERE task_id = ?").run(taskId);
  adoptNativeWorkflowInDb(db, taskId);
  assert.equal(nativeTaskHoldInDb(db, taskId), undefined);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_item_events WHERE item_id = ? ORDER BY rowid').all(context.item_id), events);
  assert.equal((await getTask(taskId))?.task.agile_status, 'backlog');
});

for (const linked of ['arbitration', 'answered-input', 'exhausted-source'] as const) test(`task hold release cannot bypass separate ${linked} obligation`, async () => {
  const { db, taskId, context } = await legacyBlocked();
  if (linked === 'exhausted-source') db.prepare(`INSERT INTO execution_attempts(execution_id,run_id,task_id,
    agent,pipeline,delegation_key,attempt,status,input_hash,input_json,work_item_id,work_item_attempt,failure_kind,dispatch_retry_consumed,dispatch_generation_key)
    VALUES(?,'RUN-hold-failure',?,'backlog-agent','backlog',?,5,'system_blocked','input','{}',?,5,'agent-cli-exit',1,?)`)
    .run(randomUUID(), taskId, randomUUID(), context.item_id, hash(JSON.stringify({ itemId: context.item_id, epoch: context.dispatch_epoch })));
  else {
    const intervention = openInterventionInDb(db, { taskId, itemId: context.item_id, dedupeKey: `fixture:${linked}`,
      summary: 'Independent obligation', requestedBy: 'backlog-agent',
      resolverStrategy: linked === 'arbitration' ? 'system_then_human' : 'human_only',
      authority: linked === 'arbitration' ? 'arbitration' : 'standard' });
    if (linked === 'answered-input') {
      db.prepare("UPDATE interventions SET status = 'resolved' WHERE intervention_id = ?").run(intervention.intervention_id);
      db.prepare(`INSERT INTO questions(question_id,task_id,kind,title,question,status,answer,intervention_id)
        VALUES(?,?,'local','Saved answer','Still needs explicit batch submission','answered','Windows',?)`)
        .run(randomUUID(), taskId, intervention.intervention_id);
    }
  }
  const sourceBefore = db.prepare('SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY rowid').all(taskId);
  await releaseBlock(taskId);
  assert.equal(nativeTaskHoldInDb(db, taskId), undefined);
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(context.item_id) as { status: string }).status, 'waiting');
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY rowid').all(taskId), sourceBefore);
});

test('system assistance stays gated by a task-wide human hold and cancellation closes the hold', async () => {
  const { db, taskId, context } = await legacyBlocked();
  openInterventionInDb(db, { taskId, itemId: context.item_id, dedupeKey: 'fixture:aux',
    summary: 'Agent requested help', requestedBy: 'backlog-agent' });
  assert.equal(await claimNextIntervention({ runId: 'RUN-gated-aux', executorId: 'claude', executionOptions: {} }), null);
  await cancelTask({ taskId, reason: 'Operator cancelled instead' });
  assert.equal(nativeTaskHoldInDb(db, taskId), undefined);
  await assert.rejects(releaseBlock(taskId));
});

test('hold resolution and graph resume roll back together on a publication failure', async () => {
  const { db, taskId, context } = await legacyBlocked();
  const hold = nativeTaskHoldInDb(db, taskId)!;
  db.exec(`CREATE TRIGGER fail_hold_resume BEFORE INSERT ON workflow_item_events
    WHEN NEW.event_key LIKE 'human-task-hold:%' BEGIN SELECT RAISE(ABORT,'hold-resume-failure'); END`);
  await assert.rejects(releaseBlock(taskId), /hold-resume-failure/);
  assert.equal(nativeTaskHoldInDb(db, taskId)?.intervention_id, hold.intervention_id);
  assert.equal((db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(context.item_id) as { status: string }).status, 'waiting');
  db.exec('DROP TRIGGER fail_hold_resume');
  await releaseBlock(taskId);
  assert.equal(nativeTaskHoldInDb(db, taskId), undefined);
});

test('upgrade migration captures old native holds once, drains actual work and never recreates resolved intent', async () => {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused = 1').run();
  const taskId = await createTask({ title: 'Old native hold upgrade' });
  adoptNativeWorkflowInDb(db, taskId);
  const work = (await inspectTaskDispatchEnvelope(taskId))[0];
  const started = await beginTestExecutionAttempt({ runId: 'RUN-hold-upgrade', delegation: work, prompt: 'Original context' });
  const assistance = openInterventionInDb(db, { taskId, itemId: work.workItemId, dedupeKey: 'fixture:upgrade-aux',
    summary: 'Active assistance at upgrade', requestedBy: 'backlog-agent' });
  const claimed = await claimNextIntervention({ runId: 'RUN-upgrade-aux', executorId: 'claude', executionOptions: {} });
  assert.equal(claimed?.interventionId, assistance.intervention_id);
  db.prepare("UPDATE tasks SET agile_status = 'blocked', blocked_reason = 'Old native operator hold' WHERE task_id = ?").run(taskId);
  const migration = readFileSync(resolve(process.cwd(), 'migrations/120_native_task_hold_intents.sql'), 'utf8');
  db.transaction(() => db.exec(migration))();
  assert.ok(nativeTaskHoldInDb(db, taskId));
  const stopped = db.prepare('SELECT status,dispatch_retry_consumed,input_json FROM execution_attempts WHERE execution_id = ?')
    .get(started.attempt.execution_id) as { status: string; dispatch_retry_consumed: number; input_json: string };
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.dispatch_retry_consumed, 0);
  assert.equal(stopped.input_json, started.attempt.input_json);
  const auxiliary = db.prepare('SELECT status,attempt_count,current_execution_id FROM interventions WHERE intervention_id = ?')
    .get(assistance.intervention_id) as { status: string; attempt_count: number; current_execution_id: string | null };
  assert.deepEqual(auxiliary, { status: 'pending', attempt_count: 0, current_execution_id: null });
  assert.equal((db.prepare('SELECT status FROM intervention_attempts WHERE execution_id = ?').get(claimed!.executionId) as { status: string }).status, 'cancelled');
  await releaseBlock(taskId);
  db.prepare("UPDATE tasks SET agile_status = 'blocked' WHERE task_id = ?").run(taskId);
  db.transaction(() => db.exec(migration))();
  assert.equal(nativeTaskHoldInDb(db, taskId), undefined);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM interventions WHERE task_id = ? AND dedupe_key = 'native:adopt:task-blocked'")
    .get(taskId) as { count: number }).count, 1);
});

test('upgrade does not turn a stale blocked badge on a genuinely ended native graph into a new hold', async () => {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused = 1').run();
  const taskId = await createTask({ title: 'Ended native direct', itemType: 'direct' });
  const direct = adoptNativeWorkflowInDb(db, taskId).find(item => item.work_key === 'direct:execute')!;
  transitionWorkItemInDb(db, { itemId: direct.item_id, action: 'complete', eventKey: 'fixture-direct-ended',
    actor: 'human', authority: 'human', reason: 'Actual fixture completion' });
  db.prepare("UPDATE tasks SET agile_status = 'blocked' WHERE task_id = ?").run(taskId);
  db.transaction(() => db.exec(readFileSync(resolve(process.cwd(), 'migrations/120_native_task_hold_intents.sql'), 'utf8')))();
  assert.equal(nativeTaskHoldInDb(db, taskId), undefined);
  assert.equal((await getTask(taskId))?.task.agile_status, 'done');
});

test('hold adoption failure rolls back intent, live source cancellation and graph binding together', async () => {
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Atomic hold adoption' });
  db.prepare("UPDATE tasks SET agile_status = 'blocked', run_state = 'system_blocked' WHERE task_id = ?").run(taskId);
  db.exec(`CREATE TRIGGER fail_hold_adoption BEFORE INSERT ON interventions
    WHEN NEW.dedupe_key = 'native:adopt:task-blocked' BEGIN SELECT RAISE(ABORT,'hold-adoption-failure'); END`);
  assert.throws(() => adoptNativeWorkflowInDb(db, taskId), /hold-adoption-failure/);
  assert.equal((db.prepare('SELECT workflow_engine FROM tasks WHERE task_id = ?').get(taskId) as { workflow_engine: string }).workflow_engine, 'legacy');
  assert.equal(db.prepare("SELECT 1 FROM workflow_items WHERE task_id = ? AND origin = 'native'").get(taskId), undefined);
  assert.equal(nativeTaskHoldInDb(db, taskId), undefined);
  db.exec('DROP TRIGGER fail_hold_adoption');
  adoptNativeWorkflowInDb(db, taskId);
  assert.ok(nativeTaskHoldInDb(db, taskId));
});
