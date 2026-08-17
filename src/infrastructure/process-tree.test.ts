import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectProcessIdentity, processIdentityCommand, waitForProcessIdentity } from './process-tree';

test('uses Get-Process instead of eventually consistent CIM data for Windows process identity', () => {
  const lookup = processIdentityCommand(4321, 'win32');

  assert.equal(lookup.command, 'powershell.exe');
  assert.match(lookup.args.at(-1) || '', /Get-Process -Id 4321/);
  assert.match(lookup.args.at(-1) || '', /StartTime\.ToUniversalTime\(\)\.ToString\('o'\)/);
  assert.doesNotMatch(lookup.args.at(-1) || '', /Get-CimInstance/);
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
