import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createLangfuseTelemetry, type LangfuseClient } from './langfuse';
import { buildAgentProcessLaunch, createTemporaryPrompt, executeDelegation, removeTemporaryPrompt } from './delegation-execution';
import { getAgentExecutor, type AgentExecutor } from './agent-executor';
import { markManagedAgentProcessExited } from './managed-process-registry';
import { terminateProcessTree } from './process-tree';

const credentials = { LANGFUSE_ENABLED: 'true', LANGFUSE_PUBLIC_KEY: 'pk-test', LANGFUSE_SECRET_KEY: 'sk-test', LANGFUSE_BASE_URL: 'https://langfuse.invalid', LANGFUSE_CAPTURE_PROMPTS: 'true' };
const context = { agent: 'dev-agent', taskId: 'TASK-4', storyIndex: 4, pipeline: 'resume' };

function fixtureExecutor(id: AgentExecutor['id'], program: string): AgentExecutor {
  return {
    id, label: 'Fixture', command: process.execPath, promptMode: 'argument',
    buildArgs: () => ['-e', program], formatCommand: () => 'node fixture',
    parseStdout: (line) => `stdout:${line}`, parseStderr: (line) => `stderr:${line}`,
  };
}

test('a permanently hung log sink cannot block startup, physical termination or execution settlement', async () => {
  let cliPid = 0;
  const started = Date.now();
  const result = await executeDelegation({
    runId: 'hung-log-fixture', workspaceRoot: process.cwd(), prompt: 'fixture',
    executor: fixtureExecutor('claude', 'setInterval(() => {}, 1000)'), executionOptions: {}, context,
    description: 'Hung logging', telemetry: createLangfuseTelemetry({ env: { LANGFUSE_ENABLED: 'false' } }),
    appendLog: () => new Promise(() => undefined), persistenceTimeoutMs: 15,
    maxRuntimeMs: 2000, startupTimeoutMs: 80, idleTimeoutMs: 2000,
    processes: {
      register: async (_run, pid) => { cliPid = pid; return 'fixture-marker'; },
      terminate: (pid, timeout) => terminateProcessTree(pid, timeout), markExited: async () => undefined,
    },
  });
  assert.match(result.terminationReason || '', /没有任何输出/);
  assert.match(result.logPersistenceError || '', /timeout/);
  assert.ok(Date.now() - started < 2000);
  assert.throws(() => process.kill(cliPid, 0));
});

test('hung durable evidence returns an explicit persistence failure without hanging completed CLI settlement', async () => {
  let calls = 0;
  const result = await executeDelegation({
    runId: 'hung-evidence-fixture', workspaceRoot: process.cwd(), prompt: 'fixture',
    executor: fixtureExecutor('codex', 'for(let i=0;i<100;i++) console.log(JSON.stringify({type:"item.completed",item:{id:"call-"+i,type:"command_execution",command:"fixture",exit_code:0,aggregated_output:"done"}}))'), executionOptions: {}, context,
    description: 'Hung evidence', telemetry: createLangfuseTelemetry({ env: { LANGFUSE_ENABLED: 'false' } }),
    appendLog: async () => undefined, recordTelemetryEvent: () => { calls++; return new Promise(() => undefined); }, persistenceTimeoutMs: 15,
    maxRuntimeMs: 2000, startupTimeoutMs: 500, idleTimeoutMs: 1000,
    processes: { register: async () => 'fixture-marker', terminate: (pid, timeout) => terminateProcessTree(pid, timeout), markExited: async () => undefined },
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.evidencePersistenceError || '', /timeout/);
  assert.equal(calls, 1, 'a hung evidence sink must not multiply settlement wait by the number of tool events');
});

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

test('streams the complete Claude prompt through stdin without placing it in process arguments', async () => {
  const original = 'Claude must receive this complete prompt through stdin.\n'.repeat(4_000);
  const installedExecutor = getAgentExecutor('claude');
  const launch = buildAgentProcessLaunch(installedExecutor, original, '/workspace', { model: 'claude-sonnet-4-6' }, {});
  assert.equal(installedExecutor.promptMode, 'stdin');
  assert.equal(launch.args.some((argument) => argument.includes(original.slice(0, 200))), false);
  assert.ok(launch.args.join(' ').length < 2_000);

  const program = [
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", chunk => input += chunk);',
    'process.stdin.on("end", () => console.log(JSON.stringify({type:"result",result:input})));',
  ].join('');
  const executor: AgentExecutor = {
    id: 'claude', label: 'Claude stdin fixture', command: process.execPath, promptMode: 'stdin',
    buildArgs: () => ['-e', program],
    formatCommand: () => 'node claude stdin fixture',
    parseStdout: () => null,
    parseStderr: () => null,
  };
  const { result } = await run(executor, recordedTelemetry().telemetry, { prompt: original });
  assert.equal(result.finalText, original);
});

test('injects execution-scoped context environment into the Agent process', async () => {
  const executor = fixtureExecutor('codex', 'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:process.env.LOOP_EXECUTION_ID || "missing"}}))');
  const { result } = await run(executor, recordedTelemetry().telemetry, {
    environment: { LOOP_EXECUTION_ID: 'EXEC-context-fixture' },
  });
  assert.equal(result.finalText, 'EXEC-context-fixture');
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
    maxRuntimeMs: 1_000, startupTimeoutMs: 1_000, idleTimeoutMs: 1_000, ...overrides,
  });
  return { result, logs };
}

