import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executionRetryBackoffMs,
  remainingExecutionRetries,
  retryNotBeforeForFailure,
  shouldRetryReportedFailure,
} from './execution-retry-policy';

test('uses bounded universal retry backoff for every failure kind', () => {
  const env = { LOOP_RETRY_BACKOFF_SCALE: '1' } as NodeJS.ProcessEnv;
  assert.equal(executionRetryBackoffMs(1, env), 10_000);
  assert.equal(executionRetryBackoffMs(2, env), 30_000);
  assert.equal(executionRetryBackoffMs(3, env), 120_000);
  assert.equal(executionRetryBackoffMs(99, env), 120_000);
  assert.equal(retryNotBeforeForFailure(2, new Date('2026-08-22T00:00:00.000Z'), env), '2026-08-22T00:00:30.000Z');
});

test('retries structured failure results three times before applying the final negative result', () => {
  assert.equal(shouldRetryReportedFailure({ outcome: 'failed' }, 1), true);
  assert.equal(shouldRetryReportedFailure({ verdict: 'failed' }, 3), true);
  assert.equal(shouldRetryReportedFailure({ outcome: 'failed' }, 4), false);
  assert.equal(shouldRetryReportedFailure({ outcome: 'completed', verdict: 'passed' }, 1), false);
});

test('reports remaining retries after the current execution attempt', () => {
  assert.equal(remainingExecutionRetries(1), 3);
  assert.equal(remainingExecutionRetries(2), 2);
  assert.equal(remainingExecutionRetries(3), 1);
  assert.equal(remainingExecutionRetries(4), 0);
});
