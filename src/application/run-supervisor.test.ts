import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunStatus } from './tasks';
import { decideLoopSupervision, restartDelayMs, type LoopRunIntent } from './run-supervisor';

const intent: LoopRunIntent = { enabledAt: '2026-08-13T00:00:00.000Z', restartCount: 0 };
const healthyRun: NonNullable<RunStatus> = {
  runId: 'healthy-run',
  owner: 'agent-runner',
  startedAt: '2026-08-13T00:00:00.000Z',
  heartbeatAt: '2026-08-13T00:00:10.000Z',
  processKind: 'agent-runner',
  status: 'running',
  pid: process.pid,
  active: true,
};

test('supervisor stays disabled until the user has started the loop', () => {
  assert.deepEqual(decideLoopSupervision(null, null, Date.now()), { action: 'disabled' });
});

test('supervisor leaves a healthy runner alone', () => {
  assert.deepEqual(decideLoopSupervision(intent, healthyRun, Date.now()), { action: 'healthy' });
});

test('supervisor restarts a crashed process or stale-heartbeat runner', () => {
  const unhealthy = { ...healthyRun, active: false };
  assert.deepEqual(decideLoopSupervision(intent, unhealthy, Date.now()), { action: 'restart' });
  assert.deepEqual(decideLoopSupervision(intent, null, Date.now()), { action: 'restart' });
});

test('supervisor claim prevents duplicate launches and increases bounded backoff', () => {
  const now = Date.now();
  const nextRestartAt = new Date(now + 30_000).toISOString();
  assert.deepEqual(
    decideLoopSupervision({ ...intent, restartCount: 2, nextRestartAt }, null, now),
    { action: 'backoff', nextRestartAt },
  );
  assert.equal(restartDelayMs(1), 10_000);
  assert.equal(restartDelayMs(2), 30_000);
  assert.equal(restartDelayMs(3), 90_000);
  assert.equal(restartDelayMs(20), 300_000);
});
