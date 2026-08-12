import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import type { DelegationEnvelope } from './tasks';

function backlogDelegation(taskId: string): DelegationEnvelope {
  return {
    taskId,
    lane: 'control',
    pipeline: 'backlog',
    agent: 'backlog-agent',
    storyIndex: null,
    resources: ['browser:exclusive'],
    description: '测试演化来源',
    title: '渐进式 Prompt 演化测试',
    taskDescription: null,
    itemType: 'intake',
    priority: '',
    link: '',
    externalId: '',
    externalStatus: '',
    agileStatus: 'backlog',
    currentSubagent: 'backlog-agent',
    resumePending: 0,
    specResolvedIndex: 0,
    runState: 'runnable',
    closureStatus: 'none',
    reviewRevision: 0,
    reviewDocumentId: '',
    lastActor: 'human',
    analysisIndex: 0,
    devIndex: 0,
    testIndex: 0,
    totalStories: 0,
    nextStep: '收集上下文',
    blockedReason: '',
    owner: '',
    evidence: '',
    risk: '',
  };
}

async function run(
  workType: 'evolution' | 'maintenance',
  workId: string,
  sessionId: string,
  token: string,
  args: string[],
) {
  const { runInternalAgentCommand } = await import('./internal-agent-command-drafts');
  return runInternalAgentCommand({ workType, workId, sessionId, token, args });
}

