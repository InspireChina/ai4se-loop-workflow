import assert from 'node:assert/strict';
import test from 'node:test';
import type { DelegationEnvelope } from './tasks';

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

async function begin(delegation: DelegationEnvelope, runSuffix: string) {
  const { beginExecutionAttempt } = await import('./executions');
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const started = await beginExecutionAttempt({
    runId: `RUN-reproduction-${runSuffix}`,
    delegation,
    prompt: 'progressive reproduction prompt',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { delegation, executionId: started.attempt.execution_id, token };
}

async function bugDelegation(title: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, pipelineForTask } = await import('./tasks');
  const taskId = await createTask({
    title,
    description: '管理员打开已归档需求并保存时，页面显示空白；预期保存成功后仍停留在详情页。',
  });
  const db = await databaseConnection();
  db.prepare(`
    UPDATE tasks
    SET item_type = 'bug', agile_status = 'in repro', current_subagent = 'repro-agent',
        next_step = '复现管理员保存已归档需求后页面空白'
    WHERE task_id = ?
  `).run(taskId);
  const delegation = (await pipelineForTask(taskId))[0] as DelegationEnvelope | undefined;
  assert.equal(delegation?.agent, 'repro-agent');
  assert.equal(delegation?.pipeline, 'repro');
  return { taskId, delegation: delegation! };
}

async function recordAttempt(executionId: string, token: string) {
  await command(executionId, token, [
    'reproduction', 'expected', 'set',
    '--text', '管理员保存已归档需求后仍停留在详情页并看到成功状态',
  ]);
  await command(executionId, token, [
    'reproduction', 'actual', 'set',
    '--text', '当前本地环境保存成功且页面没有变为空白',
  ]);
  await command(executionId, token, [
    'reproduction', 'environment', 'set',
    '--text', 'macOS 本地开发环境，管理员入口，一条已归档需求',
  ]);
  await command(executionId, token, [
    'reproduction', 'stability', 'set',
    '--text', '连续执行三次均未出现空白；清缓存后对照结果一致',
  ]);
  await command(executionId, token, [
    'reproduction', 'impact', 'set',
    '--text', '疑似仅影响特定操作系统或浏览器下的已归档需求保存',
  ]);
  await command(executionId, token, [
    'reproduction', 'step', 'upsert',
    '--key', 'save-archived',
    '--action', '以管理员身份打开已归档需求并点击保存',
    '--expected', '保存成功并保留详情页',
    '--actual', '本地环境保存成功并保留详情页，未出现报告症状',
  ]);
  await command(executionId, token, [
    'reproduction', 'evidence', 'upsert',
    '--key', 'local-browser-observation',
    '--kind', 'observation',
    '--content', '三次保存后页面均正常显示详情',
    '--source', '本地浏览器复现记录',
  ]);
  await command(executionId, token, [
    'reproduction', 'hypothesis', 'upsert',
    '--key', 'environment-specific',
    '--status', 'suspected',
    '--statement', '问题依赖报告环境中的操作系统或浏览器版本',
    '--evidence', '相同数据和入口在本地未出现症状',
  ]);
}

test('repro agent persists an unsuccessful attempt, restores user alignment, and completes with evidence', async () => {
  const {
    answerQuestion,
    getTask,
    pipelineForTask,
    submitClarificationAnswers,
  } = await import('./tasks');
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { taskId, delegation } = await bugDelegation('渐进式问题复现');
  const first = await begin(delegation, `${taskId}-first`);

  await assert.rejects(
    command(first.executionId, first.token!, [
      'reproduction', 'expected', 'set', '--text', '保存后页面正常',
    ]),
    /尚未查看草稿状态/,
  );
  assert.match(
    await command(first.executionId, first.token!, ['reproduction', 'status']),
    /问题复现草稿 v1/,
  );
  await recordAttempt(first.executionId, first.token!);
  await command(first.executionId, first.token!, [
    'reproduction', 'question', 'add',
    '--key', 'reported-environment',
    '--title', '确认问题发生环境',
    '--question', '问题发生在 Windows 还是 macOS？',
    '--impact', '不同系统的浏览器和文件路径行为会改变复现条件',
  ]);
  await command(first.executionId, first.token!, [
    'reproduction', 'question', 'option-add',
    '--key', 'reported-environment',
    '--id', 'windows',
    '--label', 'Windows',
    '--consequence', '需要在 Windows 环境继续复现',
  ]);
  await command(first.executionId, first.token!, [
    'reproduction', 'question', 'option-add',
    '--key', 'reported-environment',
    '--id', 'macos',
    '--label', 'macOS',
    '--consequence', '需要继续核对浏览器与数据差异',
  ]);
  await command(first.executionId, first.token!, [
    'reproduction', 'question', 'recommend',
    '--key', 'reported-environment',
    '--option', 'windows',
    '--reason', '当前 macOS 对照环境未出现症状',
  ]);
  assert.equal(
    await command(first.executionId, first.token!, ['reproduction', 'validate']),
    '问题复现草稿结构校验通过。',
  );
  await command(first.executionId, first.token!, ['reproduction', 'request-alignment']);
  const pending = await readAgentCommandSubmission(first.executionId);
  assert.equal(pending?.reproVerdict, 'not_reproduced');
  assert.equal(pending?.route, undefined);
  assert.equal(pending?.questions[0]?.decisionKey, 'reported-environment');
  await applyAgentResult(`RUN-reproduction-pending-${taskId}`, delegation, pending!, {
    executionId: first.executionId,
  });
  await completeExecution(first.executionId);

  let detail = await getTask(taskId);
  const question = detail?.questions.find((item) => item.decision_key === 'reported-environment');
  assert.equal(detail?.task.run_state, 'waiting_for_answers');
  assert.ok(question);
  await answerQuestion({
    taskId,
    questionId: question!.question_id,
    answer: 'Windows 11 24H2，Edge 138。',
  });
  await submitClarificationAnswers(taskId);
  const resumedDelegation = (await pipelineForTask(taskId))[0] as DelegationEnvelope;
  assert.equal(resumedDelegation.pipeline, 'resume');
  const resumed = await begin(resumedDelegation, `${taskId}-resume`);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, ['reproduction', 'complete']),
    /尚未查看草稿状态/,
  );
  const restored = await command(resumed.executionId, resumed.token!, ['reproduction', 'status']);
  assert.match(restored, /问题复现草稿 v2/);
  assert.match(restored, /reported-environment：确认问题发生环境 · 已回答：Windows 11 24H2，Edge 138/);
  assert.match(restored, /save-archived/);
  await command(resumed.executionId, resumed.token!, [
    'reproduction', 'environment', 'set',
    '--text', 'Windows 11 24H2，Edge 138，管理员入口，一条已归档需求',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'reproduction', 'actual', 'set',
    '--text', '点击保存后请求成功，但详情区域立即变为空白',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'reproduction', 'stability', 'set',
    '--text', 'Windows 环境连续三次均复现；同一数据在 macOS 对照环境不复现',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'reproduction', 'step', 'upsert',
    '--key', 'save-archived',
    '--action', '在 Windows 11 Edge 中以管理员身份打开已归档需求并点击保存',
    '--expected', '保存成功并保留详情页',
    '--actual', '保存请求成功后详情区域变为空白',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'reproduction', 'evidence', 'upsert',
    '--key', 'windows-browser-observation',
    '--kind', 'observation',
    '--content', '三次保存均在响应成功后出现空白详情区域',
    '--source', 'Windows 11 Edge 浏览器复现记录',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'reproduction', 'hypothesis', 'upsert',
    '--key', 'environment-specific',
    '--status', 'suspected',
    '--statement', 'Windows Edge 下保存后的路由或状态恢复存在环境相关分支',
    '--evidence', 'Windows 稳定复现而 macOS 对照不复现',
  ]);
  await command(resumed.executionId, resumed.token!, ['reproduction', 'complete']);
  const reproduced = await readAgentCommandSubmission(resumed.executionId);
  assert.equal(reproduced?.reproVerdict, 'reproduced');
  assert.equal(reproduced?.route, 'plan');
  assert.match(reproduced?.artifact?.content || '', /Windows 11 24H2/);
  await applyAgentResult(`RUN-reproduction-complete-${taskId}`, resumedDelegation, reproduced!, {
    executionId: resumed.executionId,
  });
  await completeExecution(resumed.executionId);

  detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'in plan');
  assert.equal(detail?.task.current_subagent, 'story-splitter-agent');
  assert.equal(detail?.questions.find((item) => item.question_id === question?.question_id)?.status, 'resolved');
});

test('feedback reproduction keeps one draft across new executions for the same feedback group', async () => {
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
