import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createLangfuseTelemetry, type LangfuseClient } from './langfuse';
import { buildAgentProcessLaunch, createTemporaryPrompt, executeDelegation, removeTemporaryPrompt } from './delegation-execution';
import type { AgentExecutor } from './agent-executor';

const credentials = { LANGFUSE_ENABLED: 'true', LANGFUSE_PUBLIC_KEY: 'pk-test', LANGFUSE_SECRET_KEY: 'sk-test', LANGFUSE_BASE_URL: 'https://langfuse.invalid', LANGFUSE_CAPTURE_PROMPTS: 'true' };
const context = { agent: 'dev-agent', taskId: 'TASK-4', storyIndex: 4, pipeline: 'resume' };

function fixtureExecutor(id: AgentExecutor['id'], program: string): AgentExecutor {
  return {
    id, label: 'Fixture', command: process.execPath, promptMode: 'argument',
    buildArgs: () => ['-e', program], formatCommand: () => 'node fixture',
    parseStdout: (line) => `stdout:${line}`, parseStderr: (line) => `stderr:${line}`,
  };
}

test('prepends executor launch arguments and merges executor environment', () => {
  const executor: AgentExecutor = {
    id: 'cursor', label: 'Cursor fixture', command: 'node.exe', promptMode: 'argument',
    prefixArgs: ['index.js'],
    env: { CURSOR_INVOKED_AS: 'cursor-agent', NODE_COMPILE_CACHE: 'C:\\cache' },
    buildArgs: (prompt) => ['--print', prompt],
    formatCommand: () => 'cursor-agent via=node',
    parseStdout: () => null,
    parseStderr: () => null,
  };
  const launch = buildAgentProcessLaunch(executor, 'a'.repeat(15_000), 'C:\\workspace', {}, { PATH: 'fixture-path' });

  assert.equal(launch.command, 'node.exe');
  assert.equal(launch.args[0], 'index.js');
  assert.equal(launch.args.at(-1)?.length, 15_000);
  assert.deepEqual(launch.env, { PATH: 'fixture-path', CURSOR_INVOKED_AS: 'cursor-agent', NODE_COMPILE_CACHE: 'C:\\cache' });
});

test('stores long prompts in a private temporary file and passes only a short reference', () => {
  const original = '完整任务上下文\n'.repeat(4_000);
  const temporary = createTemporaryPrompt(original);
  try {
    assert.equal(readFileSync(temporary.file, 'utf8'), original);
    assert.match(temporary.reference, /必须先使用文件读取工具完整读取/);
    assert.match(temporary.reference, /PROMPT_FILE=/);
    assert.ok(temporary.reference.length < 1_000, `reference length=${temporary.reference.length}`);
    assert.equal(temporary.reference.includes(original.slice(0, 100)), false);
  } finally {
    removeTemporaryPrompt(temporary);
  }
  assert.equal(existsSync(temporary.directory), false);
});

function recordedTelemetry() {
  const traces: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const agentSpans: Array<Record<string, unknown>> = [];
  const toolSpans: Array<Record<string, unknown>> = [];
  const agentEnds: Array<Record<string, unknown>> = [];
  const toolEnds: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  let flushes = 0;
  const client: LangfuseClient = {
    trace: (attributes) => {
      traces.push(attributes);
      return {
        update: (attributes) => { updates.push(attributes); },
        span: (attributes) => {
          agentSpans.push(attributes);
          return {
            event: (event) => { events.push(event); },
            span: (tool) => {
              toolSpans.push(tool);
              return { end: (end) => { toolEnds.push(end ?? {}); } };
            },
            end: (end) => { agentEnds.push(end ?? {}); },
          };
        },
      };
    },
    flushAsync: async () => { flushes += 1; },
  };
  return { traces, events, agentSpans, toolSpans, agentEnds, toolEnds, updates, get flushes() { return flushes; }, telemetry: createLangfuseTelemetry({ env: credentials, createClient: () => client }) };
}

