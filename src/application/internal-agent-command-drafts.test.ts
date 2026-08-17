import { beginTestExecutionAttempt } from '../test/execution-fixtures';
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
  workType: 'evolution',
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
  const { completeExecution } = await import('./executions');
  const { createTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');

  await ensureAgentRuntimeWorkspace();
  const db = await databaseConnection();
  db.prepare("UPDATE agent_profiles SET auto_evolve = 1 WHERE agent_id = 'backlog-agent'").run();
  const taskId = await createTask({ title: '渐进式 Prompt 演化测试' });
  const started = await beginTestExecutionAttempt({
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
