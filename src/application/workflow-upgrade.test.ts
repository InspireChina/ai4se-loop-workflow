import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { createTask } from '../test/legacy-task-fixtures';
import { upgradeWorkflowAtStartupInDb } from './workflow-upgrade';

async function fixture() {
  const db = await databaseConnection();
  db.prepare('DELETE FROM tasks').run();
  db.prepare("UPDATE loop_runs SET status = 'stopped'").run();
  db.prepare("UPDATE loop_managed_processes SET status = 'exited'").run();
  const runId = randomUUID();
  db.prepare("INSERT INTO loop_runs(run_id, owner, status, started_at) VALUES(?, 'upgrade-test', 'starting', CURRENT_TIMESTAMP)").run(runId);
  db.prepare(`INSERT INTO loop_supervisor_lease(singleton, owner_id, fencing_token, expires_at) VALUES(1, 'upgrade-test', 42, ?)
    ON CONFLICT(singleton) DO UPDATE SET owner_id = excluded.owner_id, fencing_token = excluded.fencing_token, expires_at = excluded.expires_at`)
    .run(new Date(Date.now() + 60_000).toISOString());
  return { db, runId };
}

test('startup upgrade includes paused and cancelled history, commits an audit receipt and replays without new graph events', async () => {
  const { db, runId } = await fixture();
  // The supervising UI host MUST remain alive while it upgrades the graph.
  db.prepare(`INSERT INTO loop_managed_processes(process_id,supervision_token,process_kind,pid,process_start_marker)
    VALUES(?,42,'ui-server',12345,'fixture-host')`).run(randomUUID());
  const paused = await createTask({ title: 'Paused history' });
  const cancelled = await createTask({ title: 'Cancelled history' });
  db.prepare('UPDATE tasks SET is_paused = 1 WHERE task_id = ?').run(paused);
  db.prepare("UPDATE tasks SET agile_status = 'cancelled', next_step = 'Operator cancelled' WHERE task_id = ?").run(cancelled);
  const receipt = upgradeWorkflowAtStartupInDb(db, runId, 42);
  assert.equal(receipt.tasks.length, 2);
  assert.ok(receipt.tasks.every(task => task.previousEngine === 'legacy' && task.itemCount > 0));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE workflow_engine = 'legacy'").get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT is_paused FROM tasks WHERE task_id = ?').get(paused) as { is_paused: number }).is_paused, 1);
  assert.ok(db.prepare("SELECT 1 FROM workflow_item_events WHERE event_type = 'task_cancellation_adopted'").get());
  const events = db.prepare('SELECT * FROM workflow_item_events ORDER BY rowid').all();
  assert.deepEqual(upgradeWorkflowAtStartupInDb(db, runId, 42), receipt);
  assert.deepEqual(db.prepare('SELECT * FROM workflow_item_events ORDER BY rowid').all(), events);
  assert.deepEqual(JSON.parse((db.prepare('SELECT receipt_json FROM workflow_upgrade_receipts WHERE run_id = ?').get(runId) as { receipt_json: string }).receipt_json), receipt);
});

test('ambiguous history rolls back earlier tasks and all source bindings; correction can retry the same startup boundary', async () => {
  const { db, runId } = await fixture();
  const first = await createTask({ title: 'Good history' });
  const second = await createTask({ title: 'Conflicting history' });
  const [good, bad] = [first, second].sort();
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const id = randomUUID(); ids.push(id);
    // A durable result awaiting application is not a live CLI, but two current
    // results for the same role/node are still an ownership contradiction.
    db.prepare(`INSERT INTO execution_attempts(execution_id,run_id,task_id,agent,pipeline,lane,
      delegation_key,dispatch_generation_key,attempt,status,input_hash,input_json,result_json)
      VALUES(?, 'historical', ?, 'backlog-agent', 'backlog', 'control', ?, 'same-generation', ?, 'applying', 'hash', '{}', '{}')`)
      .run(id, bad, id, i + 1);
  }
  const beforeItems = db.prepare('SELECT * FROM workflow_items ORDER BY rowid').all();
  const beforeSources = db.prepare('SELECT * FROM execution_attempts ORDER BY rowid').all();
  assert.throws(() => upgradeWorkflowAtStartupInDb(db, runId, 42), error =>
    error instanceof Error && error.message.includes(bad) && /多个历史活动执行/.test(error.message));
  assert.equal((db.prepare('SELECT workflow_engine FROM tasks WHERE task_id = ?').get(good) as { workflow_engine: string }).workflow_engine, 'legacy');
  assert.deepEqual(db.prepare('SELECT * FROM workflow_items ORDER BY rowid').all(), beforeItems);
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts ORDER BY rowid').all(), beforeSources);
  assert.equal(db.prepare('SELECT 1 FROM workflow_upgrade_receipts WHERE run_id = ?').get(runId), undefined);
  db.prepare("UPDATE execution_attempts SET status = 'cancelled' WHERE execution_id = ?").run(ids[1]);
  db.prepare('UPDATE execution_attempts SET input_json = ? WHERE execution_id = ?')
    .run(JSON.stringify({ delegation: { taskId: bad, agent: 'backlog-agent', pipeline: 'backlog', storyIndex: null } }), ids[0]);
  assert.equal(upgradeWorkflowAtStartupInDb(db, runId, 42).tasks.length, 2);
});

