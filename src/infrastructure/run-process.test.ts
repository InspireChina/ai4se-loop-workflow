import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import {
  cancelRunnerStartGate,
  createRunnerStartGate,
  isProcessAlive,
  releaseRunnerStartGate,
  runnerStartGatePath,
  runPidPath,
  waitForRunnerStartGate,
} from './run-process';

test('detects whether a local process is alive', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(null), false);
  assert.equal(isProcessAlive(2_147_483_647), false);
});

test('rejects unsafe run ids when building the pid path', () => {
  assert.throws(() => runPidPath('../other-run'), /invalid run id/);
  assert.throws(() => runnerStartGatePath('../other-run'), /invalid run id/);
});

test('keeps a Runner behind its start gate until the parent completes registration', async () => {
  const gate = await createRunnerStartGate('RUN-gate-fixture');
  let released = false;
  const waiting = waitForRunnerStartGate(gate.runId, gate.token, 1_000).then(() => { released = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(released, false);

  await releaseRunnerStartGate(gate);
  await waiting;
  assert.equal(existsSync(runnerStartGatePath(gate.runId)), false);
  await cancelRunnerStartGate(gate);
});
