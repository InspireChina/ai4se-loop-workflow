import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { databaseConnection } from '../infrastructure/database';
import {
  canReclaimSupervisorLease,
  createLoopRunLifecycle,
  lifecycleRestartDelayMs,
  RUNNER_STALE_GRACE_MS,
  runnerHealthDisposition,
  runnerHealthReason,
} from './loop-run-lifecycle';

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
  assert.equal(canReclaimSupervisorLease('web-4321-old', 'web-8765-new', () => false), true);
  assert.equal(canReclaimSupervisorLease('web-4321-old', 'web-8765-new', () => true), false);
  assert.equal(canReclaimSupervisorLease('web-4321-old', 'web-4321-new', () => true), true, 'the PID was reused by the current host');
  assert.equal(canReclaimSupervisorLease('unknown-owner', 'web-8765-new', () => false), false);
});

test('takes over a stale supervisor generation immediately and retires its dead process records', async () => {
  const db = await databaseConnection();
  const ownerId = `web-${process.pid}-${randomUUID()}`;
  const missingPid = 99_999;
  db.transaction(() => {
    db.prepare('DELETE FROM loop_supervisor_lease').run();
    db.prepare('DELETE FROM loop_managed_processes').run();
    db.prepare("DELETE FROM loop_meta WHERE key = 'active_run'").run();
    db.prepare(`UPDATE loop_lifecycle_state SET desired_intent = 'stopped', actual_phase = 'stopped', active_run_id = NULL, retry_at = NULL WHERE singleton = 1`).run();
    db.prepare(`INSERT INTO loop_supervisor_lease(singleton, owner_id, fencing_token, expires_at) VALUES(1, ?, 7, ?)`)
      .run(`web-${missingPid}-dead`, new Date(Date.now() + 30_000).toISOString());
    db.prepare(`INSERT INTO loop_managed_processes(process_id, supervision_token, process_kind, pid, process_start_marker) VALUES(?, 7, 'ui-server', ?, 'dead-start')`)
      .run(randomUUID(), missingPid);
  })();

  const lifecycle = createLoopRunLifecycle({ ownerId, adapter: 'web' });
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
  const state = db.prepare('SELECT desired_intent, actual_phase FROM loop_lifecycle_state WHERE singleton = 1').get() as {
    desired_intent: string; actual_phase: string;
  };
  assert.ok(['running', 'stopped'].includes(state.desired_intent));
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

test('deduplicates explicit Web stop commands without changing the intent twice', async () => {
  const lifecycle=createLoopRunLifecycle({ownerId:`web-${process.pid}-${randomUUID()}`,adapter:'web'});
  const command={requestId:randomUUID(),source:{adapter:'ui' as const,instanceId:'test',actor:'human' as const},action:{kind:'stop' as const,reason:'user-stop' as const}};
  const first=await lifecycle.command(command),duplicate=await lifecycle.command(command);
  assert.deepEqual(duplicate,first);assert.equal(first.outcome,'stopped');
  await lifecycle.shutdown(true);
});

test('a clean manual start is healthy and does not count as a failed Runner restart', async () => {
  const db = await databaseConnection();
  db.prepare(`UPDATE loop_lifecycle_state SET desired_intent='stopped', actual_phase='stopped', active_run_id=NULL, retry_at=NULL, restart_count=3, last_error='previous error' WHERE singleton=1`).run();
  const lifecycle = createLoopRunLifecycle({ ownerId: `cli-${process.pid}-${randomUUID()}`, adapter: 'cli' });
  const source = { adapter: 'cli' as const, instanceId: 'clean-start', actor: 'human' as const };
  try {
    const receipt = await lifecycle.command({ requestId: randomUUID(), source, action: { kind: 'start' } });
    assert.equal(receipt.outcome, 'started', JSON.stringify(receipt));
    assert.equal(receipt.snapshot.run.healthy, true);
    assert.equal(receipt.snapshot.supervision.restartCount, 0);
    assert.equal(receipt.snapshot.supervision.retryAt, null);
    assert.equal(receipt.snapshot.lastError, null);
  } finally {
    await lifecycle.command({ requestId: randomUUID(), source, action: { kind: 'stop', reason: 'user-stop' } });
    await lifecycle.shutdown(true);
  }
});
