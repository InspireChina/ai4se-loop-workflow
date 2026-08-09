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
  assert.equal(event?.toolClass, 'shell');
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
  assert.equal(codex?.toolClass, 'shell');
  assert.equal(codex?.success, true);
  assert.equal(codex?.exitCode, 0);
  assert.deepEqual(codex?.output, { result: 'passed', exitCode: 0, status: null });
  assert.equal(claude?.phase, 'completed');
  assert.equal(claude?.tool, 'tool');
  assert.equal(claude?.toolClass, 'unknown');
  assert.equal(claude?.toolCallId, 'tool-1');
  assert.equal(claude?.success, true);
  assert.equal(claude?.exitCode, null);
});

test('treats a completed Codex web search without an explicit status as successful', () => {
  const event = parseAgentTelemetryStdout('codex', JSON.stringify({
    type: 'item.completed', item: { id: 'search-1', type: 'web_search', query: 'current industry standard' },
  }));
  assert.equal(event?.tool, 'web_search');
  assert.equal(event?.phase, 'completed');
  assert.equal(event?.success, true);
});

test('marks a non-zero Cursor shell receipt as failed even when Cursor wraps it as a success result', () => {
  const event = parseAgentTelemetryStdout('cursor', JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'cursor-call-failed',
    tool_call: {
      shellToolCall: {
        result: {
          success: {
            exitCode: 2,
            stdout: 'test failed',
          },
        },
      },
    },
  }));

  assert.equal(event?.phase, 'completed');
  assert.equal(event?.toolClass, 'shell');
  assert.equal(event?.success, false);
  assert.equal(event?.exitCode, 2);
  assert.equal(event?.level, 'ERROR');
});

test('fails closed when a Codex shell completion has no numeric exit code', () => {
  const event = parseAgentTelemetryStdout('codex', JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'npm test', aggregated_output: 'done' },
  }));

  assert.equal(event?.toolClass, 'shell');
  assert.equal(event?.success, false);
  assert.equal(event?.exitCode, null);
});

test('classifies Claude Bash starts explicitly and reports provider-declared failures', () => {
  const started = parseAgentTelemetryStdout('claude', JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tool-bash', name: 'Bash', input: { command: 'npm test' } }] },
  }));
  const completed = parseAgentTelemetryStdout('claude', JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-bash', content: 'failed', is_error: true }] },
  }));

  assert.equal(started?.toolClass, 'shell');
  assert.equal(completed?.toolClass, 'unknown');
  assert.equal(completed?.success, false);
  assert.equal(completed?.exitCode, null);
  assert.equal(completed?.level, 'ERROR');
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
  assert.equal(
    parseAgentTelemetryStderr(
      'codex',
      '2026-07-25T03:58:12Z WARN codex_core_plugins::manifest: ignoring interface.defaultPrompt: maximum of 3 prompts is supported path=file:///plugin.json',
    ),
    null,
  );
});

test('labels command-driven draft updates as Agent domain commands', () => {
  const line = JSON.stringify({
    type: 'item.started',
    item: {
      type: 'command_execution',
      command: 'node "/app/scripts/loop/loop-agent.mjs" requirement-context status',
    },
  });
  const parsed = getAgentExecutor('codex').parseStdout(line, {
    agent: 'backlog-agent',
    taskId: 'REQ-1',
    storyIndex: null,
    pipeline: 'resume',
  });
  assert.match(parsed || '', /tool=agent-command/);
  assert.match(parsed || '', /恢复需求上下文草稿/);
});

test('labels Business Analysis packets as Agent domain commands', () => {
  const line = JSON.stringify({
    type: 'item.started',
    item: {
      type: 'command_execution',
      command: 'node "/app/scripts/loop/loop-agent.mjs" business-design decision-proposal complete --artifact-file /tmp/tree.json',
    },
  });
  const parsed = getAgentExecutor('codex').parseStdout(line, {
    agent: 'business-design-agent',
    taskId: 'REQ-BA',
    storyIndex: null,
    pipeline: 'ba-design',
  });
  assert.match(parsed || '', /tool=agent-command/);
  assert.match(parsed || '', /提交业务方案工作包/);
});

test('labels quoted delivery-plan arguments with the specific progressive action', () => {
  const line = JSON.stringify({
    type: 'item.started',
    item: {
      type: 'command_execution',
      command: "/bin/zsh -lc 'node \"/app/scripts/loop/loop-agent.mjs\" '\"'\"'delivery-plan'\"'\"' '\"'\"'unit'\"'\"' '\"'\"'upsert'\"'\"' --key csv-export'",
    },
  });
  const parsed = getAgentExecutor('codex').parseStdout(line, {
    agent: 'story-splitter-agent',
    taskId: 'REQ-1',
    storyIndex: null,
    pipeline: 'split',
  });
  assert.match(parsed || '', /tool=agent-command/);
  assert.match(parsed || '', /保存交付单元/);
});

