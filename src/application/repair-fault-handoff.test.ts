import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import { createTaskInDb, createTaskSchema } from './tasks';
import { openInterventionInDb, claimNextIntervention, runInterventionCommand, buildInterventionPrompt, finishInterventionAttempt } from './interventions';
import { enqueueInterventionFaultInDb, pendingRepairObservationsInDb } from './repair-observation-outbox';

async function fixture() {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused=1').run();
  const taskId = `REQ-${randomUUID()}`;
  createTaskInDb(db, createTaskSchema.parse({ title: 'Legacy handoff contract', itemType: 'direct' }), taskId);
  const item = db.prepare('SELECT item_id FROM workflow_items WHERE task_id=?').get(taskId) as { item_id: string };
  return { db, taskId, item };
}
const claim = () => claimNextIntervention({ runId: 'RUN-handoff-contract', executorId: 'claude', executionOptions: {} });

test('a historical unknown system arbitration session cannot advertise or directly complete a work item', async () => {
  const h = await fixture();
  const source = openInterventionInDb(h.db, { taskId: h.taskId, itemId: h.item.item_id,
    requestedBy: 'system', dedupeKey: 'historical', summary: 'Historical unresolved record' });
  // Reproduce the exact ambiguous pre-source-kind migration record. This
  // does not reclassify a new Agent fault into an ordinary repair path.
  h.db.prepare("UPDATE interventions SET source_kind='legacy-unknown',authority='arbitration' WHERE intervention_id=?").run(source.intervention_id);
  const session = await claim();
  assert.ok(session);
  assert.equal(session.interventionId, source.intervention_id);
  const run = (args: string[]) => runInterventionCommand({ ...session, args });
  const graph = h.db.prepare('SELECT * FROM workflow_items WHERE task_id=? ORDER BY item_id').all(h.taskId);
  const status = await run(['intervention', 'status']);
  assert.doesNotMatch(status, /intervention work-item-complete/);
  assert.doesNotMatch(buildInterventionPrompt(session), /intervention work-item-complete/);
  await assert.rejects(run(['intervention', 'work-item-complete', '--reason', 'Claimed fixed without independent verification']), /必须修复后请求独立验证/);
  assert.deepEqual(h.db.prepare('SELECT * FROM workflow_items WHERE task_id=? ORDER BY item_id').all(h.taskId), graph);
  assert.equal(pendingRepairObservationsInDb(h.db).length, 0, 'unknown historical input is not blindly converted');
});

test('a late old system session loses write authority immediately when its source becomes an identified Agent fault, before Case linkage', async () => {
  const h = await fixture();
  const source = openInterventionInDb(h.db, { taskId: h.taskId, itemId: h.item.item_id,
    requestedBy: 'system', dedupeKey: 'identified-fault', summary: 'Known execution fault' });
  const session = await claim();
  assert.ok(session);
  h.db.prepare("UPDATE interventions SET source_kind='agent-fault' WHERE intervention_id=?").run(source.intervention_id);
  const before = h.db.prepare('SELECT * FROM interventions WHERE intervention_id=?').get(source.intervention_id);
  await assert.rejects(runInterventionCommand({ ...session, args: ['intervention', 'status'] }), /独立 Admin 接管/);
  assert.deepEqual(h.db.prepare('SELECT * FROM interventions WHERE intervention_id=?').get(source.intervention_id), before);
  assert.equal((before as { repair_case_id: string | null }).repair_case_id, null);
});

test('late failure of an identified Agent fault cannot consume the old third-attempt human fallback or discard its history', async () => {
  const h = await fixture();
  const source = openInterventionInDb(h.db, { taskId: h.taskId, itemId: h.item.item_id,
    requestedBy: 'system', dedupeKey: 'late-failure', summary: 'Known local execution failure', maxSystemAttempts: 3 });
  for (let attempt = 1; attempt <= 2; attempt++) {
    assert.equal((await claim())?.interventionId, source.intervention_id);
    await finishInterventionAttempt({ interventionId: source.intervention_id, outcome: 'failed', reason: `Preserved failure ${attempt}` });
  }
  const last = await claim();
  assert.ok(last);
  h.db.prepare("UPDATE interventions SET source_kind='agent-fault',authority='arbitration' WHERE intervention_id=?").run(source.intervention_id);
  const identified = h.db.prepare('SELECT * FROM interventions WHERE intervention_id=?').get(source.intervention_id) as typeof source;
  enqueueInterventionFaultInDb(h.db, identified, 'v1');
  const history = h.db.prepare('SELECT * FROM intervention_attempts WHERE intervention_id=? AND attempt<3 ORDER BY attempt').all(source.intervention_id);
  const result = await finishInterventionAttempt({ interventionId: source.intervention_id, outcome: 'failed', reason: 'Old CLI failed after managed handoff' });
  assert.equal(result.escalated, false);
  const after = h.db.prepare('SELECT status,escalated_at,current_execution_id FROM interventions WHERE intervention_id=?').get(source.intervention_id);
  assert.deepEqual(after, { status: 'pending', escalated_at: null, current_execution_id: null });
  assert.deepEqual(h.db.prepare('SELECT * FROM intervention_attempts WHERE intervention_id=? AND attempt<3 ORDER BY attempt').all(source.intervention_id), history);
  assert.equal(await claim(), null);
  assert.equal(pendingRepairObservationsInDb(h.db).length, 1);
  assert.equal((h.db.prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_id=? AND event_type=?').get(h.taskId, 'InterventionRepairHandoff') as { count: number }).count, 1);
});
