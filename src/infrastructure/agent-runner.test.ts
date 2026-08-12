import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { shouldRecordDevCodeCommit } from '../application/executions';
import { resolveRunnerCommand } from './agent-runner';

test('starts TypeScript runners through Node and the local tsx CLI', () => {
  const launch = resolveRunnerCommand('RUN-123', 'dispatch-waiter.ts');

  assert.equal(launch.command, process.execPath);
  assert.match(launch.args[0], /tsx[/\\]dist[/\\]cli\.mjs$/);
  assert.equal(basename(launch.args[1]), 'dispatch-waiter.ts');
  assert.equal(launch.args[2], 'RUN-123');
  assert.ok(!launch.args.includes('npx'));
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
  assert.match(source, /executeDelegationStep\(delegation\)/);
  assert.doesNotMatch(source, /const settings = await getAgentExecutorSettings\(\)/);
});

test('continuously refills completed lanes and cleans each execution temporary directory independently', () => {
  const source = readFileSync(resolve(process.cwd(), 'scripts/loop/agent-runner.ts'), 'utf8');

  assert.match(source, /new InFlightWork<DelegationEnvelope>\(\)/);
  assert.match(source, /inFlightExecutions\.waitForNextCompletion\(completionRevision\)/);
  assert.doesNotMatch(source, /Promise\.allSettled\(cycleExecutions\.values\(\)\)/);
  assert.match(source, /createAgentExecutionTempDirectory\(paths\.root, executionId\)/);
  assert.match(source, /LOOP_AGENT_TMP_DIR:\s*temporary\.directory/);
  assert.match(source, /removeAgentExecutionTempDirectory\(temporary\)/);
  assert.match(source, /Lane execution 已结束，立即重新计算可执行步骤/);
});