async function run(executor: AgentExecutor, telemetry = recordedTelemetry().telemetry, overrides: Partial<Parameters<typeof executeDelegation>[0]> = {}) {
  const logs: string[] = [];
  const result = await executeDelegation({
    runId: 'run-story-4', prompt: 'Authorization: Bearer definitely-not-a-real-secret', workspaceRoot: process.cwd(), executor,
    executionOptions: {}, context, description: 'offline fixture', telemetry, appendLog: async (message) => { logs.push(message); },
    maxRuntimeMs: 1_000, idleTimeoutMs: 1_000, ...overrides,
  });
  return { result, logs };
}

test('uses and cleans a prompt file during file-reference execution', async () => {
  let referencedFile = '';
  const program = [
    'const fs = require("node:fs");',
    'const match = process.argv[1].match(/^PROMPT_FILE=(.+)$/m);',
    'const file = JSON.parse(match[1]);',
    'const text = fs.readFileSync(file, "utf8");',
    'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));',
  ].join('');
  const executor: AgentExecutor = {
    id: 'codex', label: 'File prompt fixture', command: process.execPath, promptMode: 'file-reference',
    buildArgs: (reference) => {
      referencedFile = JSON.parse(reference.match(/^PROMPT_FILE=(.+)$/m)![1]);
      return ['-e', program, reference];
    },
    formatCommand: () => 'node file fixture',
    parseStdout: () => null,
    parseStderr: () => null,
  };
  const original = '需要从临时文件读取的完整 Prompt '.repeat(1_000);

  const { result } = await run(executor, recordedTelemetry().telemetry, { prompt: original });

  assert.equal(result.finalText, original);
  assert.ok(referencedFile);
  assert.equal(existsSync(referencedFile), false);
});

test('records one safe delegation trace and normalized Cursor, Codex, and Claude events while preserving local logs', async () => {
  const fixtures: Array<[AgentExecutor['id'], string]> = [
    ['cursor', 'console.log(JSON.stringify({type:"tool_call",subtype:"started",call_id:"c1",tool_call:{ShellToolCall:{args:{command:"echo cursor"}}}})); console.log(JSON.stringify({type:"tool_call",subtype:"completed",call_id:"c1",tool_call:{ShellToolCall:{result:{success:{exitCode:0,stdout:"ok"}}}}})); console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"done"}]}})); console.log(JSON.stringify({type:"result",result:"earlier done"}));'],
    ['codex', 'console.log(JSON.stringify({type:"item.started",item:{id:"c1",type:"command_execution",command:"echo codex"}})); console.log(JSON.stringify({type:"item.completed",item:{id:"c1",type:"command_execution",command:"echo codex",exit_code:0,aggregated_output:"ok"}})); console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}));'],
    ['claude', 'console.log(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",id:"c1",name:"Bash",input:{command:"echo claude"}}]}})); console.log(JSON.stringify({type:"user",message:{content:[{type:"tool_result",tool_use_id:"c1",content:"ok"}]}})); console.log(JSON.stringify({type:"result",result:"done"}));'],
  ];
  for (const [id, program] of fixtures) {
    const record = recordedTelemetry();
    const { result, logs } = await run(fixtureExecutor(id, program), record.telemetry);
    assert.deepEqual(result, { exitCode: 0, finalText: 'done' });
    assert.equal(record.traces.length, 1);
    assert.deepEqual(record.traces[0].metadata, { runToken: 'run-story-4', requirementId: 'TASK-4', deliveryUnitIndex: 4, flow: 'resume', agent: 'dev-agent', operation: 'resume', node: 'dev-agent', executor: id, configuredModel: null, reasoningEffort: null, usageAvailable: false, promptCaptured: true, promptLength: 50 });
    assert.equal(record.traces[0].name, 'loop.resume');
    assert.equal(record.agentSpans[0].name, 'agent.dev-agent');
    assert.equal(record.toolSpans.length, 1);
    assert.match(String(record.toolSpans[0].name), /^tool\./);
    assert.equal(record.toolEnds.length, 1);
    assert.equal(record.agentEnds.length, 1);
    assert.equal(record.agentEnds[0].output, 'done');
    assert.deepEqual(record.updates.at(-1), { output: 'done', metadata: { executionStatus: 'completed' } });
    assert.equal(record.flushes, 1);
    assert.ok(logs.some((line) => line.startsWith('stdout:')));
  }
});