test('Prompt evolution progressively restores observations and submits without Agent JSON', async () => {
  const { beginEvolutionRun, applyEvolutionResult } = await import('./agent-evolution');
  const { ensureAgentRuntimeWorkspace } = await import('./agent-profiles');
  const {
    issueInternalAgentCommandToken,
    readInternalAgentCommandSubmission,
  } = await import('./internal-agent-command-drafts');
  const { beginExecutionAttempt, completeExecution } = await import('./executions');
  const { createTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');

  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  db.prepare("UPDATE agent_profiles SET auto_evolve = 1 WHERE agent_id = 'backlog-agent'").run();
  const taskId = await createTask({ title: '渐进式 Prompt 演化测试' });
  const started = await beginExecutionAttempt({
    runId: `RUN-internal-evolution-${randomUUID()}`,
    delegation: backlogDelegation(taskId),
    prompt: 'test',
  });
  const evidence = {
    executionId: started.attempt.execution_id,
    taskId,
    storyIndex: null,
    agentId: 'backlog-agent',
    attempt: 1,
    promptVersion: null,
    result: { outcome: 'completed', summary: '需求梳理完成' },
    applicationOutcome: 'advanced',
    diagnostics: [],
  };
  const evolution = await beginEvolutionRun(evidence);
  assert.ok(evolution?.evolutionId);
  const first = await issueInternalAgentCommandToken('evolution', evolution!.evolutionId);

  await assert.rejects(
    run('evolution', evolution!.evolutionId, first.sessionId, first.token, [
      'evolution', 'summary', 'set', '--text', '不能跳过状态恢复',
    ]),
    /evolution status/,
  );
  await run('evolution', evolution!.evolutionId, first.sessionId, first.token, [
    'evolution', 'status',
  ]);
  await run('evolution', evolution!.evolutionId, first.sessionId, first.token, [
    'evolution', 'summary', 'set', '--text', '识别出一条稳定的输出契约经验。',
  ]);
  await run('evolution', evolution!.evolutionId, first.sessionId, first.token, [
    'evolution', 'observation', 'upsert',
    '--key', 'explicit-empty-state',
    '--fingerprint', 'explicit-empty-state-contract',
    '--category', 'output-contract',
    '--summary', '空结果必须明确说明没有发现可复用观察',
    '--guidance', '当证据不足以形成长期经验时，明确提交空观察列表，不要制造经验。',
    '--target', 'memory',
    '--confidence', '0.82',
    '--reusable', 'true',
    '--comment-ids', 'none',
  ]);

  const resumed = await issueInternalAgentCommandToken('evolution', evolution!.evolutionId);
  await assert.rejects(
    run('evolution', evolution!.evolutionId, first.sessionId, first.token, [
      'evolution', 'status',
    ]),
    /会话已经失效/,
  );
  await assert.rejects(
    run('evolution', evolution!.evolutionId, resumed.sessionId, resumed.token, [
      'evolution', 'complete',
    ]),
    /evolution status/,
  );
  const restored = await run(
    'evolution',
    evolution!.evolutionId,
    resumed.sessionId,
    resumed.token,
    ['evolution', 'status'],
  );
  assert.match(restored, /explicit-empty-state/);
  await run('evolution', evolution!.evolutionId, resumed.sessionId, resumed.token, [
    'evolution', 'complete',
  ]);
  const result = await readInternalAgentCommandSubmission('evolution', evolution!.evolutionId);
  assert.equal(result?.observations[0]?.fingerprint, 'explicit-empty-state-contract');
  assert.equal(result?.observations[0]?.confidence, 0.82);

  await applyEvolutionResult(evolution!.evolutionId, evidence, result!);
  await completeExecution(started.attempt.execution_id);
});

test('Software maintenance progressively records diagnosis and enforces fixed evidence', async () => {
  const {
    issueInternalAgentCommandToken,
    readInternalAgentCommandSubmission,
  } = await import('./internal-agent-command-drafts');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const jobId = randomUUID();
  db.prepare(`
    INSERT INTO software_maintenance_jobs(
      job_id, trigger_kind, severity_text, status, attempt
    ) VALUES(?, 'manual', 'ERROR', 'running', 1)
  `).run(jobId);
  const command = await issueInternalAgentCommandToken('maintenance', jobId);
  const env = { ...process.env } as NodeJS.ProcessEnv;
  delete env.LOOP_TEST;
  delete env.LOOP_TEST_SETUP_PID;
  delete env.NODE_TEST_CONTEXT;
  const cli = spawnSync(process.execPath, [
    join(process.cwd(), 'scripts', 'loop', 'loop-agent.mjs'),
    'maintenance', 'status',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...env,
      LOOP_INTERNAL_WORK_TYPE: 'maintenance',
      LOOP_INTERNAL_WORK_ID: jobId,
      LOOP_INTERNAL_SESSION_ID: command.sessionId,
      LOOP_INTERNAL_COMMAND_TOKEN: command.token,
    },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /软件维护草稿/);
  for (const args of [
    ['maintenance', 'outcome', 'set', '--value', 'fixed'],
    ['maintenance', 'fingerprint', 'set', '--value', 'runner-status-recovery'],
    ['maintenance', 'classification', 'set', '--value', 'loop_bug'],
    ['maintenance', 'summary', 'set', '--text', '修复 Runner 状态恢复中的确定性缺陷。'],
    ['maintenance', 'root-cause', 'set', '--text', '恢复分支遗漏了持久状态映射。'],
    ['maintenance', 'confidence', 'set', '--value', '0.91'],
  ]) {
    await run('maintenance', jobId, command.sessionId, command.token, args);
  }
  await assert.rejects(
    run('maintenance', jobId, command.sessionId, command.token, [
      'maintenance', 'complete',
    ]),
    /fixed 必须记录实际变更文件/,
  );
  await run('maintenance', jobId, command.sessionId, command.token, [
    'maintenance', 'changed-file', 'add', '--path', 'src/runner-state.ts',
  ]);
  await assert.rejects(
    run('maintenance', jobId, command.sessionId, command.token, [
      'maintenance', 'complete',
    ]),
    /至少记录一条通过的针对性测试/,
  );
  await run('maintenance', jobId, command.sessionId, command.token, [
    'maintenance', 'test', 'upsert',
    '--key', 'runner-state-unit',
    '--command', 'npm test -- runner-state',
    '--passed', 'true',
    '--summary', '状态恢复测试通过。',
  ]);
  await run('maintenance', jobId, command.sessionId, command.token, [
    'maintenance', 'complete',
  ]);
  const result = await readInternalAgentCommandSubmission('maintenance', jobId);
  assert.equal(result?.outcome, 'fixed');
  assert.deepEqual(result?.changedFiles, ['src/runner-state.ts']);
  assert.deepEqual(result?.tests, [{
    command: 'npm test -- runner-state',
    passed: true,
    summary: '状态恢复测试通过。',
  }]);
  db.prepare(`
    UPDATE software_maintenance_jobs
    SET status = 'verified', finished_at = CURRENT_TIMESTAMP
    WHERE job_id = ?
  `).run(jobId);
});
