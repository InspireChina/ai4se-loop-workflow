import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAgentFinalText, getAgentExecutor, parseAgentTelemetryStderr, parseAgentTelemetryStdout } from './agent-executor';

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

test('extracts final assistant text from every executor stream', () => {
  const result = '{"outcome":"completed","summary":"ok"}';
  assert.equal(extractAgentFinalText('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: result } })), result);
  assert.equal(extractAgentFinalText('cursor', JSON.stringify({ type: 'result', subtype: 'success', result })), result);
  assert.equal(extractAgentFinalText('cursor', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: result }] } })), result);
  assert.equal(extractAgentFinalText('claude', JSON.stringify({ type: 'result', is_error: false, result })), result);
  assert.equal(extractAgentFinalText('codex', JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } })), null);
});

test('passes Codex model and reasoning effort as explicit CLI overrides', () => {
  const executor = getAgentExecutor('codex');
  const args = executor.buildArgs('prompt', '/workspace', { model: 'gpt-5.6-terra', reasoningEffort: 'high' });
  assert.deepEqual(args, [
    'exec', '--json', '--dangerously-bypass-approvals-and-sandbox',
    '--model', 'gpt-5.6-terra',
    '--config', 'model_reasoning_effort="high"',
    '-C', '/workspace', '-',
  ]);
  assert.match(executor.formatCommand('/workspace', { model: 'gpt-5.6-terra', reasoningEffort: 'high' }), /--model gpt-5\.6-terra --config model_reasoning_effort=high/);
});

test('leaves Codex model defaults untouched when no override is configured', () => {
  const args = getAgentExecutor('codex').buildArgs('prompt', '/workspace');
  assert.equal(args.includes('--model'), false);
  assert.equal(args.includes('--config'), false);
});

test('uses the native Cursor Agent CLI with the workspace supplied as cwd', () => {
  const executor = getAgentExecutor('cursor');
  const args = executor.buildArgs('do the work', 'C:\\Users\\developer\\project');
  assert.equal(executor.command, process.env.CURSOR_CLI || 'cursor-agent');
  assert.deepEqual(args, ['--print', '--output-format', 'stream-json', '--force', 'do the work']);
  assert.equal(args.includes('agent'), false);
  assert.equal(args.includes('--workspace'), false);
  assert.equal(args.includes('--trust'), false);
  assert.match(executor.formatCommand('C:\\Users\\developer\\project'), /^cursor-agent .*\(cwd=C:\\Users\\developer\\project\)$/);
});
