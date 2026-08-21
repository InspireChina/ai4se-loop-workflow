import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { shouldRecordDevCodeCommit } from '../application/executions';
import { resolveRunnerCommand } from './agent-runner';

test('starts the TypeScript Runner through Node and the local tsx CLI', () => {
  const launch = resolveRunnerCommand('RUN-123', 'agent-runner.ts');

  assert.equal(launch.command, process.execPath);
  assert.match(launch.args[0], /tsx[/\\]dist[/\\]cli\.mjs$/);
  assert.equal(basename(launch.args[1]), 'agent-runner.ts');
  assert.equal(launch.args[2], 'RUN-123');
  assert.ok(!launch.args.includes('npx'));
});

test('starts bundled desktop runners through Electron in Node mode', () => {
  const previous = {
    desktop: process.env.LOOP_DESKTOP,
    node: process.env.LOOP_DESKTOP_NODE,
    root: process.env.LOOP_APP_ROOT,
  };
  process.env.LOOP_DESKTOP = '1';
  process.env.LOOP_DESKTOP_NODE = '/Applications/LoopWork.app/Contents/MacOS/LoopWork';
  process.env.LOOP_APP_ROOT = '/Applications/LoopWork.app/Contents/Resources/app-server';
  try {
    const launch = resolveRunnerCommand('RUN-123', 'agent-runner.ts');
    assert.equal(launch.command, process.env.LOOP_DESKTOP_NODE);
    assert.equal(basename(launch.args[0]), 'agent-runner.cjs');
    assert.equal(launch.args[1], 'RUN-123');
  } finally {
    if (previous.desktop === undefined) delete process.env.LOOP_DESKTOP;
    else process.env.LOOP_DESKTOP = previous.desktop;
    if (previous.node === undefined) delete process.env.LOOP_DESKTOP_NODE;
    else process.env.LOOP_DESKTOP_NODE = previous.node;
    if (previous.root === undefined) delete process.env.LOOP_APP_ROOT;
    else process.env.LOOP_APP_ROOT = previous.root;
  }
});

test('persists normalized business execution events as ordered execution receipts', () => {
  const source = readFileSync(resolve(process.cwd(), 'scripts/loop/agent-runner.ts'), 'utf8');

  assert.match(source, /recordTelemetryEvent:\s*async\s*\(event\)\s*=>/);
  assert.match(source, /createDurableToolEventNormalizer\(\)/);
  assert.match(source, /durableToolEvent\(event\)/);
  assert.match(source, /'tool_event'/);
  assert.match(source, /String\(event\.sequence\)\.padStart\(8,\s*'0'\)/);
  assert.match(source, /isCompleted && event\.success === true/);
  assert.match(source, /success:\s*event\.success === true/);
  assert.match(source, /exitCode:\s*event\.exitCode \?\? null/);
  assert.match(source, /createHash\('sha256'\)\.update\(command\)\.digest\('hex'\)/);
  assert.match(source, /originalLength:\s*command\.length/);
  assert.match(source, /本地执行证据写入失败，将自动重试/);
});

