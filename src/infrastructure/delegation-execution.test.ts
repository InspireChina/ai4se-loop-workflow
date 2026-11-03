import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { createLangfuseTelemetry, type LangfuseClient } from './langfuse';
import { buildAgentProcessLaunch, executeDelegation } from './delegation-execution';
import { getAgentExecutor, type AgentExecutor } from './agent-executor';

const credentials = { LANGFUSE_ENABLED: 'true', LANGFUSE_PUBLIC_KEY: 'pk-test', LANGFUSE_SECRET_KEY: 'sk-test', LANGFUSE_BASE_URL: 'https://langfuse.invalid', LANGFUSE_CAPTURE_PROMPTS: 'true' };
const context = { agent: 'dev-agent', taskId: 'TASK-4', storyIndex: 4, pipeline: 'resume' };

function fixtureExecutor(id: AgentExecutor['id'], program: string): AgentExecutor {
  return {
    id, label: 'Fixture', command: process.execPath, promptMode: 'argument',
    buildArgs: () => ['-e', program], formatCommand: () => 'node fixture',
    parseStdout: (line) => `stdout:${line}`, parseStderr: (line) => `stderr:${line}`,
  };
}





test('streams the complete OMP prompt through stdin without placing it in process arguments', async () => {
  const original = 'OMP must receive this complete prompt through stdin.\n'.repeat(4_000);
  const installedExecutor = getAgentExecutor('omp');
  const launch = buildAgentProcessLaunch(installedExecutor, original, '/workspace', { model: 'omp-sonnet-4-6' }, {});
  assert.equal(installedExecutor.promptMode, 'stdin');
  assert.equal(launch.args.some((argument) => argument.includes(original.slice(0, 200))), false);
  assert.ok(launch.args.join(' ').length < 2_000);

  const program = [
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", chunk => input += chunk);',
    "process.stdin.on(\"end\", () => console.log(JSON.stringify({type:\"message_end\",message:{role:\"assistant\",content:[{type:\"text\",text:input}]}})));",
  ].join('');
  const executor: AgentExecutor = {
    id: 'omp', label: 'OMP stdin fixture', command: process.execPath, promptMode: 'stdin',
    buildArgs: () => ['-e', program],
    formatCommand: () => 'node omp stdin fixture',
    parseStdout: () => null,
    parseStderr: () => null,
  };
  const { result } = await run(executor, recordedTelemetry().telemetry, { prompt: original });
  assert.equal(result.finalText, original);
});

