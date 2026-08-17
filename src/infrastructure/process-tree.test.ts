import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectProcessIdentity, waitForProcessIdentity, windowsTaskkillCommand } from './process-tree';

test('does not require PowerShell process identity during Windows startup', () => {
  const source = String(inspectProcessIdentity);
  assert.match(source, /windows-pid/);
  assert.doesNotMatch(source, /powershell|Get-Process|Get-CimInstance/i);
});

test('uses the v0.1.4-compatible Windows whole-tree cleanup command', () => {
  assert.deepEqual(windowsTaskkillCommand(4321), {
    command: 'taskkill.exe',
    args: ['/PID', '4321', '/T', '/F'],
  });
});

test('retries process identity inspection while a newly spawned process is alive', async () => {
  let attempts = 0;
  const identity = await waitForProcessIdentity(4321, {
    timeoutMs: 100,
    pollIntervalMs: 1,
    isAlive: () => true,
    inspect: (pid) => {
      attempts += 1;
      return attempts === 3 ? { pid, startMarker: 'fixture-start' } : null;
    },
  });

  assert.deepEqual(identity, { pid: 4321, startMarker: 'fixture-start' });
  assert.equal(attempts, 3);
});

test('stops waiting when the spawned process has already exited', async () => {
  let attempts = 0;
  const identity = await waitForProcessIdentity(4321, {
    timeoutMs: 100,
    pollIntervalMs: 1,
    isAlive: () => false,
    inspect: () => {
      attempts += 1;
      return null;
    },
  });

  assert.equal(identity, null);
  assert.equal(attempts, 1);
});

test('reads a stable identity for the current process', () => {
  const first = inspectProcessIdentity(process.pid);
  const second = inspectProcessIdentity(process.pid);

  assert.ok(first);
  assert.deepEqual(second, first);
});
