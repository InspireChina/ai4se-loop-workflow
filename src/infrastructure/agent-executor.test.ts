import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentFinalTextAccumulator, createAgentRunMetricsAccumulator, extractAgentFinalText, getAgentExecutor, parseAgentTelemetryStderr, parseAgentTelemetryStdout, parseAgentTelemetryStdoutEvents, resolveCursorAgentLaunch } from './agent-executor';

test('normalizes Cursor tool calls without retaining raw log lines', () => {
  const event = parseAgentTelemetryStdout('cursor', JSON.stringify({
    type: 'tool_call', subtype: 'started', call_id: 'cursor-call-1', tool_call: { shellToolCall: { args: { command: 'echo token=secret' } } },
  }));
  assert.deepEqual(event?.name, 'loop.agent.tool');
  assert.equal(event?.phase, 'started');
  assert.equal(event?.tool, 'shell');
  assert.equal(event?.toolCallId, 'cursor-call-1');
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
  assert.equal(claude?.tool, 'tool');
  assert.equal(claude?.toolCallId, 'tool-1');
});

test('coalesces output separately while mapping errors and stderr at the correct level', () => {
  const output = parseAgentTelemetryStdout('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'result' } }));
  const error = parseAgentTelemetryStdout('codex', JSON.stringify({ type: 'error', message: 'failed' }));
  const stderr = parseAgentTelemetryStderr('claude', 'WARNING: retrying');
  const info = parseAgentTelemetryStderr('cursor', 'cursor-retrieval: tracing to /tmp/retrieval.log');
  assert.equal(output, null);
  assert.equal(error?.level, 'ERROR');
  assert.equal(stderr?.level, 'WARNING');
  assert.equal(info?.level, 'DEFAULT');
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

test('prefers Cursor complete assistant output over its duplicated aggregate result', () => {
  const accumulator = createAgentFinalTextAccumulator('cursor');
  accumulator.ingest(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '{"outcome":"completed"}' }] } }));
  accumulator.ingest(JSON.stringify({ type: 'result', subtype: 'success', result: 'earlier commentary{"outcome":"completed"}' }));
  assert.equal(accumulator.value(), '{"outcome":"completed"}');
});

test('preserves parallel Claude tool blocks and their call ids', () => {
  const events = parseAgentTelemetryStdoutEvents('claude', JSON.stringify({
    type: 'assistant',
    message: { content: [
      { type: 'tool_use', id: 'tool-a', name: 'Read', input: { path: 'a' } },
      { type: 'tool_use', id: 'tool-b', name: 'Grep', input: { pattern: 'b' } },
    ] },
  }));
  assert.deepEqual(events.map((event) => [event.tool, event.toolCallId]), [['Read', 'tool-a'], ['Grep', 'tool-b']]);
});

test('captures aggregate Codex and Claude run metrics without inventing zero usage', () => {
  const codex = createAgentRunMetricsAccumulator('codex');
  codex.ingest(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 } }));
  assert.deepEqual(codex.value(), { usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 } });

  const claude = createAgentRunMetricsAccumulator('claude');
  claude.ingest(JSON.stringify({ type: 'result', total_cost_usd: 0.12, duration_ms: 900, modelUsage: { 'claude-test': { inputTokens: 5, outputTokens: 2 } } }));
  assert.deepEqual(claude.value(), { model: 'claude-test', usage: { modelUsage: { 'claude-test': { inputTokens: 5, outputTokens: 2 } } }, totalCostUsd: 0.12, durationMs: 900 });

  assert.deepEqual(createAgentRunMetricsAccumulator('cursor').value(), {});
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

test('passes the configured Claude model as an explicit CLI override', () => {
  const executor = getAgentExecutor('claude');
  const args = executor.buildArgs('prompt', '/workspace', { model: 'claude-sonnet-4-6' });
  assert.deepEqual(args, [
    '--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--no-session-persistence',
    '--model', 'claude-sonnet-4-6', 'prompt',
  ]);
  assert.match(executor.formatCommand('/workspace', { model: 'claude-sonnet-4-6' }), /--model claude-sonnet-4-6/);
  assert.equal(executor.buildArgs('prompt', '/workspace').includes('--model'), false);
});

test('uses the native Cursor Agent wrapper outside Windows with the workspace supplied as cwd', { skip: process.platform === 'win32' }, () => {
  const executor = getAgentExecutor('cursor');
  const args = executor.buildArgs('do the work', 'C:\\Users\\developer\\project');
  assert.equal(executor.command, process.env.CURSOR_CLI || 'cursor-agent');
  assert.deepEqual(args, ['--print', '--output-format', 'stream-json', '--force', 'do the work']);
  assert.equal(args.includes('agent'), false);
  assert.equal(args.includes('--workspace'), false);
  assert.equal(args.includes('--trust'), false);
  assert.equal(executor.promptMode, 'file-reference');
  assert.match(executor.formatCommand('C:\\Users\\developer\\project'), /^cursor-agent .*\(cwd=C:\\Users\\developer\\project\)$/);
});

test('launches Cursor through its bundled Node on Windows instead of cursor-agent.cmd', () => {
  const home = mkdtempSync(join(tmpdir(), 'loopwork-cursor-agent-'));
  const version = join(home, '.local', 'share', 'cursor-agent', 'versions', '2026.07.18-test');
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, 'node.exe'), 'fixture');
  writeFileSync(join(version, 'index.js'), 'fixture');

  const launch = resolveCursorAgentLaunch({
    platform: 'win32', home,
    env: { LOCALAPPDATA: String.raw`C:\Users\dev\AppData\Local`, CURSOR_CLI: 'cursor-agent.cmd' },
  });

  assert.equal(launch.command, join(version, 'node.exe'));
  assert.deepEqual(launch.prefixArgs, [join(version, 'index.js')]);
  assert.equal(launch.env.CURSOR_INVOKED_AS, 'cursor-agent');
  assert.equal(launch.env.NODE_COMPILE_CACHE, String.raw`C:\Users\dev\AppData\Local\cursor-compile-cache`);
  assert.equal(launch.viaBundledNode, true);
});

test('supports explicit Windows Cursor bundled Node paths and rejects partial configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'loopwork-cursor-override-'));
  const node = join(root, 'node.exe');
  const script = join(root, 'index.js');
  writeFileSync(node, 'fixture');
  writeFileSync(script, 'fixture');

  const launch = resolveCursorAgentLaunch({ platform: 'win32', home: root, env: { CURSOR_AGENT_NODE: node, CURSOR_AGENT_SCRIPT: script } });
  assert.equal(launch.command, node);
  assert.deepEqual(launch.prefixArgs, [script]);
  assert.throws(() => resolveCursorAgentLaunch({ platform: 'win32', home: root, env: { CURSOR_AGENT_NODE: node } }), /必须同时设置/);
});
