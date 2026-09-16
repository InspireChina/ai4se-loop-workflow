import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { databaseConnection } from '../infrastructure/database';
import { createTask, beginRun, endRun, cancelTask, releaseBlock, getTask } from './tasks';
import { progressDispatcher } from './progress-dispatch';
import { settleNativeExecutionFailureInDb } from './executions';
import { planDispatchInDb } from './dispatch-planner';
import { openInterventionInDb, claimNextIntervention } from './interventions';
import { pendingRepairObservationsInDb, acknowledgeRepairObservationInDb } from './repair-observation-outbox';
import { createRepairObservationBridge } from './repair-observation-bridge';
import { createAdminController } from './admin-controller';
import { AdminManagementStore } from '../infrastructure/admin-management-store';

async function fixture(itemType: 'feature' | 'bug' | 'business-analysis' | 'end-to-end' | 'direct' = 'direct') {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused = 1').run();
  const taskId = await createTask({ title: `Native recovery ${itemType}`, itemType });
  const runId = await beginRun('native-recovery-domain-fixture');
  const first = await progressDispatcher.reserveNext({ runId });
  assert.equal(first.kind, 'reserved');
  if (first.kind !== 'reserved') throw new Error('Missing reservation');
  const reservation = first.reservations.find(value => value.work.taskId === taskId)!;
  return { db, taskId, runId, reservation, cleanup: async () => {
    await cancelTask({ taskId, reason: 'Finish domain recovery fixture' });
    await endRun(runId, false, { stopRunner: false });
  } };
}

for (const type of ['feature', 'bug', 'business-analysis', 'end-to-end', 'direct'] as const) {
  test(`${type} preparation exhaustion creates one source-bound Intervention, releases claims and never writes a legacy block`, async () => {
    const { db, taskId, runId, reservation, cleanup } = await fixture(type);
    try {
      let current = reservation;
      for (let failure = 1; failure <= 5; failure += 1) {
        // A broken reservation must not break failure bookkeeping itself.
        if (failure === 5) db.prepare("UPDATE execution_attempts SET dispatch_reservation_json = '{' WHERE execution_id = ?").run(current.executionId);
        const result = await progressDispatcher.preparationFailed({ reservationId: current.reservationId, error: `Provider preparation error ${failure}` });
        assert.equal(result.kind, failure === 5 ? 'blocked' : 'retry');
        assert.equal(db.prepare('SELECT 1 FROM resource_claims WHERE owner_execution_id = ?').get(current.executionId), undefined);
        assert.notEqual((db.prepare('SELECT agile_status FROM tasks WHERE task_id = ?').get(taskId) as { agile_status: string }).agile_status, 'blocked');
        if (failure < 5) {
          db.prepare('UPDATE execution_attempts SET retry_not_before = NULL WHERE execution_id = ?').run(current.executionId);
          const next = await progressDispatcher.reserveNext({ runId });
          assert.equal(next.kind, 'reserved');
          if (next.kind !== 'reserved') throw new Error('Missing retry');
          current = next.reservations.find(value => value.work.taskId === taskId)!;
          assert.equal(current.work.workItemId, reservation.work.workItemId);
          assert.equal(current.attempt, failure + 1);
        }
      }
      assert.deepEqual(db.prepare(`SELECT item_id, source_execution_id, status, authority, resolver_strategy, max_system_attempts
        FROM interventions WHERE task_id = ?`).all(taskId), [{ item_id: reservation.work.workItemId,
          source_execution_id: current.executionId, status: 'pending', authority: 'arbitration',
          resolver_strategy: 'system_then_human', max_system_attempts: 3 }]);
      assert.deepEqual(planDispatchInDb(db).filter(work => work.taskId === taskId), []);
      const detail = await getTask(taskId);
      const failedView = detail?.executionAttempts.find(source => source.execution_id === current.executionId);
      assert.equal(failedView?.work_item_id, reservation.work.workItemId);
      assert.equal(failedView?.work_item_attempt, 5);
      assert.equal(failedView?.work_item_revision, 1);
      assert.equal(failedView?.claimed_resources, null, 'unreadable reservation must not prevent reading the actual failure');
      assert.match(failedView?.last_error || '', /Provider preparation error 5/);
      const original = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(current.executionId);
      settleNativeExecutionFailureInDb(db, current.executionId);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM interventions WHERE task_id = ?').get(taskId) as { n: number }).n, 1);
      await releaseBlock(taskId);
      assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(current.executionId), original);
      assert.equal(planDispatchInDb(db).find(work => work.taskId === taskId)?.workItemEpoch, 2);
      settleNativeExecutionFailureInDb(db, current.executionId);
      assert.ok(planDispatchInDb(db).find(work => work.taskId === taskId), 'late settlement cannot re-block a human-reset epoch');
    } finally { await cleanup(); }
  });
}

test('human retry cannot close failure recovery when an independent Intervention remains', async () => {
  const { db, taskId, reservation, cleanup } = await fixture();
  try {
    db.prepare("UPDATE execution_attempts SET status = 'system_blocked', last_error = 'Unknown CLI error' WHERE execution_id = ?").run(reservation.executionId);
    settleNativeExecutionFailureInDb(db, reservation.executionId);
    openInterventionInDb(db, { taskId, itemId: reservation.work.workItemId, dedupeKey: 'independent-input',
      summary: 'Real human input is still required', requestedBy: 'human', resolverStrategy: 'human_only' });
    const before = db.prepare('SELECT * FROM interventions WHERE task_id = ? ORDER BY intervention_id').all(taskId);
    await assert.rejects(releaseBlock(taskId), /介入必须先解决/);
    assert.deepEqual(db.prepare('SELECT * FROM interventions WHERE task_id = ? ORDER BY intervention_id').all(taskId), before);
    assert.equal((db.prepare('SELECT dispatch_epoch FROM workflow_items WHERE item_id = ?').get(reservation.work.workItemId!) as { dispatch_epoch: number }).dispatch_epoch, 1);
  } finally { await cleanup(); }
});

