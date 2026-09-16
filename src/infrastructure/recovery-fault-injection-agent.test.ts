import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const wrapper = join(process.cwd(), 'scripts', 'recovery-fault-injection-agent.mjs');
const ack = 'I_UNDERSTAND_THIS_IS_RECOVERY_TEST_ONLY';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'loopwork-recovery-fault-'));
  const real = join(root, 'real-agent.mjs');
  const capture = join(root, 'capture.json');
  const result = join(root, 'result.json');
  writeFileSync(real, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';
writeFileSync(process.env.CAPTURE,JSON.stringify(process.argv.slice(2)));
if(process.env.NO_SUBMIT!=='1')writeFileSync(process.env.LOOP_AGENT_RESULT_PATH,JSON.stringify({protocol:process.env.LOOP_AGENT_RESULT_PROTOCOL,kind:process.env.LOOP_AGENT_RESULT_KIND,result:{outcome:'completed',summary:'fixture'}}));
process.exit(Number(process.env.EXIT_CODE||0));\n`, { mode: 0o700 });
  chmodSync(real, 0o700);
  return { root, real, capture, result, state: join(root, 'state.json') };
}

function run(input: ReturnType<typeof fixture>, executionId: string, extra: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [wrapper, '--print', 'original prompt'], { encoding: 'utf8', env: {
    ...process.env,
    LOOP_RECOVERY_FAULT_ACK: ack,
    LOOP_RECOVERY_FAULT_MODE: 'dev-missing',
    LOOP_RECOVERY_FAULT_STATE: input.state,
    LOOP_RECOVERY_REAL_CLI: input.real,
    LOOP_RECOVERY_FAULT_LIMIT: '2',
    LOOP_EXECUTION_ID: executionId,
    LOOP_AGENT_RESULT_AGENT: 'dev-agent',
    LOOP_AGENT_RESULT_PATH: input.result,
    LOOP_AGENT_RESULT_PROTOCOL: 'loop-agent-result/v1',
    LOOP_AGENT_RESULT_KIND: 'flow',
    CAPTURE: input.capture,
    ...extra,
  } });
}

test('real-agent fault injection is explicit, deterministic per execution and bounded', () => {
  const input = fixture();
  assert.equal(run(input, 'execution-a').status, 0);
  assert.match(JSON.parse(readFileSync(input.capture, 'utf8')).at(-1), /CONTROLLED RECOVERY FAULT INJECTION/);
  assert.equal(run(input, 'execution-a').status, 0, 'the same execution must retain the same injected behavior');
  assert.match(JSON.parse(readFileSync(input.capture, 'utf8')).at(-1), /Simulate false completion/);
  assert.equal(run(input, 'execution-b').status, 0);
  assert.match(JSON.parse(readFileSync(input.capture, 'utf8')).at(-1), /Simulate false completion/);
  assert.equal(run(input, 'execution-c').status, 0);
  assert.equal(JSON.parse(readFileSync(input.capture, 'utf8')).at(-1), 'original prompt');
  assert.deepEqual(JSON.parse(readFileSync(input.state, 'utf8')), {
    'dev-missing': { 'dev-agent': ['execution-a', 'execution-b'] },
  });
});

test('a transport failure before result submission atomically refunds the injection budget', () => {
  const input = fixture();
  const failed = run(input, 'network-failed', { NO_SUBMIT: '1', EXIT_CODE: '1' });
  assert.equal(failed.status, 1);
  assert.deepEqual(JSON.parse(readFileSync(input.state, 'utf8')), { 'dev-missing': { 'dev-agent': [] } });
  assert.equal(run(input, 'healthy-retry').status, 0);
  assert.match(JSON.parse(readFileSync(input.capture, 'utf8')).at(-1), /CONTROLLED RECOVERY FAULT INJECTION/);
  assert.deepEqual(JSON.parse(readFileSync(input.state, 'utf8')), {
    'dev-missing': { 'dev-agent': ['healthy-retry'] },
  });
});

test('a model-backed scenario budgets Dev and Test executions independently', () => {
  const input = fixture();
  assert.equal(run(input, 'dev-a').status, 0);
  assert.equal(run(input, 'test-a', {
    LOOP_AGENT_RESULT_AGENT: 'test-agent', LOOP_RECOVERY_FAILURE_COMMAND: 'npm test -- missing-feature',
  }).status, 0);
  assert.match(JSON.parse(readFileSync(input.capture, 'utf8')).at(-1), /npm test -- missing-feature/);
  assert.deepEqual(JSON.parse(readFileSync(input.state, 'utf8')), {
    'dev-missing': { 'dev-agent': ['dev-a'], 'test-agent': ['test-a'] },
  });
});

test('non-target orchestration agents delegate unchanged without an execution id', () => {
  const input=fixture();
  const result=run(input,'',{LOOP_EXECUTION_ID:undefined,LOOP_AGENT_RESULT_AGENT:'prompt-evolution-agent'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(readFileSync(input.capture,'utf8')).at(-1),'original prompt');
  assert.equal(readFileSync(input.capture,'utf8').includes('CONTROLLED RECOVERY FAULT INJECTION'),false);
});

test('stdin executors receive the injected prompt without changing their arguments', () => {
  const input = fixture();
  const stdinCapture = join(input.root, 'stdin.txt');
  writeFileSync(input.real, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nlet value='';for await(const chunk of process.stdin)value+=chunk;writeFileSync(process.env.CAPTURE,value);\n`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [wrapper, 'exec', '-'], { input: 'original stdin prompt', encoding: 'utf8', env: {
    ...process.env,
    LOOP_RECOVERY_FAULT_ACK: ack,
    LOOP_RECOVERY_FAULT_MODE: 'dev-missing',
    LOOP_RECOVERY_FAULT_STATE: input.state,
    LOOP_RECOVERY_REAL_CLI: input.real,
    LOOP_EXECUTION_ID: 'stdin-dev',
    LOOP_AGENT_RESULT_AGENT: 'dev-agent',
    CAPTURE: stdinCapture,
  } });
  assert.equal(result.status, 0);
  const prompt = readFileSync(stdinCapture, 'utf8');
  assert.match(prompt, /^original stdin prompt/);
  assert.match(prompt, /CONTROLLED RECOVERY FAULT INJECTION/);
});

test('fault injection refuses accidental use without the acknowledgement', () => {
  const input = fixture();
  const result = run(input, 'execution-a', { LOOP_RECOVERY_FAULT_ACK: '' });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /refusing to run/);
});

test('synthetic durable-result crash writes the exact private envelope before failing', () => {
  const input = fixture();
  const resultPath = join(input.root, 'result.json');
  const result = spawnSync(process.execPath, [wrapper], { encoding: 'utf8', env: {
    ...process.env,
    LOOP_RECOVERY_FAULT_ACK: ack,
    LOOP_RECOVERY_FAULT_MODE: 'crash-after-submit',
    LOOP_RECOVERY_FAULT_STATE: input.state,
    LOOP_RECOVERY_FAULT_AGENT: 'dev-agent',
    LOOP_EXECUTION_ID: 'execution-crash',
    LOOP_AGENT_RESULT_AGENT: 'dev-agent',
    LOOP_AGENT_RESULT_PATH: resultPath,
    LOOP_AGENT_RESULT_PROTOCOL: 'loop-agent-result/v1',
    LOOP_AGENT_RESULT_KIND: 'flow',
  } });
  assert.equal(result.status, 70);
  assert.match(result.stderr, /controlled crash/);
  assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), {
    protocol: 'loop-agent-result/v1', kind: 'flow',
    result: { outcome: 'completed', summary: 'controlled durable result before crash' },
  });
});