test('maps non-zero, spawn error, timeout, and signal exits without telemetry affecting local execution', async () => {
  const cases: Array<{ name: string; executor: AgentExecutor; expected: string }> = [
    { name: 'non-zero', executor: fixtureExecutor('codex', 'process.exit(7)'), expected: 'failed' },
    { name: 'spawn error', executor: { ...fixtureExecutor('codex', ''), command: '/definitely/missing-loop-fixture' }, expected: 'execution_error' },
    { name: 'timeout', executor: fixtureExecutor('codex', 'setInterval(() => {}, 1000)'), expected: 'timed_out' },
    { name: 'signal', executor: fixtureExecutor('codex', 'process.kill(process.pid, "SIGTERM")'), expected: 'cancelled' },
  ];
  for (const item of cases) {
    const record = recordedTelemetry();
    const { result, logs } = await run(item.executor, record.telemetry, item.name === 'timeout' ? { maxRuntimeMs: 25, idleTimeoutMs: 500 } : {});
    assert.notEqual(result.exitCode, 0, item.name);
    assert.deepEqual(record.updates.at(-1), { output: { exitCode: item.name === 'non-zero' ? 7 : null, timedOut: item.name === 'timeout' }, metadata: { executionStatus: item.expected } }, item.name);
    assert.ok(logs.length > 0, item.name);
  }
});

test('telemetry initialization, event/update, network, and bounded flush failures cannot block the CLI or leak secrets', async () => {
  const diagnostics: string[] = [];
  const telemetry = createLangfuseTelemetry({
    env: credentials,
    timeoutMs: 5,
    diagnostic: (code) => diagnostics.push(code),
    createClient: () => ({ trace: () => ({ event: () => { throw new Error('network failed'); }, update: () => { throw new Error('update failed'); } }), flushAsync: async () => new Promise(() => {}) }),
  });
  const { result, logs } = await run(fixtureExecutor('codex', 'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}))'), telemetry);
  assert.deepEqual(result, { exitCode: 0, finalText: 'done' });
  assert.ok(logs.some((line) => line.includes('处理完成')));
  assert.ok(diagnostics.includes('client-operation-failed'));
  assert.ok(diagnostics.includes('client-timeout'));

  const record = recordedTelemetry();
  await run(fixtureExecutor('codex', 'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}))'), record.telemetry);
  assert.doesNotMatch(JSON.stringify({ traces: record.traces, events: record.events, agentSpans: record.agentSpans, toolSpans: record.toolSpans, agentEnds: record.agentEnds, toolEnds: record.toolEnds, updates: record.updates }), /definitely-not-a-real-secret/);

  const disabled = createLangfuseTelemetry({ env: {} });
  const disabledResult = await run(fixtureExecutor('codex', 'process.exit(0)'), disabled);
  assert.equal(disabledResult.result.exitCode, 0);
  const unsampled = createLangfuseTelemetry({ env: { ...credentials, LANGFUSE_SAMPLE_RATE: '0' } });
  const unsampledResult = await run(fixtureExecutor('codex', 'process.exit(0)'), unsampled);
  assert.equal(unsampledResult.result.exitCode, 0);

  const initFailure = createLangfuseTelemetry({ env: credentials, createClient: () => { throw new Error('bad credentials'); } });
  assert.equal((await run(fixtureExecutor('codex', 'process.exit(0)'), initFailure)).result.exitCode, 0);
  const traceFailure = createLangfuseTelemetry({ env: credentials, createClient: () => ({ trace: () => { throw new Error('network unavailable'); } }) });
  assert.equal((await run(fixtureExecutor('codex', 'process.exit(0)'), traceFailure)).result.exitCode, 0);
});
