import assert from 'node:assert/strict';
import test from 'node:test';

test('structured Test failures immediately reach workflow application without consuming CLI retry budget', () => {
  for (let attempt = 1; attempt <= 8; attempt++) {
    assert.equal(shouldRetryReportedFailure({ outcome: 'completed', verdict: 'failed' }, attempt, 'test-agent'), false);
  }
  assert.equal(shouldRetryReportedFailure({ outcome: 'failed' }, 1, 'test-agent'), true,
    'an execution failure without a Test verdict still uses the universal retry policy');
  assert.equal(shouldRetryReportedFailure({ outcome: 'completed', verdict: 'passed' }, 1, 'test-agent'), false);
  assert.equal(shouldRetryReportedFailure({ verdict: 'failed' }, 1, 'dev-agent'), true);
  assert.equal(shouldRetryReportedFailure({ verdict: 'failed' }, 1), true,
    'the caller must supply the actual authenticated role, not guess it from the verdict');
});
import {
  executionRetryBackoffMs,
  executionRecoveryModeForAttempt,
  remainingExecutionRetries,
  retryRecoveryPlanForFailure,
  retryNotBeforeForFailure,
  shouldRetryReportedFailure,
} from './execution-retry-policy';

test('uses bounded universal retry backoff for every failure kind', () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', LOOP_RETRY_BACKOFF_SCALE: '1' };
  assert.equal(executionRetryBackoffMs(1, env), 10_000);
  assert.equal(executionRetryBackoffMs(2, env), 30_000);
  assert.equal(executionRetryBackoffMs(3, env), 120_000);
  assert.equal(executionRetryBackoffMs(4, env), 300_000);
  assert.equal(executionRetryBackoffMs(99, env), 300_000);
  assert.equal(retryNotBeforeForFailure(2, new Date('2026-08-22T00:00:00.000Z'), env), '2026-08-22T00:00:30.000Z');
});

test('retries structured failure results four times before applying the final negative result', () => {
  assert.equal(shouldRetryReportedFailure({ outcome: 'failed' }, 1), true);
  assert.equal(shouldRetryReportedFailure({ verdict: 'failed' }, 4), true);
  assert.equal(shouldRetryReportedFailure({ outcome: 'failed' }, 5), false);
  assert.equal(shouldRetryReportedFailure({ outcome: 'completed', verdict: 'passed' }, 1), false);
});

test('reports remaining retries after the current execution attempt', () => {
  assert.equal(remainingExecutionRetries(1), 4);
  assert.equal(remainingExecutionRetries(2), 3);
  assert.equal(remainingExecutionRetries(3), 2);
  assert.equal(remainingExecutionRetries(4), 1);
  assert.equal(remainingExecutionRetries(5), 0);
});

test('uses a runtime-neutral recovery ladder with two minimal attempts', () => {
  assert.deepEqual([1, 2, 3, 4].map((attempt) => retryRecoveryPlanForFailure(attempt)?.mode), [
    'standard', 'compact', 'minimal', 'minimal',
  ]);
  assert.deepEqual([1, 2, 3, 4, 5].map(executionRecoveryModeForAttempt), [
    'initial', 'standard', 'compact', 'minimal', 'minimal',
  ]);
  assert.equal(retryRecoveryPlanForFailure(5), null);
});