test('core contract constrains flow writes without prohibiting target database operations', () => {
  const source = readFileSync(resolve(process.cwd(), 'scripts/loop/agent-runner.ts'), 'utf8');

  assert.match(source, /只使用下方声明的上下文与草稿命令读取和提交流程数据。/);
  assert.doesNotMatch(source, /不要直接写数据库/);
  assert.doesNotMatch(source, /`Loop App Root:/);
});

test('records a Dev code commit only for a completed result that declares changed files', () => {
  assert.equal(shouldRecordDevCodeCommit('dev-agent', {
    outcome: 'completed',
    changedFiles: ['src/example.ts'],
  }), true);
  assert.equal(shouldRecordDevCodeCommit('dev-agent', {
    outcome: 'completed',
    changedFiles: [],
  }), false);
  assert.equal(shouldRecordDevCodeCommit('dev-agent', {
    outcome: 'completed',
  }), false);
  assert.equal(shouldRecordDevCodeCommit('test-agent', {
    outcome: 'completed',
    changedFiles: ['src/example.ts'],
  }), false);
  assert.equal(shouldRecordDevCodeCommit('dev-agent', {
    outcome: 'failed',
    changedFiles: ['src/example.ts'],
  }), false);
});

test('runner records the current HEAD without inferring a Dev commit from base_commit', () => {
  const source = readFileSync(resolve(process.cwd(), 'scripts/loop/agent-runner.ts'), 'utf8');

  assert.match(source, /shouldRecordDevCodeCommit\(delegation\.agent,\s*result\)/);
  assert.match(source, /const currentHead = gitHead\(paths\.root\)/);
  assert.doesNotMatch(source, /currentHead\s*!==\s*attempt\.base_commit/);
});

test('runner resolves runtime settings for each delegated agent instead of once per run', () => {
  const source = readFileSync(resolve(process.cwd(), 'scripts/loop/agent-runner.ts'), 'utf8');

  assert.match(source, /getAgentRuntimeSettings\(delegation\.agent\)/);
  assert.match(source, /executeDelegationStep\(reservation\)/);
  assert.match(source, /progressDispatcher\.activate/);
  assert.doesNotMatch(source, /const settings = await getAgentExecutorSettings\(\)/);
});

test('continuously refills completed lanes and cleans each execution temporary directory independently', () => {
  const source = readFileSync(resolve(process.cwd(), 'scripts/loop/agent-runner.ts'), 'utf8');

  assert.match(source, /new InFlightWork<ReservedExecution>\(\)/);
  assert.match(source, /inFlightExecutions\.waitForNextCompletion\(completionRevision\)/);
  assert.doesNotMatch(source, /Promise\.allSettled\(cycleExecutions\.values\(\)\)/);
  assert.match(source, /createAgentExecutionTempDirectory\(paths\.root, executionId\)/);
  assert.match(source, /LOOP_AGENT_TMP_DIR:\s*temporary\.directory/);
  assert.match(source, /removeAgentExecutionTempDirectory\(temporary\)/);
  assert.match(source, /Lane execution 已结束，立即重新计算可执行步骤/);
});

test('keeps the Runner behind its start gate until process registration completes', () => {
  const source = readFileSync(resolve(process.cwd(), 'scripts/loop/agent-runner.ts'), 'utf8');
  const gate = source.indexOf('await waitForRunnerStartGate(runId, startGateToken)');
  const heartbeat = source.indexOf("await startRunHeartbeat(runId, 'agent-runner')");
  const dispatch = source.indexOf('await main()');

  assert.ok(gate >= 0);
  assert.ok(gate < heartbeat);
  assert.ok(heartbeat < dispatch);
});

test('retries every Agent execution failure three times before blocking its lane', () => {
  const source = readFileSync(resolve(process.cwd(), 'scripts/loop/agent-runner.ts'), 'utf8');

  assert.match(source, /EXECUTION_FAILURE_MAX_RETRIES/);
  assert.match(source, /failExecutionWithRetryPolicy\(attempt\.execution_id, reason/);
  assert.match(source, /execution\.terminationReason \? 'agent-timeout' : 'agent-cli-exit'/);
  assert.doesNotMatch(source, /maxRetries:\s*[12]\b/);
  assert.doesNotMatch(source, /if \(!retryPolicy\).*failExecution/s);
});

test('uses Event Hub revisions and schedule deadlines instead of fixed business polling', () => {
  const source = readFileSync(resolve(process.cwd(), 'scripts/loop/agent-runner.ts'), 'utf8');
  const subscription = source.indexOf('subscribeRuntimeEvents({');
  const dispatch = source.indexOf('await main()');

  assert.ok(subscription >= 0);
  assert.ok(subscription < dispatch);
  assert.match(source, /onReady:\s*synchronizeEventRevisions/);
  assert.match(source, /runtimeEventRevisionInDb\(db, topic\)/);
  assert.match(source, /materializeDueScheduledRequirements\(\)/);
  assert.match(source, /nextScheduledRequirementWakeAt\(\)/);
  assert.match(source, /runnerWake\.wait\(/);
  assert.match(source, /executionOptions,\s*cancellation\.signal/);
  assert.doesNotMatch(source, /LOOP_EMPTY_DISPATCH_RETRY_MS/);
  assert.doesNotMatch(source, /sleepWhileRunActive/);
});
