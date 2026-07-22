import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_AGENT_EXECUTOR_IDLE_TIMEOUT_MS,
  DEFAULT_AGENT_EXECUTOR_TIMEOUT_MS,
  resolveAgentExecutionLimits,
} from './agent-execution-limits';

test('allows flow agents to run for four hours by default', () => {
  assert.equal(DEFAULT_AGENT_EXECUTOR_TIMEOUT_MS, 4 * 60 * 60 * 1000);
  assert.equal(DEFAULT_AGENT_EXECUTOR_IDLE_TIMEOUT_MS, 30 * 60 * 1000);
  assert.deepEqual(resolveAgentExecutionLimits({}), {
    maxRuntimeMs: 4 * 60 * 60 * 1000,
    idleTimeoutMs: DEFAULT_AGENT_EXECUTOR_IDLE_TIMEOUT_MS,
  });
});

test('uses one validated timeout source for agent execution', () => {
  const env = { AGENT_EXECUTOR_TIMEOUT_MS: '18000000', AGENT_EXECUTOR_IDLE_TIMEOUT_MS: '1200000' };
  assert.deepEqual(resolveAgentExecutionLimits(env), { maxRuntimeMs: 18_000_000, idleTimeoutMs: 1_200_000 });
  assert.equal(resolveAgentExecutionLimits({ AGENT_EXECUTOR_TIMEOUT_MS: 'invalid' }).maxRuntimeMs, DEFAULT_AGENT_EXECUTOR_TIMEOUT_MS);
  assert.equal(resolveAgentExecutionLimits({ CURSOR_AGENT_TIMEOUT_MS: '7200000' }).maxRuntimeMs, 7_200_000);
});