for (const timeoutKind of ['startup', 'idle', 'maximum'] as const) {
  test(`${timeoutKind} timeout still terminates the real CLI when termination logging rejects`, { timeout: 15_000 }, async () => {
    const limits = { startupTimeoutMs: 2_000, idleTimeoutMs: 2_000, maxRuntimeMs: 2_000 };
    if (timeoutKind === 'startup') limits.startupTimeoutMs = 80;
    if (timeoutKind === 'idle') limits.idleTimeoutMs = 80;
    if (timeoutKind === 'maximum') limits.maxRuntimeMs = 80;
    const program = `${timeoutKind === 'idle' ? 'console.log("ready");' : ''}setInterval(() => {}, 1000);`;
    let pid = 0;
    try {
      const { result } = await run(fixtureExecutor('codex', program), recordedTelemetry().telemetry, {
        ...limits,
        processes: {
          register: async (_runId, childPid) => { pid = childPid; return `test-${childPid}`; },
          markExited: markManagedAgentProcessExited,
          terminate: terminateProcessTree,
        },
        appendLog: async (message) => {
          if (message.includes('正在终止')) throw new Error('injected log store failure');
        },
      });
      assert.ok(result.terminationReason);
      assert.notEqual(result.exitCode, 0);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
    }
  });
}

test('signal exit during identity registration is observed and the final stderr chunk is preserved', { timeout: 5_000 }, async () => {
  const { result } = await run(fixtureExecutor('codex', 'process.stderr.write("final diagnostic without newline");process.kill(process.pid,"SIGTERM");'), recordedTelemetry().telemetry, {
    processes: {
      register: async (_runId, pid) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return `test-${pid}`;
      },
      markExited: markManagedAgentProcessExited,
      terminate: terminateProcessTree,
    },
  });
  assert.equal(result.signal, 'SIGTERM');
  assert.match(result.failureDetail || '', /final diagnostic without newline/);
});

test('duplicate cancellation signals terminate once and process cleanup precedes managed exit settlement', { timeout: 5_000 }, async () => {
  const cancellation = new AbortController();
  const sequence: string[] = [];
  const { result } = await run(fixtureExecutor('codex', 'setInterval(() => {},1000)'), recordedTelemetry().telemetry, {
    cancellationSignal: cancellation.signal,
    processes: {
      register: async (_runId, pid) => {
        cancellation.abort();
        cancellation.abort();
        return `test-${pid}`;
      },
      terminate: async (pid, timeoutMs, marker) => {
        sequence.push('terminate');
        const stopped = await terminateProcessTree(pid, timeoutMs, marker);
        await new Promise((resolve) => setTimeout(resolve, 30));
        sequence.push('tree-exited');
        return stopped;
      },
      markExited: async () => { sequence.push('settled'); },
    },
  });
  assert.equal(result.cancelled, true);
  assert.deepEqual(sequence, ['terminate', 'tree-exited', 'settled']);
});

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

