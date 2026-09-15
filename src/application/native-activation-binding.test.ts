import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection, hash } from '../infrastructure/database';
import { beginRun, endRun, createTaskInDb, createTaskSchema, cancelTask } from './tasks';
import { progressDispatcher, type PreparedExecution } from './progress-dispatch';

const prepared: PreparedExecution = {
  prompt: 'Domain activation fixture, not a real Agent execution', contextSnapshot: {},
  recovery: { mode: 'initial', label: 'Initial', retryNumber: 0 },
  promptMetadata: { version: 1, templateVersion: 1, hash: 'fixture' },
  memory: { revision: 1, hash: 'fixture' }, runtime: { executorId: 'claude', webSearchEnabled: false },
};

async function fixture() {
  const db = await databaseConnection();
  db.prepare('UPDATE tasks SET is_paused = 1').run();
  const task = db.transaction(() => createTaskInDb(db, createTaskSchema.parse({ title: 'Activation fixture', itemType: 'direct' }),
    `REQ-${randomUUID()}`))();
  const runId = await beginRun('native-activation-fixture');
  const result = await progressDispatcher.reserveNext({ runId });
  assert.equal(result.kind, 'reserved');
  if (result.kind !== 'reserved') throw new Error('Missing reservation');
  const reservation = result.reservations.find(value => value.work.taskId === task.task_id)!;
  assert.ok(reservation);
  return { db, taskId: task.task_id, runId, reservation, cleanup: async () => {
    await cancelTask({ taskId: task.task_id, reason: 'Finish activation fixture' });
    await endRun(runId, false, { stopRunner: false });
  } };
}

for (const [name, sql] of Object.entries({
  'missing source binding': 'UPDATE execution_attempts SET work_item_id = NULL WHERE execution_id = ?',
  'source role mismatch': "UPDATE execution_attempts SET agent = 'test-agent' WHERE execution_id = ?",
  'source generation mismatch': "UPDATE execution_attempts SET dispatch_generation_key = 'wrong' WHERE execution_id = ?",
  'source input mismatch': "UPDATE execution_attempts SET input_json = '{}' WHERE execution_id = ?",
  'source hash mismatch': "UPDATE execution_attempts SET input_hash = 'wrong' WHERE execution_id = ?",
  'unreadable reservation': "UPDATE execution_attempts SET dispatch_reservation_json = '{' WHERE execution_id = ?",
})) {
  test(`native activation cancels ${name}, releases its code slot and consumes no error quota`, async () => {
    const { db, reservation, cleanup } = await fixture();
    try {
      assert.ok(db.prepare('SELECT 1 FROM resource_claims WHERE owner_execution_id = ?').get(reservation.executionId));
      db.prepare(sql).run(reservation.executionId);
      assert.deepEqual(await progressDispatcher.activate({ reservationId: reservation.reservationId, prepared }),
        { kind: 'invalidated', reason: 'superseded' });
      const source = db.prepare('SELECT status, dispatch_retry_consumed, last_error FROM execution_attempts WHERE execution_id = ?')
        .get(reservation.executionId) as { status: string; dispatch_retry_consumed: number; last_error: string };
      assert.equal(source.status, 'cancelled');
      assert.equal(source.dispatch_retry_consumed, 0);
      assert.ok(source.last_error.includes(reservation.executionId));
      assert.equal(db.prepare('SELECT 1 FROM resource_claims WHERE owner_execution_id = ?').get(reservation.executionId), undefined);
      const item = db.prepare('SELECT status FROM workflow_items WHERE item_id = ?').get(reservation.work.workItemId!) as { status: string };
      if (name === 'missing source binding') {
        assert.equal(item.status, 'waiting', 'orphan must be observable, not silently left running');
        assert.ok(db.prepare("SELECT 1 FROM interventions WHERE item_id = ? AND source_execution_id = ? AND status = 'pending'")
          .get(reservation.work.workItemId!, reservation.executionId));
      } else assert.equal(item.status, 'ready');
    } finally { await cleanup(); }
  });
}

test('native activation accepts the exact source and freezes prepared input once, independently of old task labels', async () => {
  const { db, taskId, reservation, cleanup } = await fixture();
  try {
    db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id = ?").run(taskId);
    const first = await progressDispatcher.activate({ reservationId: reservation.reservationId, prepared });
    assert.equal(first.kind, 'running');
    const original = db.prepare('SELECT input_json FROM execution_attempts WHERE execution_id = ?').get(reservation.executionId);
    const second = await progressDispatcher.activate({ reservationId: reservation.reservationId,
      prepared: { ...prepared, prompt: 'Must not replace frozen input' } });
    assert.equal(second.kind, 'running');
    assert.deepEqual(db.prepare('SELECT input_json FROM execution_attempts WHERE execution_id = ?').get(reservation.executionId), original);
  } finally { await cleanup(); }
});

test('a self-consistent reservation hash cannot authorize a different Work Item revision', async () => {
  const { db, reservation, cleanup } = await fixture();
  try {
    const row = db.prepare('SELECT dispatch_reservation_json FROM execution_attempts WHERE execution_id = ?')
      .get(reservation.executionId) as { dispatch_reservation_json: string };
    const value = JSON.parse(row.dispatch_reservation_json);
    value.work.workItemRevision += 1;
    const frozen = JSON.stringify(value);
    db.prepare('UPDATE execution_attempts SET dispatch_reservation_json = ?, input_json = ?, input_hash = ? WHERE execution_id = ?')
      .run(frozen, frozen, hash(frozen), reservation.executionId);
    assert.deepEqual(await progressDispatcher.activate({ reservationId: reservation.reservationId, prepared }),
      { kind: 'invalidated', reason: 'superseded' });
    assert.equal((db.prepare('SELECT dispatch_retry_consumed FROM execution_attempts WHERE execution_id = ?')
      .get(reservation.executionId) as { dispatch_retry_consumed: number }).dispatch_retry_consumed, 0);
  } finally { await cleanup(); }
});