test('labels progressive reproduction evidence as an Agent domain action', () => {
  const line = JSON.stringify({
    type: 'item.started',
    item: {
      type: 'command_execution',
      command: 'node "/app/scripts/loop/loop-agent.mjs" reproduction evidence upsert --key browser',
    },
  });
  const parsed = getAgentExecutor('codex').parseStdout(line, {
    agent: 'repro-agent',
    taskId: 'REQ-1',
    storyIndex: null,
    pipeline: 'repro',
  });
  assert.match(parsed || '', /tool=agent-command/);
  assert.match(parsed || '', /更新复现证据/);
});

test('labels escaped and chained progressive commands as Agent domain actions', () => {
  const line = JSON.stringify({
    type: 'item.started',
    item: {
      type: 'command_execution',
      command: '/bin/zsh -lc "node \\"/app/scripts/loop/loop-agent.mjs\\" reproduction actual set --text result && node \\"/app/scripts/loop/loop-agent.mjs\\" reproduction validate"',
    },
  });
  const parsed = getAgentExecutor('codex').parseStdout(line, {
    agent: 'repro-agent',
    taskId: 'REQ-1',
    storyIndex: null,
    pipeline: 'resume',
  });
  assert.match(parsed || '', /tool=agent-command/);
  assert.match(parsed || '', /保存实际行为/);
});

test('labels Cursor shell wrappers around progressive commands as Agent domain actions', () => {
  const line = JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    tool_call: {
      shellToolCall: {
        args: {
          command: '/bin/zsh -lc "node \\"/app/scripts/loop/loop-agent.mjs\\" reproduction status"',
        },
      },
    },
  });
  const parsed = getAgentExecutor('cursor').parseStdout(line, {
    agent: 'repro-agent',
    taskId: 'REQ-1',
    storyIndex: null,
    pipeline: 'resume',
  });
  assert.match(parsed || '', /tool=agent-command/);
  assert.match(parsed || '', /恢复问题复现草稿/);
});

test('labels progressive delivery-analysis decisions as Agent domain actions', () => {
  const line = JSON.stringify({
    type: 'item.started',
    item: {
      type: 'command_execution',
      command: 'node "/app/scripts/loop/loop-agent.mjs" delivery-analysis decision resolve --key output-mode',
    },
  });
  const parsed = getAgentExecutor('codex').parseStdout(line, {
    agent: 'analyst-agent',
    taskId: 'REQ-1',
    storyIndex: 1,
    pipeline: 'resume',
  });
  assert.match(parsed || '', /tool=agent-command/);
  assert.match(parsed || '', /关闭关键决策/);
});

test('labels the Analyst frozen delivery contract without Dev-to-Test handoff terminology', () => {
  const line = JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    tool_call: {
      shellToolCall: {
        args: {
          command: 'node "/app/scripts/loop/loop-agent.mjs" delivery-analysis contract set --text frozen',
        },
      },
    },
  });
  const parsed = getAgentExecutor('cursor').parseStdout(line, {
    agent: 'analyst-agent',
    taskId: 'REQ-1',
    storyIndex: 1,
    pipeline: 'analysis',
  });
  assert.match(parsed || '', /保存冻结交付契约/);
  assert.doesNotMatch(parsed || '', /开发.*交接/);
});

test('labels progressive development evidence selection as an Agent domain action', () => {
  const line = JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    tool_call: {
      shellToolCall: {
        args: {
          command: 'node "/app/scripts/loop/loop-agent.mjs" implementation check record --key unit --receipt 00000042 --summary passed',
        },
      },
    },
  });
  const parsed = getAgentExecutor('cursor').parseStdout(line, {
    agent: 'dev-agent',
    taskId: 'REQ-1',
    storyIndex: 1,
    pipeline: 'dev',
  });
  assert.match(parsed || '', /tool=agent-command/);
  assert.match(parsed || '', /选择关键检查/);
});

test('labels the trusted development commit confirmation as an Agent domain action', () => {
  const line = JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    tool_call: {
      shellToolCall: {
        args: {
          command: 'node "/app/scripts/loop/loop-agent.mjs" implementation commit complete',
        },
      },
    },
  });
  const parsed = getAgentExecutor('cursor').parseStdout(line, {
    agent: 'dev-agent',
    taskId: 'REQ-1',
    storyIndex: 1,
    pipeline: 'dev',
  });
  assert.match(parsed || '', /tool=agent-command/);
  assert.match(parsed || '', /确认代码提交步骤/);
});