test('captures a CLI-submitted result independently from the Agent final message and cleans the channel', async () => {
  const program = [
    'const fs = require("node:fs");',
    'const resultPath = process.env.LOOP_AGENT_RESULT_PATH;',
    'const protocol = process.env.LOOP_AGENT_RESULT_PROTOCOL;',
    'const kind = process.env.LOOP_AGENT_RESULT_KIND;',
    'fs.writeFileSync(resultPath, JSON.stringify({protocol,kind,result:{outcome:"completed",summary:"tool receipt"}}));',
    'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:resultPath}}));',
  ].join('');

  const { result } = await run(fixtureExecutor('codex', program), recordedTelemetry().telemetry, { resultKind: 'flow' });

  assert.equal(result.exitCode, 0);
  assert.equal(result.submittedResult, JSON.stringify({ outcome: 'completed', summary: 'tool receipt' }));
  assert.equal(result.resultSubmissionError, null);
  assert.equal(existsSync(result.finalText), false);
});

test('a durable result submission physically stops an Agent that keeps working after its terminal command', { timeout: 10_000 }, async () => {
  const completedEvents: Array<Record<string, unknown>> = [];
  const program = [
    'const fs = require("node:fs");',
    'const resultPath = process.env.LOOP_AGENT_RESULT_PATH;',
    'const protocol = process.env.LOOP_AGENT_RESULT_PROTOCOL;',
    'const kind = process.env.LOOP_AGENT_RESULT_KIND;',
    'fs.writeFileSync(resultPath, JSON.stringify({protocol,kind,result:{outcome:"completed",summary:"terminal receipt"}}));',
    'console.log(JSON.stringify({type:"tool_call",subtype:"completed",call_id:"terminal",tool_call:{ShellToolCall:{result:{success:{exitCode:0,stdout:"submitted"}}}}}));',
    'setInterval(() => console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"still working"}]}})), 20);',
  ].join('');
  const started = Date.now();

  const { result } = await run(fixtureExecutor('cursor', program), recordedTelemetry().telemetry, {
    resultKind: 'flow',
    maxRuntimeMs: 8_000,
    startupTimeoutMs: 2_000,
    idleTimeoutMs: 8_000,
    recordTelemetryEvent: async (event) => { if (event.phase === 'completed') completedEvents.push(event); },
  });

  assert.ok(Date.now() - started < 3_000, 'terminal submission must not wait for the Agent runtime limit');
  assert.equal(result.terminationKind, 'submitted');
  assert.match(result.terminationReason || '', /结构化结果/);
  assert.equal(result.submittedResult, JSON.stringify({ outcome: 'completed', summary: 'terminal receipt' }));
  assert.equal(completedEvents.length, 1, 'the terminal tool completion remains durable before shutdown');
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

test('reports durable evidence failures without suppressing later telemetry or CLI output', async () => {
  const record = recordedTelemetry();
  const persisted: Array<Record<string, unknown>> = [];
  const program = [
    'console.log(JSON.stringify({type:"item.started",item:{id:"call-1",type:"command_execution",command:"npm test"}}));',
    'console.log("provider diagnostic fixture");',
    'console.log(JSON.stringify({type:"item.completed",item:{id:"call-1",type:"command_execution",command:"npm test",exit_code:0,aggregated_output:"passed"}}));',
    'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}));',
  ].join('');

  const { result, logs } = await run(fixtureExecutor('codex', program), record.telemetry, {
    recordTelemetryEvent: async (event) => {
      persisted.push(event);
      if (event.sequence === 1) throw new Error('injected receipt failure');
    },
  });

  assert.deepEqual(result, {
    exitCode: 0,
    finalText: 'done',
    evidencePersistenceError: 'injected receipt failure',
  });
  assert.deepEqual(persisted.map((event) => event.sequence), [1, 2, 3]);
  assert.deepEqual(persisted.map((event) => event.name), ['loop.agent.tool', 'loop.agent.diagnostic', 'loop.agent.tool']);
  assert.deepEqual(persisted.map((event) => event.phase), ['started', undefined, 'completed']);
  assert.ok(logs.some((line) => line.includes('本地执行证据写入失败')));
  assert.equal(record.toolSpans.length, 1, 'receipt failure must not suppress Langfuse start');
  assert.equal(record.toolEnds.length, 1, 'receipt failure must not suppress Langfuse completion');
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

test('returns a bounded redacted stderr tail for exact failure activity', async () => {
  const secret = 'definitely-private-bearer-value';
  const { result } = await run(fixtureExecutor(
    'claude',
    `console.error("Authorization: Bearer ${secret}"); console.error("provider unavailable"); process.exit(7)`,
  ));

  assert.equal(result.exitCode, 7);
  assert.match(result.stderrTail || '', /Authorization: \[REDACTED\]/);
  assert.match(result.stderrTail || '', /provider unavailable/);
  assert.doesNotMatch(result.stderrTail || '', new RegExp(secret));
  assert.match(result.failureDetail || '', /provider unavailable/);
  assert.doesNotMatch(result.failureDetail || '', new RegExp(secret));
});

test('captures a Claude stream-json error from stdout for exact failure activity', async () => {
  const secret = 'private-claude-token';
  const installed = getAgentExecutor('claude');
  const executor: AgentExecutor = {
    ...installed,
    command: process.execPath,
    promptMode: 'argument',
    buildArgs: () => ['-e', [
      `console.log(JSON.stringify({type:"result",is_error:true,result:"model overloaded token=${secret}"}));`,
      'process.exit(1);',
    ].join('')],
    formatCommand: () => 'claude fixture',
  };
  const { result } = await run(executor);

  assert.equal(result.exitCode, 1);
  assert.match(result.failureDetail || '', /model overloaded/);
  assert.doesNotMatch(result.failureDetail || '', new RegExp(secret));
  assert.equal(result.stderrTail, undefined);
});

test('terminates a CLI that produces no startup output and preserves the exact timeout reason', async () => {
  const { result, logs } = await run(
    fixtureExecutor('claude', 'setInterval(() => {}, 1000)'),
    recordedTelemetry().telemetry,
    { maxRuntimeMs: 1_000, startupTimeoutMs: 25, idleTimeoutMs: 500 },
  );

  assert.notEqual(result.exitCode, 0);
  assert.equal(result.terminationReason, '启动后 1 秒内没有任何输出');
  assert.ok(logs.some((line) => line.includes('启动后 1 秒内没有任何输出')));
});

test('switches from startup timeout to idle timeout after the first process output', async () => {
  const { result, logs } = await run(
    fixtureExecutor('claude', 'console.log("started"); setInterval(() => {}, 1000)'),
    recordedTelemetry().telemetry,
    { maxRuntimeMs: 1_000, startupTimeoutMs: 500, idleTimeoutMs: 50 },
  );

  assert.notEqual(result.exitCode, 0);
  assert.equal(result.terminationReason, '超过空闲时间 1 秒');
  assert.ok(logs.some((line) => line.includes('stdout:started')));
  assert.ok(logs.some((line) => line.includes('超过空闲时间 1 秒')));
});

test('terminates the CLI when its requirement is cancelled', async () => {
  let checks = 0;
  const { result, logs } = await run(
    fixtureExecutor('codex', 'setInterval(() => {}, 1000)'),
    recordedTelemetry().telemetry,
    {
      maxRuntimeMs: 5_000,
      idleTimeoutMs: 5_000,
      cancellationRequested: () => {
        checks += 1;
        return checks >= 2;
      },
    },
  );

  assert.equal(result.cancelled, true);
  assert.notEqual(result.exitCode, 0);
  assert.ok(logs.some((line) => line.includes('需求已取消')));
  assert.ok(logs.some((line) => line.includes('已取消 lane=')));
});

test('terminates the CLI immediately when the Runner cancellation signal is aborted', async () => {
  const cancellation = new AbortController();
  const startedAt = Date.now();
  const execution = run(
    fixtureExecutor('codex', 'setInterval(() => {}, 1000)'),
    recordedTelemetry().telemetry,
    {
      maxRuntimeMs: 5_000,
      idleTimeoutMs: 5_000,
      cancellationSignal: cancellation.signal,
      cancellationRequested: () => false,
    },
  );
  setTimeout(() => cancellation.abort(), 25);

  const { result, logs } = await execution;

  assert.equal(result.cancelled, true);
  assert.notEqual(result.exitCode, 0);
  assert.ok(Date.now() - startedAt < 1_000, 'AbortSignal cancellation should not wait for the legacy polling interval');
  assert.ok(logs.some((line) => line.includes('需求已取消')));
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
