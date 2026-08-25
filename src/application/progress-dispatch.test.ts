import assert from 'node:assert/strict';
import test from 'node:test';

test('reserves runnable work atomically and exposes the active reservation to inspection', async () => {
  const { createTask, beginRun, cancelTask, endRun, getTask } = await import('./tasks');
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
        recovery: { mode: 'initial', label: '正常上下文', retryNumber: 0 },
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
    const duplicateActivation = await progressDispatcher.activate({
      reservationId: first.reservations[0].reservationId,
      prepared: {
        prompt: 'ignored duplicate',
        contextSnapshot: {},
        recovery: { mode: 'initial', label: '正常上下文', retryNumber: 0 },
        promptMetadata: { version: 9, templateVersion: 9, hash: 'ignored' },
        memory: { revision: 9, hash: 'ignored' },
        runtime: { executorId: 'ignored', webSearchEnabled: false },
      },
    });
    assert.equal(duplicateActivation.kind, 'running');
    assert.equal(duplicateActivation.attempt.input_hash, activated.attempt.input_hash);

    assert.deepEqual(await progressDispatcher.executionExited({
      reservationId: first.reservations[0].reservationId,
    }), {
      kind: 'released',
      resources: ['browser:exclusive'],
    });
    const audited = await getTask(taskId);
    assert.equal(audited?.executionAttempts[0].claimed_resources, 'browser:exclusive');
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

test('retries preparation failures four times before blocking the requirement', async () => {
  const { createTask, beginRun, cancelTask, endRun, releaseBlock } = await import('./tasks');
  const { progressDispatcher } = await import('./progress-dispatch');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Finite preparation retries' });
  const runId = await beginRun('progress-dispatch-retry-test');

  try {
    const outcomes: unknown[] = [];
    for (let expectedAttempt = 1; expectedAttempt <= 5; expectedAttempt += 1) {
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
      { kind: 'retry', attempt: 3 },
      { kind: 'retry', attempt: 4 },
      { kind: 'blocked', attempt: 5 },
    ]);
    const failureEvents = db.prepare(`
      SELECT event_type, summary FROM task_events
      WHERE task_id = ? AND event_type IN ('AgentExecutionRetryScheduled', 'AgentExecutionRetriesExhausted')
      ORDER BY rowid
    `).all(taskId) as Array<{ event_type: string; summary: string }>;
    assert.deepEqual(failureEvents.map((event) => event.event_type), [
      'AgentExecutionRetryScheduled',
      'AgentExecutionRetryScheduled',
      'AgentExecutionRetryScheduled',
      'AgentExecutionRetryScheduled',
      'AgentExecutionRetriesExhausted',
    ]);
    assert.match(failureEvents[0].summary, /agent-preparation.*prompt preparation 1/);
    assert.match(failureEvents[0].summary, /恢复策略 标准恢复包/);
    assert.match(failureEvents[3].summary, /恢复策略 最小恢复包/);
    assert.match(failureEvents[4].summary, /第 5 次失败，4 次自动重试已耗尽.*prompt preparation 5/);

    const afterLimit = await progressDispatcher.reserveNext({ runId });
    assert.equal(afterLimit.kind, 'wait');
    assert.equal(afterLimit.reason, 'no-runnable-work');
    await releaseBlock(taskId);
    const afterRelease = await progressDispatcher.reserveNext({ runId });
    assert.equal(afterRelease.kind, 'reserved');
    const resumed = afterRelease.reservations.find((item) => item.work.taskId === taskId);
    assert.ok(resumed);
    const resumedAttempt = db.prepare('SELECT attempt FROM execution_attempts WHERE execution_id = ?')
      .get(resumed.executionId) as { attempt: number };
    assert.equal(resumedAttempt.attempt, 1);
    await progressDispatcher.settle({ reservationId: resumed.reservationId });
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

test('waits for the universal retry backoff deadline before redispatching', async () => {
  const { createTask, beginRun, cancelTask, endRun } = await import('./tasks');
  const { progressDispatcher } = await import('./progress-dispatch');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const previousScale = process.env.LOOP_RETRY_BACKOFF_SCALE;
  process.env.LOOP_RETRY_BACKOFF_SCALE = '1';
  const taskId = await createTask({ title: 'Retry backoff deadline' });
  const runId = await beginRun('progress-dispatch-backoff-test');

  try {
    const first = await progressDispatcher.reserveNext({ runId });
    assert.equal(first.kind, 'reserved');
    const reservation = first.reservations.find((item) => item.work.taskId === taskId);
    assert.ok(reservation);
    assert.deepEqual(await progressDispatcher.preparationFailed({
      reservationId: reservation.reservationId,
      error: 'transient preparation failure',
    }), { kind: 'retry', attempt: 1 });

    const waiting = await progressDispatcher.reserveNext({ runId });
    assert.equal(waiting.kind, 'wait');
    assert.equal(waiting.wake.kind, 'retry-after');
    if (waiting.wake.kind === 'retry-after') assert.ok(Date.parse(waiting.wake.notBefore) > Date.now());

    db.prepare("UPDATE execution_attempts SET retry_not_before = '2000-01-01T00:00:00.000Z' WHERE execution_id = ?")
      .run(reservation.executionId);
    const retried = await progressDispatcher.reserveNext({ runId });
    assert.equal(retried.kind, 'reserved');
    const retryReservation = retried.reservations.find((item) => item.work.taskId === taskId);
    assert.ok(retryReservation);
    const retryAttempt = db.prepare('SELECT attempt FROM execution_attempts WHERE execution_id = ?')
      .get(retryReservation.executionId) as { attempt: number };
    assert.equal(retryAttempt.attempt, 2);
    await progressDispatcher.settle({ reservationId: retryReservation.reservationId });
  } finally {
    if (previousScale === undefined) delete process.env.LOOP_RETRY_BACKOFF_SCALE;
    else process.env.LOOP_RETRY_BACKOFF_SCALE = previousScale;
    await cancelTask({ taskId, reason: 'test cleanup' });
    await endRun(runId, true, { stopRunner: false });
  }
});
