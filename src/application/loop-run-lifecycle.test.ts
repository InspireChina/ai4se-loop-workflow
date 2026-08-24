import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import {
  canReclaimSupervisorLease,
  createLoopRunLifecycle,
  installedVersionReachedTarget,
  lifecycleRestartDelayMs,
  RUNNER_STALE_GRACE_MS,
  runnerHealthDisposition,
  runnerHealthReason,
} from './loop-run-lifecycle';

test('recognizes exact and skipped desktop update targets', () => {
  assert.equal(installedVersionReachedTarget('0.1.17', '0.1.17'), true);
  assert.equal(installedVersionReachedTarget('0.1.17', 'v0.1.16'), true);
  assert.equal(installedVersionReachedTarget('0.1.15', '0.1.16'), false);
  assert.equal(installedVersionReachedTarget('invalid', '0.1.16'), false);
  assert.equal(installedVersionReachedTarget('0.1.17', null), false);
});

test('uses the agreed bounded Runner restart backoff', () => {
  assert.equal(lifecycleRestartDelayMs(1), 5_000);
  assert.equal(lifecycleRestartDelayMs(2), 15_000);
  assert.equal(lifecycleRestartDelayMs(3), 30_000);
  assert.equal(lifecycleRestartDelayMs(4), 300_000);
  assert.equal(lifecycleRestartDelayMs(40), 300_000);
});

test('graces a live Runner with a stale heartbeat before declaring it failed', () => {
  const now = Date.now();
  const stale = {
    runId: 'RUN-stale', owner: 'test', startedAt: new Date(now - 120_000).toISOString(),
    heartbeatAt: new Date(now - 50_000).toISOString(), processKind: 'agent-runner' as const,
    status: 'running' as const, pid: 4321, active: false,
    health: {
      starting: false, pidAlive: true, heartbeatFresh: false,
      heartbeatAgeMs: 50_000, generationActive: true,
    },
  };

  assert.equal(runnerHealthDisposition(stale, null, now).kind, 'suspect');
  assert.equal(runnerHealthDisposition(stale, new Date(now - RUNNER_STALE_GRACE_MS + 1).toISOString(), now).kind, 'suspect');
  assert.equal(runnerHealthDisposition(stale, new Date(now - RUNNER_STALE_GRACE_MS).toISOString(), now).kind, 'failed');
  assert.match(runnerHealthReason(stale), /pid_alive=true.*heartbeat_age_ms=50000.*generation_active=true/);
  assert.equal(runnerHealthDisposition({ ...stale, health: { ...stale.health, pidAlive: false } }, null, now).kind, 'failed');
});

test('reclaims an unexpired lease only when the previous local supervisor is provably gone', () => {
  assert.equal(canReclaimSupervisorLease('electron-4321-old', 'electron-8765-new', () => false), true);
  assert.equal(canReclaimSupervisorLease('electron-4321-old', 'electron-8765-new', () => true), false);
  assert.equal(canReclaimSupervisorLease('electron-4321-old', 'electron-4321-new', () => true), true, 'the PID was reused by the current host');
  assert.equal(canReclaimSupervisorLease('unknown-owner', 'electron-8765-new', () => false), false);
});

test('takes over a stale supervisor generation immediately and retires its dead process records', async () => {
  const db = await databaseConnection();
  const ownerId = `electron-${process.pid}-${randomUUID()}`;
  const missingPid = 99_999;
  db.transaction(() => {
    db.prepare('DELETE FROM loop_supervisor_lease').run();
    db.prepare('DELETE FROM loop_managed_processes').run();
    db.prepare("DELETE FROM loop_meta WHERE key = 'active_run'").run();
    db.prepare(`UPDATE loop_lifecycle_state SET desired_intent = 'stopped', mode = 'normal', actual_phase = 'stopped', active_run_id = NULL, retry_at = NULL WHERE singleton = 1`).run();
    db.prepare(`INSERT INTO loop_supervisor_lease(singleton, owner_id, fencing_token, expires_at) VALUES(1, ?, 7, ?)`)
      .run(`electron-${missingPid}-dead`, new Date(Date.now() + 30_000).toISOString());
    db.prepare(`INSERT INTO loop_managed_processes(process_id, supervision_token, process_kind, pid, process_start_marker) VALUES(?, 7, 'ui-server', ?, 'dead-start')`)
      .run(randomUUID(), missingPid);
  })();

  const lifecycle = createLoopRunLifecycle({ ownerId, adapter: 'electron' });
  await lifecycle.start();
  const lease = db.prepare('SELECT owner_id, fencing_token FROM loop_supervisor_lease WHERE singleton = 1').get() as {
    owner_id: string; fencing_token: number;
  };
  const oldProcess = db.prepare('SELECT status FROM loop_managed_processes WHERE supervision_token = 7').get() as { status: string };

  assert.deepEqual(lease, { owner_id: ownerId, fencing_token: 8 });
  assert.equal(oldProcess.status, 'exited');
  await lifecycle.shutdown(false);
});

