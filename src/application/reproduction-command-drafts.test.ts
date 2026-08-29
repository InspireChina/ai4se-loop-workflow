import assert from 'node:assert/strict';
import test from 'node:test';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import type { DelegationEnvelope } from './tasks';

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

async function begin(delegation: DelegationEnvelope, suffix: string) {
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const started = await beginTestExecutionAttempt({
    runId: `RUN-reproduction-chain-${suffix}`,
    delegation,
    prompt: 'YAML reproduction command chain',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { executionId: started.attempt.execution_id, token };
}

async function bugDelegation(title: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask } = await import('./tasks');
  const taskId = await createTask({
    title,
    description: '管理员打开已归档需求并保存时页面显示空白；预期保存后仍停留在详情页。',
  });
  const db = await databaseConnection();
  db.prepare(`
    UPDATE tasks
    SET item_type = 'bug', agile_status = 'in repro', current_subagent = 'repro-agent',
        next_step = '复现管理员保存已归档需求后页面空白'
    WHERE task_id = ?
  `).run(taskId);
  const delegation = (await inspectTaskDispatch(taskId))[0] as DelegationEnvelope | undefined;
  assert.equal(delegation?.agent, 'repro-agent');
  assert.equal(delegation?.pipeline, 'repro');
  return { taskId, delegation: delegation! };
}

async function put(executionId: string, token: string, block: string, content: string, key?: string) {
  return command(executionId, token, [
    'artifact', 'put', '--artifact', 'reproduction', '--block', block,
    ...(key ? ['--key', key] : []), '--content', content,
  ]);
}

async function recordInvestigation(
  executionId: string,
  token: string,
  status: 'reproduced' | 'not_reproduced',
  environment: string,
  actual: string,
) {
  await put(executionId, token, 'verdict', [
    `status: ${status}`,
    'expectedBehavior: 保存成功后仍停留在详情页并看到成功状态',
    `actualBehavior: ${actual}`,
    `environment: ${environment}`,
    `stability: ${status === 'reproduced' ? '连续三次稳定复现，macOS 对照不复现' : '连续三次均未出现报告症状'}`,
    'impactScope: 已归档需求保存后的详情区域',
  ].join('\n'));
  await put(executionId, token, 'steps', [
    'action: 以管理员身份打开已归档需求并点击保存',
    'expected: 保存成功并保留详情页',
    `actual: ${actual}`,
  ].join('\n'), 'save-archived');
  await put(executionId, token, 'evidence', [
    'kind: observation',
    `content: ${status === 'reproduced' ? '三次保存均在响应成功后出现空白详情区域' : '三次保存后页面均正常显示详情'}`,
    `source: ${environment} 浏览器复现记录`,
  ].join('\n'), 'browser-observation');
  await put(executionId, token, 'hypotheses', [
    'status: suspected',
    'statement: 保存后的路由或状态恢复存在环境相关分支',
    `evidence: ${status === 'reproduced' ? 'Windows 稳定复现而 macOS 对照不复现' : '当前环境未出现症状'}`,
  ].join('\n'), 'environment-specific');
}

test('Repro Agent pauses for missing facts and resumes the same YAML command chain to a reproduced result', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { readAgentCommandSubmission, issueAgentCommandToken } = await import('./agent-command-drafts');
  const { completeExecution } = await import('./executions');
  const { answerQuestion, getTask, submitClarificationAnswers } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const { taskId, delegation } = await bugDelegation('YAML 问题复现');
  const first = await begin(delegation, `${taskId}-first`);

  assert.match(await command(first.executionId, first.token!, ['help']), /通用命令链/);
  await assert.rejects(command(first.executionId, first.token!, ['reproduction', 'status']), /当前草稿使用通用命令链/);
  const status = await command(first.executionId, first.token!, ['status']);
  assert.match(status, /Phase: investigation/);
  assert.match(status, /reproduction\.verdict/);
  await recordInvestigation(first.executionId, first.token!, 'not_reproduced', 'macOS 本地开发环境', '保存成功并保留详情页，未出现报告症状');
  await command(first.executionId, first.token!, ['phase', 'complete']);
  await command(first.executionId, first.token!, [
    'decision', 'put', '--tree', 'decisions', '--key', 'reported-environment', '--content', [
      'type: business',
      'title: 确认问题发生环境',
      'question: 问题发生在 Windows 还是 macOS？',
      'impact: 不同系统会改变复现条件。',
      'options:',
      '  - id: windows',
      '    label: Windows',
      '    consequence: 需要在 Windows 环境继续复现。',
      '  - id: macos',
      '    label: macOS',
      '    consequence: 需要继续核对浏览器与数据差异。',
      'recommendation:',
      '  option: windows',
      '  reason: 当前 macOS 对照环境未出现症状。',
      '  authority: user',
      'dependencies: []',
    ].join('\n'),
  ]);
  await command(first.executionId, first.token!, ['phase', 'complete']);
  await command(first.executionId, first.token!, ['decision', 'ask', '--tree', 'decisions', '--key', 'reported-environment']);
  assert.match(await command(first.executionId, first.token!, ['phase', 'complete']), /waiting_for_human/);

  const pending = await readAgentCommandSubmission(first.executionId);
  assert.equal(pending?.reproVerdict, 'not_reproduced');
  assert.equal(pending?.route, undefined);
  assert.equal(pending?.questions[0]?.decisionKey, 'reported-environment');
  await applyAgentResult(`RUN-reproduction-pending-${taskId}`, delegation, pending!, { executionId: first.executionId });
  await completeExecution(first.executionId);

  let detail = await getTask(taskId);
  const question = detail?.questions.find((item) => item.decision_key === 'reported-environment');
  assert.ok(question);
  await answerQuestion({ taskId, questionId: question!.question_id, answer: 'Windows 11 24H2，Edge 138。', selectedOptionId: 'windows' });
  await submitClarificationAnswers(taskId);
  const resumedDelegation = (await inspectTaskDispatch(taskId))[0] as DelegationEnvelope;
  assert.equal(resumedDelegation.pipeline, 'resume');
  const started = await beginTestExecutionAttempt({
    runId: `RUN-reproduction-resume-${taskId}`,
    delegation: resumedDelegation,
    prompt: 'resume YAML reproduction command chain',
  });
  const resumedToken = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(resumedToken);
  const restored = await command(started.attempt.execution_id, resumedToken, ['status']);
  assert.match(restored, /Phase: alignment_resolution/);
  assert.match(restored, /reported-environment: needs_user_input.*answered=Windows 11 24H2/s);
  await command(started.attempt.execution_id, resumedToken, [
    'decision', 'resolve', '--tree', 'decisions', '--key', 'reported-environment',
    '--option', 'windows', '--authority', 'user', '--decision', '在 Windows 11 Edge 环境继续复现。',
    '--rationale', '继承用户提供的问题发生环境。', '--evidence', '用户回答 Windows 11 24H2，Edge 138。',
  ]);
  await command(started.attempt.execution_id, resumedToken, ['phase', 'complete']);
  await put(started.attempt.execution_id, resumedToken, 'answer-review', '用户答案改变复现环境，需要回退调查并在 Windows 11 Edge 重新取证。');
  await command(started.attempt.execution_id, resumedToken, [
    'phase', 'rewind', '--to', 'investigation', '--reason', '用户确认问题发生在 Windows 11 Edge，需要重新取证',
  ]);
  await recordInvestigation(started.attempt.execution_id, resumedToken, 'reproduced', 'Windows 11 24H2，Edge 138', '保存请求成功后详情区域立即变为空白');
  await command(started.attempt.execution_id, resumedToken, ['phase', 'complete']);
  await command(started.attempt.execution_id, resumedToken, ['phase', 'complete']);
  await command(started.attempt.execution_id, resumedToken, [
    'decision', 'resolve', '--tree', 'decisions', '--key', 'reported-environment',
    '--option', 'windows', '--authority', 'user', '--decision', '在 Windows 11 Edge 环境完成复现。',
    '--rationale', '继承用户提供的问题发生环境。', '--evidence', '用户答案与重新取证结果一致。',
  ]);
  await command(started.attempt.execution_id, resumedToken, ['phase', 'complete']);
  await put(started.attempt.execution_id, resumedToken, 'answer-review', '已结合用户环境答案复查，新证据与答案一致，无新增对齐问题。');
  await command(started.attempt.execution_id, resumedToken, ['phase', 'complete']);
  assert.match(await command(started.attempt.execution_id, resumedToken, ['phase', 'complete']), /Outcome: completed/);

  const reproduced = await readAgentCommandSubmission(started.attempt.execution_id);
  assert.equal(reproduced?.reproVerdict, 'reproduced');
  assert.equal(reproduced?.route, 'plan');
  assert.match(reproduced?.artifact?.content || '', /Windows 11 24H2/);
  await applyAgentResult(`RUN-reproduction-complete-${taskId}`, resumedDelegation, reproduced!, { executionId: started.attempt.execution_id });
  await completeExecution(started.attempt.execution_id);
  detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'in plan');
  assert.equal(detail?.task.current_subagent, 'story-splitter-agent');

  const db = await databaseConnection();
  const legacyTables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'reproduction_%'`).all();
  assert.deepEqual(legacyTables, []);
});

test('feedback reproduction keeps one generic draft per feedback group', async () => {
  const { agentCommandWorkKey } = await import('../domain/agent-command-profile');
  assert.equal(
    agentCommandWorkKey('repro-agent', 'feedback-repro', 'REQ-1', null, 'delegation-a', 'group-a'),
    agentCommandWorkKey('repro-agent', 'feedback-repro', 'REQ-1', null, 'delegation-b', 'group-a'),
  );
  assert.notEqual(
    agentCommandWorkKey('repro-agent', 'feedback-repro', 'REQ-1', null, 'delegation-a', 'group-a'),
    agentCommandWorkKey('repro-agent', 'feedback-repro', 'REQ-1', null, 'delegation-a', 'group-b'),
  );
});
