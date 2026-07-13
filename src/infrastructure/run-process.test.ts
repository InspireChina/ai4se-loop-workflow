import assert from 'node:assert/strict';
import test from 'node:test';
import { isProcessAlive, runPidPath } from './run-process';

test('detects whether a local process is alive', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(null), false);
  assert.equal(isProcessAlive(2_147_483_647), false);
});

test('rejects unsafe run ids when building the pid path', () => {
  assert.throws(() => runPidPath('../other-run'), /invalid run id/);
});