test('injects execution-scoped context environment into the Agent process', async () => {
  const executor = fixtureExecutor('omp', "console.log(JSON.stringify({type:\"message_end\",message:{role:\"assistant\",content:[{type:\"text\",text:process.env.LOOP_EXECUTION_ID || \"missing\"}]}}))");
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



test('captures a CLI-submitted result independently from the Agent final message and cleans the channel', async () => {
  const program = [
    'const fs = require("node:fs");',
    'const resultPath = process.env.LOOP_AGENT_RESULT_PATH;',
    'const protocol = process.env.LOOP_AGENT_RESULT_PROTOCOL;',
    'const kind = process.env.LOOP_AGENT_RESULT_KIND;',
    'fs.writeFileSync(resultPath, JSON.stringify({protocol,kind,result:{outcome:"completed",summary:"tool receipt"}}));',
    "console.log(JSON.stringify({type:\"message_end\",message:{role:\"assistant\",content:[{type:\"text\",text:resultPath}]}}));",
  ].join('');

  const { result } = await run(fixtureExecutor('omp', program), recordedTelemetry().telemetry, { resultKind: 'flow' });

  assert.equal(result.exitCode, 0);
  assert.equal(result.submittedResult, JSON.stringify({ outcome: 'completed', summary: 'tool receipt' }));
  assert.equal(result.resultSubmissionError, null);
  assert.equal(existsSync(result.finalText), false);
});

test('records one safe delegation trace and normalized OMP events while preserving local logs', async () => {
  const fixtures: Array<[AgentExecutor['id'], string]> = [
    ['omp', 'console.log(JSON.stringify({type:"tool_execution_start",toolCallId:"c1",toolName:"bash",args:{command:"echo omp"}})); console.log(JSON.stringify({type:"tool_execution_end",toolCallId:"c1",toolName:"bash",result:{exitCode:0,stdout:"ok"},isError:false})); console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}]}}));'],
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
    "console.log(JSON.stringify({type:\"tool_execution_start\",toolName:\"bash\",toolCallId:\"call-1\",args:{command:\"npm test\"},}));",
    'console.log("provider diagnostic fixture");',
    "console.log(JSON.stringify({type:\"tool_execution_end\",toolName:\"bash\",toolCallId:\"call-1\",args:{command:\"npm test\"},result:{exitCode:0,stdout:\"passed\"},isError:(0)!==0}));",
    "console.log(JSON.stringify({type:\"message_end\",message:{role:\"assistant\",content:[{type:\"text\",text:\"done\"}]}}));",
  ].join('');

  const { result, logs } = await run(fixtureExecutor('omp', program), record.telemetry, {
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
    { name: 'non-zero', executor: fixtureExecutor('omp', 'process.exit(7)'), expected: 'failed' },
    { name: 'spawn error', executor: { ...fixtureExecutor('omp', ''), command: '/definitely/missing-loop-fixture' }, expected: 'execution_error' },
    { name: 'timeout', executor: fixtureExecutor('omp', 'setInterval(() => {}, 1000)'), expected: 'timed_out' },
    { name: 'signal', executor: fixtureExecutor('omp', 'process.kill(process.pid, "SIGTERM")'), expected: 'cancelled' },
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
    'omp',
    `console.error("Authorization: Bearer ${secret}"); console.error("provider unavailable"); process.exit(7)`,
  ));

  assert.equal(result.exitCode, 7);
  assert.match(result.stderrTail || '', /Authorization: \[REDACTED\]/);
  assert.match(result.stderrTail || '', /provider unavailable/);
  assert.doesNotMatch(result.stderrTail || '', new RegExp(secret));
  assert.match(result.failureDetail || '', /provider unavailable/);
  assert.doesNotMatch(result.failureDetail || '', new RegExp(secret));
});

test('captures a OMP stream-json error from stdout for exact failure activity', async () => {
  const secret = 'private-omp-token';
  const installed = getAgentExecutor('omp');
  const executor: AgentExecutor = {
    ...installed,
    transport: undefined,
    command: process.execPath,
    promptMode: 'argument',
    buildArgs: () => ['-e', [
      `console.log(JSON.stringify({type:"error",message:"model overloaded token=${secret}"}));`,
      'process.exit(1);',
    ].join('')],
    formatCommand: () => 'omp fixture',
  };
  const { result } = await run(executor);

  assert.equal(result.exitCode, 1);
  assert.match(result.failureDetail || '', /model overloaded/);
  assert.doesNotMatch(result.failureDetail || '', new RegExp(secret));
  assert.equal(result.stderrTail, undefined);
});

test('terminates a CLI that produces no startup output and preserves the exact timeout reason', async () => {
  const { result, logs } = await run(
    fixtureExecutor('omp', 'setInterval(() => {}, 1000)'),
    recordedTelemetry().telemetry,
    { maxRuntimeMs: 1_000, startupTimeoutMs: 25, idleTimeoutMs: 500 },
  );

  assert.notEqual(result.exitCode, 0);
  assert.equal(result.terminationReason, '启动后 1 秒内没有任何输出');
  assert.ok(logs.some((line) => line.includes('启动后 1 秒内没有任何输出')));
});

test('switches from startup timeout to idle timeout after the first process output', async () => {
  const { result, logs } = await run(
    fixtureExecutor('omp', 'console.log("started"); setInterval(() => {}, 1000)'),
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
    fixtureExecutor('omp', 'setInterval(() => {}, 1000)'),
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
    fixtureExecutor('omp', 'setInterval(() => {}, 1000)'),
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

test('reclaims a lingering CLI after durable Workflow submission without classifying it as cancellation or failure', async () => {
  let reads = 0;
  const { result, logs } = await run(
    fixtureExecutor('omp', 'console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"I am finished"}]}}));setInterval(() => {}, 1000)'),
    recordedTelemetry().telemetry,
    {
      maxRuntimeMs: 5_000,
      idleTimeoutMs: 5_000,
      completionRequested: () => {
        reads += 1;
        if (reads === 1) throw new Error('Transient read failure is not a submission');
        return true;
      },
    },
  );
  assert.equal(reads, 2);
  assert.equal(result.completionDetected, true);
  assert.equal(result.cancelled, undefined);
  assert.equal(result.finalText, 'I am finished');
  assert.ok(logs.some(line => line.includes('领域终止结果已持久化')));
  assert.ok(!logs.some(line => line.includes('执行失败') || line.includes('已取消 lane=')));
});

test('telemetry initialization, event/update, network, and bounded flush failures cannot block the CLI or leak secrets', async () => {
  const diagnostics: string[] = [];
  const telemetry = createLangfuseTelemetry({
    env: credentials,
    timeoutMs: 5,
    diagnostic: (code) => diagnostics.push(code),
    createClient: () => ({ trace: () => ({ event: () => { throw new Error('network failed'); }, update: () => { throw new Error('update failed'); } }), flushAsync: async () => new Promise(() => {}) }),
  });
  const { result, logs } = await run(fixtureExecutor('omp', "console.log(JSON.stringify({type:\"message_end\",message:{role:\"assistant\",content:[{type:\"text\",text:\"done\"}]}}))"), telemetry);
  assert.deepEqual(result, { exitCode: 0, finalText: 'done' });
  assert.ok(logs.some((line) => line.includes('处理完成')));
  assert.ok(diagnostics.includes('client-operation-failed'));
  assert.ok(diagnostics.includes('client-timeout'));

  const record = recordedTelemetry();
  await run(fixtureExecutor('omp', "console.log(JSON.stringify({type:\"message_end\",message:{role:\"assistant\",content:[{type:\"text\",text:\"done\"}]}}))"), record.telemetry);
  assert.doesNotMatch(JSON.stringify({ traces: record.traces, events: record.events, agentSpans: record.agentSpans, toolSpans: record.toolSpans, agentEnds: record.agentEnds, toolEnds: record.toolEnds, updates: record.updates }), /definitely-not-a-real-secret/);

  const disabled = createLangfuseTelemetry({ env: {} });
  const disabledResult = await run(fixtureExecutor('omp', 'process.exit(0)'), disabled);
  assert.equal(disabledResult.result.exitCode, 0);
  const unsampled = createLangfuseTelemetry({ env: { ...credentials, LANGFUSE_SAMPLE_RATE: '0' } });
  const unsampledResult = await run(fixtureExecutor('omp', 'process.exit(0)'), unsampled);
  assert.equal(unsampledResult.result.exitCode, 0);

  const initFailure = createLangfuseTelemetry({ env: credentials, createClient: () => { throw new Error('bad credentials'); } });
  assert.equal((await run(fixtureExecutor('omp', 'process.exit(0)'), initFailure)).result.exitCode, 0);
  const traceFailure = createLangfuseTelemetry({ env: credentials, createClient: () => ({ trace: () => { throw new Error('network unavailable'); } }) });
  assert.equal((await run(fixtureExecutor('omp', 'process.exit(0)'), traceFailure)).result.exitCode, 0);
});