test('a sealed startup receipt cannot silently approve newly imported legacy requirements', async () => {
  const { db, runId } = await fixture();
  await createTask({ title: 'Original migration cohort' });
  const receipt = upgradeWorkflowAtStartupInDb(db, runId, 42);
  const imported = await createTask({ title: 'Late historical import' });
  const before = db.prepare('SELECT * FROM workflow_upgrade_receipts WHERE run_id = ?').get(runId);
  assert.throws(() => upgradeWorkflowAtStartupInDb(db, runId, 42), error =>
    error instanceof Error && error.message.includes(imported) && /收据已封存/.test(error.message));
  assert.deepEqual(db.prepare('SELECT * FROM workflow_upgrade_receipts WHERE run_id = ?').get(runId), before);
  assert.equal((db.prepare('SELECT workflow_engine FROM tasks WHERE task_id = ?').get(imported) as { workflow_engine: string }).workflow_engine, 'legacy');
  assert.equal(receipt.tasks.length, 1);
});

test('startup upgrade rolls back an otherwise adoptable result whose frozen delegation cannot be recovered', async () => {
  const { db, runId } = await fixture();
  const taskId = await createTask({ title: 'Unreadable historical input' });
  const id = randomUUID();
  db.prepare(`INSERT INTO execution_attempts(execution_id,run_id,task_id,agent,pipeline,
    delegation_key,attempt,status,input_hash,input_json,result_json)
    VALUES(?,?,?,'backlog-agent','backlog',?,1,'applying','hash','{}','{}')`).run(id, runId, taskId, id);
  const before = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(id);
  assert.throws(() => upgradeWorkflowAtStartupInDb(db, runId, 42), error =>
    error instanceof Error && error.message.includes(taskId) && error.message.includes(id) && /缺少冻结 delegation/.test(error.message));
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(id), before);
  assert.equal((db.prepare('SELECT workflow_engine FROM tasks WHERE task_id = ?').get(taskId) as { workflow_engine: string }).workflow_engine, 'legacy');
  assert.equal(db.prepare('SELECT 1 FROM workflow_upgrade_receipts WHERE run_id = ?').get(runId), undefined);
});

for (const boundary of ['expired-lease', 'wrong-token', 'already-running', 'old-run', 'live-execution', 'old-cli', 'old-runner'] as const) {
  test(`startup upgrade rejects ${boundary} before touching the graph`, async () => {
    const { db, runId } = await fixture();
    const taskId = await createTask({ title: 'Boundary protection' });
    if (boundary === 'expired-lease') db.prepare("UPDATE loop_supervisor_lease SET expires_at = '2000-01-01T00:00:00Z'").run();
    if (boundary === 'already-running') db.prepare("UPDATE loop_runs SET status = 'running' WHERE run_id = ?").run(runId);
    if (boundary === 'old-run') db.prepare("INSERT INTO loop_runs(run_id, owner, status, started_at) VALUES(?, 'old', 'running', CURRENT_TIMESTAMP)").run(randomUUID());
    if (boundary === 'old-cli' || boundary === 'old-runner') db.prepare(`INSERT INTO loop_managed_processes(process_id,supervision_token,process_kind,pid,process_start_marker)
      VALUES(?,41,?,23456,'fixture-old')`).run(randomUUID(), boundary === 'old-cli' ? 'agent-cli' : 'agent-runner');
    if (boundary === 'live-execution') db.prepare(`INSERT INTO execution_attempts(execution_id,run_id,task_id,agent,pipeline,
      delegation_key,attempt,status,input_hash,input_json) VALUES(?,?,?,'backlog-agent','backlog',?,1,'running','hash','{}')`)
      .run(randomUUID(), runId, taskId, randomUUID());
    const before = db.prepare('SELECT * FROM workflow_items ORDER BY rowid').all();
    assert.throws(() => upgradeWorkflowAtStartupInDb(db, runId, boundary === 'wrong-token' ? 43 : 42), /迁移被拒绝/);
    assert.deepEqual(db.prepare('SELECT * FROM workflow_items ORDER BY rowid').all(), before);
    assert.equal((db.prepare('SELECT workflow_engine FROM tasks WHERE task_id = ?').get(taskId) as { workflow_engine: string }).workflow_engine, 'legacy');
  });
}