test('migrates lifecycle facts and removes autonomous maintenance tables', async () => {
  const db = await databaseConnection();
  const state = db.prepare('SELECT desired_intent, mode, actual_phase FROM loop_lifecycle_state WHERE singleton = 1').get() as {
    desired_intent: string; mode: string; actual_phase: string;
  };
  assert.ok(['running', 'stopped'].includes(state.desired_intent));
  assert.equal(state.mode, 'normal');
  assert.ok(['crashed', 'stopped'].includes(state.actual_phase));
  const lifecycleColumns = db.prepare(`PRAGMA table_info('loop_lifecycle_state')`).all() as { name: string }[];
  assert.equal(lifecycleColumns.some((column) => column.name === 'runner_suspect_since'), true);
  assert.equal(lifecycleColumns.some((column) => column.name === 'last_health_json'), true);
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

test('desktop restart always releases update silence and records an incomplete installation', async () => {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE loop_lifecycle_state
    SET desired_intent = 'stopped', mode = 'update-silence',
        update_attempt_id = 'stale-update', update_target_version = '0.1.17',
        update_readiness = 'ready', actual_phase = 'stopped', active_run_id = NULL,
        retry_at = NULL, last_error = NULL
    WHERE singleton = 1
  `).run();
  const lifecycle = createLoopRunLifecycle({
    ownerId: `electron-${process.pid}-${randomUUID()}`,
    adapter: 'electron',
    installedVersion: '0.1.15',
  });
  await lifecycle.start();
  const recovered = db.prepare(`
    SELECT mode, update_attempt_id, update_target_version, update_readiness, last_error
    FROM loop_lifecycle_state WHERE singleton = 1
  `).get() as {
    mode: string;
    update_attempt_id: string | null;
    update_target_version: string | null;
    update_readiness: string | null;
    last_error: string | null;
  };
  assert.equal(recovered.mode, 'normal');
  assert.equal(recovered.update_attempt_id, null);
  assert.equal(recovered.update_target_version, null);
  assert.equal(recovered.update_readiness, null);
  assert.match(recovered.last_error || '', /当前版本 0\.1\.15，目标版本 0\.1\.17.*已自动恢复运行控制/);
  await lifecycle.shutdown(false);
});

test('desktop restart clears update silence after skipping past the recorded target', async () => {
  const db = await databaseConnection();
  db.prepare(`
    UPDATE loop_lifecycle_state
    SET desired_intent = 'stopped', mode = 'update-silence',
        update_attempt_id = 'skipped-update', update_target_version = '0.1.16',
        update_readiness = 'ready', actual_phase = 'stopped', active_run_id = NULL,
        retry_at = NULL, last_error = 'old update state'
    WHERE singleton = 1
  `).run();
  const lifecycle = createLoopRunLifecycle({
    ownerId: `electron-${process.pid}-${randomUUID()}`,
    adapter: 'electron',
    installedVersion: '0.1.17',
  });
  await lifecycle.start();
  const recovered = db.prepare(`
    SELECT mode, update_target_version, last_error
    FROM loop_lifecycle_state WHERE singleton = 1
  `).get() as { mode: string; update_target_version: string | null; last_error: string | null };
  assert.equal(recovered.mode, 'normal');
  assert.equal(recovered.update_target_version, null);
  assert.equal(recovered.last_error, null);
  await lifecycle.shutdown(false);
});
