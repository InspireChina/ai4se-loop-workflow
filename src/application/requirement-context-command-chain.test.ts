import assert from 'node:assert/strict';
import test from 'node:test';
import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import type { DelegationEnvelope } from './tasks';

function delegation(taskId: string, itemType = 'feature'): DelegationEnvelope {
  return {
    taskId,
    lane: 'control',
    pipeline: 'backlog',
    agent: 'backlog-agent',
    storyIndex: null,
    resources: ['browser:exclusive'],
    description: '核对冻结业务规格与当前项目事实',
    title: 'YAML 业务变化上下文',
    taskDescription: '管理员可以导出当前筛选结果。',
    itemType,
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
    nextStep: '形成业务变化上下文',
    blockedReason: '',
    owner: '',
    evidence: '',
    risk: '',
  };
}

async function begin(taskId: string, itemType = 'feature') {
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const started = await beginTestExecutionAttempt({
    runId: `RUN-requirement-context-chain-${taskId}`,
    delegation: delegation(taskId, itemType),
    prompt: 'YAML requirement context command chain',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { executionId: started.attempt.execution_id, token };
}

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

async function put(
  executionId: string,
  token: string,
  block: string,
  content: string,
  key?: string,
) {
  return command(executionId, token, [
    'artifact', 'put',
    '--artifact', 'requirement-context',
    '--block', block,
    ...(key ? ['--key', key] : []),
    '--content', content,
  ]);
}

async function reachFinalize(executionId: string, token: string, includeExpected = false) {
  await put(executionId, token, 'intent', '管理员需要取得与当前筛选条件一致的导出文件。');
  await put(executionId, token, 'assertions', [
    'perspective: actual',
    'statement: 当前页面只能查看筛选结果，不能下载文件。',
    'evidence: observed',
    'source: 结果页真实入口与当前代码行为',
  ].join('\n'), 'actual-export');
  if (includeExpected) {
    await put(executionId, token, 'assertions', [
      'perspective: expected',
      'statement: 已有业务规范要求下载内容与当前筛选结果一致。',
      'evidence: reported',
      'source: 冻结需求规格',
    ].join('\n'), 'expected-filter');
  }
  await command(executionId, token, ['phase', 'complete']);
  await command(executionId, token, ['phase', 'complete']);
  await command(executionId, token, ['phase', 'complete']);
  await put(executionId, token, 'answer-review', '已复查全部冻结输入和当前决策路径，没有遗漏的新业务分叉。');
  await command(executionId, token, ['phase', 'complete']);
  await put(executionId, token, 'assertions', [
    'perspective: target',
    'statement: 管理员可以下载与当前筛选条件一致的结果文件。',
    'evidence: decided',
    'source: 冻结需求规格与已关闭决策路径',
  ].join('\n'), 'target-export');
  await command(executionId, token, ['phase', 'complete']);
  await put(executionId, token, 'change-summary', '从只能在线查看筛选结果，变为可以下载同一结果集。');
  await put(executionId, token, 'impacts', [
    'statement: 管理员可以下载当前筛选命中的结果。',
    'disposition: change',
    'rationale: 这是冻结规格要求的新业务结果。',
    'source: target-export',
  ].join('\n'), 'filtered-export');
  await command(executionId, token, ['phase', 'complete']);
  await put(executionId, token, 'scope', [
    'direction: included',
    'content: 当前筛选结果的文件导出。',
  ].join('\n'), 'filtered-export');
  await command(executionId, token, ['phase', 'complete']);
  await put(executionId, token, 'acceptance', [
    'content: 下载文件中的业务记录与发起导出时的筛选结果一致。',
    'source: target-export 和 filtered-export',
  ].join('\n'), 'download-matches-filter');
  return command(executionId, token, ['phase', 'complete']);
}

test('Backlog Agent uses only the YAML command chain and compiles downstream context', async () => {
  const { createTask } = await import('./tasks');
  const taskId = await createTask({ title: '导出筛选结果', description: '管理员可以导出当前筛选结果。' });
  const active = await begin(taskId);

  assert.match(await command(active.executionId, active.token!, ['help']), /通用命令链/);
  await assert.rejects(
    command(active.executionId, active.token!, ['requirement-context', 'status']),
    /当前草稿使用通用命令链/,
  );
  const status = await command(active.executionId, active.token!, ['status']);
  assert.match(status, /Phase: as_is/);
  assert.match(status, /requirement-context\.intent/);

  const finalize = await reachFinalize(active.executionId, active.token!);
  assert.match(finalize, /FINALIZE · builtin/);
  const completed = await command(active.executionId, active.token!, ['phase', 'complete']);
  assert.match(completed, /Outcome: completed/);

  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const result = await readAgentCommandSubmission(active.executionId);
  assert.equal(result?.outcome, 'completed');
  assert.match(result?.artifact?.content || '', /BUSINESS INTENT/);
  assert.match(result?.artifact?.content || '', /下载/);

  const { databaseConnection } = await import('../infrastructure/database');
  const { latestRequirementContextProjection } = await import('./command-chain-drafts');
  const db = await databaseConnection();
  const projection = latestRequirementContextProjection(db, taskId);
  assert.equal(projection?.impacts[0]?.key, 'filtered-export');
  assert.equal(projection?.acceptance[0]?.key, 'download-matches-filter');
  const legacyTables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'requirement_context_%'
  `).all();
  assert.deepEqual(legacyTables, []);
});

test('the final builtin gate requires Existing Expected for bug requirements', async () => {
  const { createTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const taskId = await createTask({ title: '修复筛选导出', description: '修复下载内容与筛选条件不一致。' });
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET item_type = 'bug' WHERE task_id = ?").run(taskId);
  const active = await begin(taskId, 'bug');
  await command(active.executionId, active.token!, ['status']);
  await reachFinalize(active.executionId, active.token!);
  await assert.rejects(
    command(active.executionId, active.token!, ['phase', 'complete']),
    /Bug 需求缺少可靠的 Existing Expected/,
  );
});

test('a HUMAN decision pauses and resumes the same YAML command-chain draft', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { readAgentCommandSubmission, issueAgentCommandToken } = await import('./agent-command-drafts');
  const { completeExecution } = await import('./executions');
  const { answerQuestion, createTask, getTask, submitClarificationAnswers } = await import('./tasks');
  const taskId = await createTask({
    title: '确认导出用户范围',
    description: '增加筛选结果导出，但目标用户范围尚未冻结。',
  });
  const firstDelegation = delegation(taskId);
  const first = await begin(taskId);

  await command(first.executionId, first.token!, ['status']);
  await put(first.executionId, first.token!, 'intent', '为适用用户提供当前筛选结果导出能力。');
  await put(first.executionId, first.token!, 'assertions', [
    'perspective: actual',
    'statement: 当前系统只有管理员入口展示完整筛选结果。',
    'evidence: observed',
    'source: 当前权限路由和结果页入口',
  ].join('\n'), 'actual-audience');
  await command(first.executionId, first.token!, ['phase', 'complete']);
  await command(first.executionId, first.token!, [
    'decision', 'put', '--tree', 'decisions', '--key', 'export-audience', '--content', [
      'type: business',
      'title: 导出能力面向哪些用户',
      'question: 本轮导出能力只面向管理员，还是同时面向普通成员？',
      'impact: 用户范围会改变权限边界和最终验收语义。',
      'options:',
      '  - id: admin',
      '    label: 仅管理员',
      '    consequence: 保持现有权限边界。',
      '  - id: all-members',
      '    label: 所有成员',
      '    consequence: 扩大权限和可见数据边界。',
      'recommendation:',
      '  option: admin',
      '  reason: 这是与现有入口一致的最小业务范围。',
      '  authority: user',
      'dependencies: []',
    ].join('\n'),
  ]);
  await command(first.executionId, first.token!, ['phase', 'complete']);
  await command(first.executionId, first.token!, [
    'decision', 'ask', '--tree', 'decisions', '--key', 'export-audience',
  ]);
  const waiting = await command(first.executionId, first.token!, ['phase', 'complete']);
  assert.match(waiting, /Outcome: waiting_for_human/);

  const pending = await readAgentCommandSubmission(first.executionId);
  assert.equal(pending?.outcome, 'needs_input');
  assert.equal(pending?.questions[0]?.decisionKey, 'export-audience');
  await applyAgentResult(
    `RUN-requirement-context-chain-${taskId}`,
    firstDelegation,
    pending!,
    { executionId: first.executionId },
  );
  await completeExecution(first.executionId);

  const detail = await getTask(taskId);
  const question = detail?.questions.find((item) => item.decision_key === 'export-audience');
  assert.equal(question?.status, 'pending');
  await answerQuestion({
    taskId,
    questionId: question!.question_id,
    answer: '本轮仅管理员可使用导出能力。',
    selectedOptionId: 'admin',
  });
  await submitClarificationAnswers(taskId);

  const resumedDelegation = (await inspectTaskDispatch(taskId)).find((item) => item.agent === 'backlog-agent');
  assert.ok(resumedDelegation);
  assert.equal(resumedDelegation!.pipeline, 'resume');
  const started = await beginTestExecutionAttempt({
    runId: `RUN-requirement-context-resume-${taskId}`,
    delegation: resumedDelegation! as DelegationEnvelope,
    prompt: 'resume YAML requirement context command chain',
  });
  const resumedToken = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(resumedToken);
  const status = await command(started.attempt.execution_id, resumedToken, ['status']);
  assert.match(status, /Phase: decision_resolution/);
  assert.match(status, /export-audience: needs_user_input.*answered=本轮仅管理员可使用导出能力。/s);
  await command(started.attempt.execution_id, resumedToken, [
    'decision', 'resolve', '--tree', 'decisions', '--key', 'export-audience',
    '--option', 'admin', '--authority', 'user',
    '--decision', '本轮仅管理员可使用导出能力。',
    '--rationale', '继承用户对业务范围的明确回答。',
    '--evidence', '用户提交的决策答案。',
  ]);
  const next = await command(started.attempt.execution_id, resumedToken, ['phase', 'complete']);
  assert.match(next, /To: answer_review/);
});