test('labels progressive independent verification results as an Agent domain action', () => {
  const line = JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    tool_call: {
      shellToolCall: {
        args: {
          command: 'node "/app/scripts/loop/loop-agent.mjs" verification result record --key checkout-happy-path --status passed',
        },
      },
    },
  });
  const parsed = getAgentExecutor('cursor').parseStdout(line, {
    agent: 'test-agent',
    taskId: 'REQ-1',
    storyIndex: 1,
    pipeline: 'test',
  });
  assert.match(parsed || '', /tool=agent-command/);
  assert.match(parsed || '', /记录场景验证结果/);
});

test('labels progressive feedback grouping as an Agent domain action', () => {
  const line = JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    tool_call: {
      shellToolCall: {
        args: {
          command: 'node "/app/scripts/loop/loop-agent.mjs" feedback group comment add --key empty-state --id COMMENT-1',
        },
      },
    },
  });
  const parsed = getAgentExecutor('cursor').parseStdout(line, {
    agent: 'feedback-agent',
    taskId: 'REQ-1',
    storyIndex: null,
    pipeline: 'feedback-triage',
  });
  assert.match(parsed || '', /tool=agent-command/);
  assert.match(parsed || '', /更新反馈工作组/);
});

test('labels progressive Review reconciliation as an Agent domain action', () => {
  const line = JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    tool_call: {
      shellToolCall: {
        args: {
          command: 'node "/app/scripts/loop/loop-agent.mjs" review reconciliation upsert --key final-outcome --subject DELIVERY_UNIT:REQ-1:1',
        },
      },
    },
  });
  const parsed = getAgentExecutor('cursor').parseStdout(line, {
    agent: 'review-agent',
    taskId: 'REQ-1',
    storyIndex: null,
    pipeline: 'review',
  });
  assert.match(parsed || '', /tool=agent-command/);
  assert.match(parsed || '', /保存最终事实对账/);
});

test('labels progressive internal Agent commands as domain actions', () => {
  const evolution = getAgentExecutor('codex').parseStdout(JSON.stringify({
    type: 'item.started',
    item: {
      type: 'command_execution',
      command: 'node "/app/scripts/loop/loop-agent.mjs" evolution observation upsert --key shell-quoting',
    },
  }), {
    agent: 'prompt-evolution-agent',
    taskId: 'REQ-1',
    storyIndex: null,
    pipeline: 'evolution',
  });
  const maintenance = getAgentExecutor('codex').parseStdout(JSON.stringify({
    type: 'item.started',
    item: {
      type: 'command_execution',
      command: 'node "/app/scripts/loop/loop-agent.mjs" maintenance test upsert --key targeted',
    },
  }), {
    agent: 'software-maintenance-agent',
    taskId: 'JOB-1',
    storyIndex: null,
    pipeline: 'software-maintenance',
  });
  assert.match(evolution || '', /tool=agent-command/);
  assert.match(evolution || '', /更新可复用观察/);
  assert.match(maintenance || '', /tool=agent-command/);
  assert.match(maintenance || '', /更新维护测试/);
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

test('passes Codex web search, model and reasoning effort as explicit CLI overrides', () => {
  const executor = getAgentExecutor('codex');
  const args = executor.buildArgs('prompt', '/workspace', { model: 'gpt-5.6-terra', reasoningEffort: 'high', webSearch: true });
  assert.deepEqual(args, [
    '--search', 'exec', '--json', '--dangerously-bypass-approvals-and-sandbox',
    '--model', 'gpt-5.6-terra',
    '--config', 'model_reasoning_effort="high"',
    '-C', '/workspace', '-',
  ]);
  assert.match(executor.formatCommand('/workspace', { model: 'gpt-5.6-terra', reasoningEffort: 'high', webSearch: true }), /^codex --search exec --json .*--model gpt-5\.6-terra --config model_reasoning_effort=high/);
});

test('leaves Codex model defaults untouched when no override is configured', () => {
  const args = getAgentExecutor('codex').buildArgs('prompt', '/workspace');
  assert.equal(args.includes('--model'), false);
  assert.equal(args.includes('--config'), false);
  assert.equal(args.includes('--search'), false);
});

test('passes the configured Claude model as an explicit CLI override', () => {
  const executor = getAgentExecutor('claude');
  const args = executor.buildArgs('prompt', '/workspace', { model: 'claude-sonnet-4-6' });
  assert.deepEqual(args, [
    '--print', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--no-session-persistence',
    '--model', 'claude-sonnet-4-6',
  ]);
  assert.match(executor.formatCommand('/workspace', { model: 'claude-sonnet-4-6' }), /--model claude-sonnet-4-6/);
  assert.equal(executor.buildArgs('prompt', '/workspace').includes('--model'), false);
  assert.equal(executor.buildArgs('prompt', '/workspace').includes('prompt'), false);
  assert.equal(executor.promptMode, 'stdin');
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
