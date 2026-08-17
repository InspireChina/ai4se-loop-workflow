import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import { createLoopRunLifecycle, lifecycleRestartDelayMs } from './loop-run-lifecycle';

test('uses the agreed bounded Runner restart backoff', () => {
  assert.equal(lifecycleRestartDelayMs(1), 5_000);
  assert.equal(lifecycleRestartDelayMs(2), 15_000);
  assert.equal(lifecycleRestartDelayMs(3), 30_000);
  assert.equal(lifecycleRestartDelayMs(4), 300_000);
  assert.equal(lifecycleRestartDelayMs(40), 300_000);
});

test('migrates lifecycle facts and removes autonomous maintenance tables', async () => {
  const db = await databaseConnection();
  const state = db.prepare('SELECT desired_intent, mode, actual_phase FROM loop_lifecycle_state WHERE singleton = 1').get() as {
    desired_intent: string; mode: string; actual_phase: string;
  };
  assert.ok(['running', 'stopped'].includes(state.desired_intent));
  assert.equal(state.mode, 'normal');
  assert.ok(['crashed', 'stopped'].includes(state.actual_phase));
  const maintenanceTables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'software_maintenance%'",
  ).all();
  assert.deepEqual(maintenanceTables, []);
  assert.equal(db.prepare("SELECT 1 FROM loop_meta WHERE key = 'loop_run_intent'").get(), undefined);
});

test('deduplicates commands and freezes ordinary intent changes during update silence', async () => {
  const lifecycle = createLoopRunLifecycle({ ownerId: `test-${randomUUID()}`, adapter: 'cli' });
  const db = await databaseConnection();
  const before = db.prepare('SELECT intent_revision FROM loop_lifecycle_state WHERE singleton = 1').get() as { intent_revision: number };
  const requestId = randomUUID();
  const stop = {
    requestId,
    source: { adapter: 'cli' as const, instanceId: 'test', actor: 'human' as const },
    action: { kind: 'stop' as const, reason: 'user-stop' as const },
  };
  const first = await lifecycle.command(stop);
  const duplicate = await lifecycle.command(stop);
  assert.deepEqual(duplicate, first);
  const stopped = db.prepare('SELECT desired_intent, intent_revision FROM loop_lifecycle_state WHERE singleton = 1').get() as {
    desired_intent: string; intent_revision: number;
  };
  assert.equal(stopped.desired_intent, 'stopped');
  assert.equal(stopped.intent_revision, before.intent_revision + 1);

  const prepared = await lifecycle.command({
    requestId: randomUUID(),
    source: stop.source,
    action: { kind: 'prepare-update', attemptId: randomUUID(), targetVersion: '99.0.0' },
  });
  assert.equal(prepared.outcome, 'ready-for-update');
  const frozen = await lifecycle.command({ requestId: randomUUID(), source: stop.source, action: { kind: 'start' } });
  assert.equal(frozen.outcome, 'update-in-progress');
  assert.equal(frozen.snapshot.intent.revision, stopped.intent_revision);

  const resumed = await lifecycle.command({ requestId: randomUUID(), source: stop.source, action: { kind: 'resume-after-update' } });
  assert.equal(resumed.outcome, 'resumed');
  assert.equal(resumed.snapshot.mode.kind, 'normal');
  await lifecycle.shutdown(true);
});
