import assert from 'node:assert/strict';
import test from 'node:test';

test('reserves runnable work atomically and exposes the active reservation to inspection', async () => {
  const { createTask, beginRun, cancelTask, endRun } = await import('./tasks');
  const { progressDispatcher, progressDispatchInspector } = await import('./progress-dispatch');

  const taskId = await createTask({ title: 'Atomic dispatch reservation' });
  const runId = await beginRun('progress-dispatch-test');

  try {
    const first = await progressDispatcher.reserveNext({ runId });
    assert.equal(first.kind, 'reserved');
    assert.equal(first.reservations.length, 1);
    assert.equal(first.reservations[0].work.taskId, taskId);
    assert.equal(first.reservations[0].work.lane, 'control');
    assert.equal(first.reservations[0].work.agent, 'backlog-agent');
    assert.deepEqual(first.reservations[0].claimedResources, ['browser:exclusive']);

    const second = await progressDispatcher.reserveNext({ runId });
    assert.deepEqual(second, {
      kind: 'wait',
      reason: 'active-execution',
      wake: { kind: 'execution-completion' },
    });

    const explanation = await progressDispatchInspector.inspect({ requirementId: taskId });
    assert.equal(explanation.requirementId, taskId);
    assert.deepEqual(explanation.decisions, [{
      lane: 'control',
      state: 'active',
      reason: 'active-execution',
      executionId: first.reservations[0].executionId,
      reservationId: first.reservations[0].reservationId,
    }]);

    const activated = await progressDispatcher.activate({
      reservationId: first.reservations[0].reservationId,
      prepared: {
        prompt: 'Perform the reserved work',
        contextSnapshot: { snapshotId: 'snapshot-test' },
        baseCommit: 'base-test',
        promptMetadata: { version: 1, templateVersion: 2, hash: 'prompt-test' },
        memory: { revision: 3, hash: 'memory-test' },
        evolutionCandidateId: null,
        runtime: {
          executorId: 'test-executor',
          model: 'test-model',
          reasoningEffort: 'medium',
          webSearchEnabled: false,
        },
      },
    });
    assert.equal(activated.kind, 'running');
    assert.equal(activated.attempt.status, 'running');
    assert.equal(activated.attempt.input_hash === '', false);
    assert.equal(JSON.parse(activated.attempt.input_json).prompt, 'Perform the reserved work');

    assert.deepEqual(await progressDispatcher.executionExited({
      reservationId: first.reservations[0].reservationId,
    }), {
      kind: 'released',
      resources: ['browser:exclusive'],
    });
    assert.deepEqual(await progressDispatcher.settle({
      reservationId: first.reservations[0].reservationId,
    }), { kind: 'settled' });
    assert.deepEqual(await progressDispatcher.settle({
      reservationId: first.reservations[0].reservationId,
    }), { kind: 'already-settled' });
  } finally {
    await cancelTask({ taskId, reason: 'test cleanup' });
    await endRun(runId, true, { stopRunner: false });
  }
});

test('limits preparation failures to three persisted attempts before blocking the requirement', async () => {
  const { createTask, beginRun, cancelTask, endRun } = await import('./tasks');
  const { progressDispatcher } = await import('./progress-dispatch');
  const taskId = await createTask({ title: 'Finite preparation retries' });
  const runId = await beginRun('progress-dispatch-retry-test');

  try {
    const outcomes: unknown[] = [];
    for (let expectedAttempt = 1; expectedAttempt <= 3; expectedAttempt += 1) {
      const dispatch = await progressDispatcher.reserveNext({ runId });
      assert.equal(dispatch.kind, 'reserved');
      const reservation = dispatch.reservations.find((item) => item.work.taskId === taskId);
      assert.ok(reservation);
      outcomes.push(await progressDispatcher.preparationFailed({
        reservationId: reservation.reservationId,
        error: `prompt preparation ${expectedAttempt}`,
      }));
    }
    assert.deepEqual(outcomes, [
      { kind: 'retry', attempt: 1 },
      { kind: 'retry', attempt: 2 },
      { kind: 'blocked', attempt: 3 },
    ]);

    const afterLimit = await progressDispatcher.reserveNext({ runId });
    assert.equal(afterLimit.kind, 'wait');
    assert.equal(afterLimit.reason, 'no-runnable-work');
  } finally {
    await cancelTask({ taskId, reason: 'test cleanup' });
    await endRun(runId, true, { stopRunner: false });
  }
});

test('cancels an unactivated reservation from a dead runner without consuming a retry', async () => {
  const { createTask, beginRun, cancelTask, endRun } = await import('./tasks');
  const { progressDispatcher } = await import('./progress-dispatch');
  const taskId = await createTask({ title: 'Dead runner reservation recovery' });
  const firstRunId = await beginRun('dead-runner-reservation-test');
  let activeRunId = firstRunId;

  try {
    const first = await progressDispatcher.reserveNext({ runId: firstRunId });
    assert.equal(first.kind, 'reserved');
    assert.ok(first.reservations.some((item) => item.work.taskId === taskId));

    await endRun(firstRunId, true, { stopRunner: false });
    activeRunId = await beginRun('replacement-runner-reservation-test');
    const replacement = await progressDispatcher.reserveNext({ runId: activeRunId });
    assert.equal(replacement.kind, 'reserved');
    const reservation = replacement.reservations.find((item) => item.work.taskId === taskId);
    assert.ok(reservation);
    assert.deepEqual(await progressDispatcher.preparationFailed({
      reservationId: reservation.reservationId,
      error: 'replacement preparation failed',
    }), { kind: 'retry', attempt: 1 });
  } finally {
    await cancelTask({ taskId, reason: 'test cleanup' });
    await endRun(activeRunId, true, { stopRunner: false });
  }
});
