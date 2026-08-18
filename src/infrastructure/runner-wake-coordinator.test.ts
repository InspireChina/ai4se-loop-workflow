import assert from 'node:assert/strict';
import test from 'node:test';
import { RunnerWakeCoordinator } from './runner-wake-coordinator';

test('coalesces runtime wakes without missing an event between snapshot and wait', async () => {
  const coordinator = new RunnerWakeCoordinator();
  const revision = coordinator.revision();
  coordinator.wake('runtime-event');
  const wake = await coordinator.wait(revision);
  assert.equal(wake.reason, 'runtime-event');
  assert.equal(wake.revision, 1);
  coordinator.close();
});

test('wakes at the nearest deadline and can close pending waits', async () => {
  const coordinator = new RunnerWakeCoordinator();
  const deadline = await coordinator.wait(coordinator.revision(), Date.now() + 10);
  assert.equal(deadline.reason, 'deadline');
  const pending = coordinator.wait(coordinator.revision());
  coordinator.close();
  assert.equal((await pending).reason, 'closed');
});