test('a task-wide binding failure holds the graph and routes immutable source evidence to Admin, not ordinary arbitration', async () => {
  const { db, taskId, runId, reservation, cleanup } = await fixture();
  try {
    db.prepare("UPDATE execution_attempts SET work_item_id = NULL, status = 'system_blocked', last_error = 'Lost source binding' WHERE execution_id = ?").run(reservation.executionId);
    settleNativeExecutionFailureInDb(db, reservation.executionId);
    const intervention = db.prepare('SELECT intervention_id, item_id FROM interventions WHERE task_id = ?').get(taskId) as { intervention_id: string; item_id: null };
    assert.equal(intervention.item_id, null);
    assert.deepEqual(planDispatchInDb(db).filter(work => work.taskId === taskId), []);
    const claimed = await claimNextIntervention({ runId, executorId: 'claude', executionOptions: {} });
    assert.equal(claimed, null);
    const pending = pendingRepairObservationsInDb(db).map(row => JSON.parse(row.observation_json));
    assert.equal(pending.length, 1);
    assert.equal(pending[0].scope, 'execution');
    assert.equal(pending[0].evidence.execution.execution_id, reservation.executionId);
    assert.equal(pending[0].evidence.execution.dispatch_reservation_json,
      (db.prepare('SELECT dispatch_reservation_json FROM execution_attempts WHERE execution_id=?').get(reservation.executionId) as { dispatch_reservation_json: string }).dispatch_reservation_json);
    assert.deepEqual(planDispatchInDb(db).filter(work => work.taskId === taskId), []);
    assert.equal((db.prepare('SELECT status FROM execution_attempts WHERE execution_id = ?').get(reservation.executionId) as { status: string }).status, 'system_blocked');
  } finally { await cleanup(); }
});

test('a generic task-wide human Intervention cannot be released by the historical unblock button', async () => {
  const { db, taskId, reservation, cleanup } = await fixture();
  try {
    openInterventionInDb(db, { taskId, dedupeKey: `operator-hold:${randomUUID()}`, requestedBy: 'human',
      summary: 'Independent operator hold', resolverStrategy: 'human_only' });
    await assert.rejects(releaseBlock(taskId));
    assert.deepEqual(planDispatchInDb(db).filter(work => work.taskId === taskId), []);
    assert.equal((db.prepare('SELECT dispatch_epoch FROM workflow_items WHERE item_id = ?').get(reservation.work.workItemId!) as { dispatch_epoch: number }).dispatch_epoch, 1);
  } finally { await cleanup(); }
});

test('native Agent failures retain a single independent RepairCase and continue beyond three attempts without human fallback', async () => {
  const { db, taskId, runId, reservation, cleanup } = await fixture();
  try {
    db.prepare("UPDATE execution_attempts SET status = 'system_blocked', last_error = 'Provider failure' WHERE execution_id = ?").run(reservation.executionId);
    settleNativeExecutionFailureInDb(db, reservation.executionId);
    const source = db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(reservation.executionId);
    const store = new AdminManagementStore(join(process.env.LOOP_DATA_ROOT!, randomUUID(), 'management.db'));
    store.setIntent('running', 'start');
    const bridge = createRepairObservationBridge({
      pending: async () => pendingRepairObservationsInDb(db).map(row => JSON.parse(row.observation_json)),
      observe: observation => store.observe(observation),
      acknowledge: async (id, caseId) => acknowledgeRepairObservationInDb(db, id, caseId),
    });
    const ids = new Set<string>();
    const controller = createAdminController({ store, ownerId: 'independent-recovery', discover: bridge, confirmStopped: async () => true,
      launch: async claim => {
        ids.add(claim.attempt.attemptId);
        store.recordEvidence(claim, 'investigation', 'hypothesis', { generation: claim.attempt.generation });
        return { completion: Promise.resolve({ outcome: 'failed', exitConfirmed: true, reason: 'Continue investigation' }), stop: async () => true };
      } });
    try {
      for (let attempt = 1; attempt <= 5; attempt++) {
        assert.equal(await controller.reconcile(), 'launched');
        await controller.waitForSettlements();
      }
      assert.equal(ids.size, 5);
      const linked = db.prepare('SELECT repair_case_id FROM interventions WHERE task_id=?').get(taskId) as { repair_case_id: string };
      assert.equal(store.attempts(linked.repair_case_id).length, 5);
      assert.equal(store.observations(linked.repair_case_id).length, 1);
      assert.equal(store.getCase(linked.repair_case_id)?.status, 'queued');
      assert.equal(await claimNextIntervention({ runId, executorId: 'claude', executionOptions: {} }), null);
    } finally { await controller.shutdown(); store.close(); }
    assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE execution_id = ?').get(reservation.executionId), source);
    assert.equal((db.prepare('SELECT status FROM interventions WHERE task_id = ?').get(taskId) as { status: string }).status, 'pending');
  } finally { await cleanup(); }
});
