import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentTelemetryStderr, parseAgentTelemetryStdout } from './agent-executor';

test('normalizes Cursor tool calls without retaining raw log lines', () => {
  const event = parseAgentTelemetryStdout('cursor', JSON.stringify({
    type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command: 'echo token=secret' } } },
  }));
  assert.deepEqual(event?.name, 'loop.agent.tool');
  assert.equal(event?.phase, 'started');
  assert.equal(event?.tool, 'shell');
  assert.deepEqual(event?.input, { command: 'echo token=secret' });
});

test('normalizes Codex tool completion and Claude tool results', () => {
  const codex = parseAgentTelemetryStdout('codex', JSON.stringify({
    type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0, aggregated_output: 'passed' },
  }));
  const claude = parseAgentTelemetryStdout('claude', JSON.stringify({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] },
  }));
  assert.equal(codex?.phase, 'completed');
  assert.equal(codex?.tool, 'shell');
  assert.equal(claude?.phase, 'completed');
  assert.equal(claude?.tool, 'tool-1');
});

test('maps output, errors, and non-JSON stderr to bounded telemetry summaries', () => {
  const output = parseAgentTelemetryStdout('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'result' } }));
  const error = parseAgentTelemetryStdout('codex', JSON.stringify({ type: 'error', message: 'failed' }));
  const stderr = parseAgentTelemetryStderr('claude', 'WARNING: retrying');
  assert.equal(output?.name, 'loop.agent.output');
  assert.equal(error?.level, 'ERROR');
  assert.equal(stderr?.level, 'WARNING');
  assert.equal(parseAgentTelemetryStderr('codex', 'Reading additional input from stdin...'), null);
});
