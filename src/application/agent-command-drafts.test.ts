import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DelegationEnvelope } from './tasks';

function backlogDelegation(taskId: string, pipeline = 'backlog'): DelegationEnvelope {
  return {
    taskId,
    lane: 'control',
    pipeline,
    agent: 'backlog-agent',
    storyIndex: null,
    resource: 'browser',
    description: pipeline === 'resume' ? '根据用户回答继续需求梳理' : '收集需求上下文并完成分类',
    title: '渐进式需求上下文',
    taskDescription: '支持将筛选结果导出。',
    itemType: 'intake',
    priority: '',
    link: '',
    externalId: '',
    externalStatus: '',
    agileStatus: 'backlog',
    currentSubagent: 'backlog-agent',
    resumePending: pipeline === 'resume' ? 1 : 0,
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

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

async function begin(taskId: string, pipeline = 'backlog') {
  const { beginExecutionAttempt } = await import('./executions');
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const delegation = backlogDelegation(taskId, pipeline);
  const started = await beginExecutionAttempt({
    runId: `RUN-command-${taskId}-${pipeline}`,
    delegation,
    prompt: 'role-specific command prompt',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { delegation, executionId: started.attempt.execution_id, token };
}

async function beginDelegation(delegation: DelegationEnvelope, runSuffix = 'delivery-plan') {
  const { beginExecutionAttempt } = await import('./executions');
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const started = await beginExecutionAttempt({
    runId: `RUN-command-${runSuffix}-${delegation.taskId}`,
    delegation,
    prompt: 'role-specific progressive command prompt',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { delegation, executionId: started.attempt.execution_id, token };
}

async function taskReadyForSplit(title: string) {
  const { createTask, pipelineForTask } = await import('./tasks');
  const { applyAgentResult } = await import('./agent-results');
  const taskId = await createTask({
    title,
    description: '管理员可以将当前筛选结果导出为 CSV，并且导出文件只包含当前筛选命中的字段。',
  });
  await applyAgentResult(
    `RUN-command-backlog-${taskId}`,
    backlogDelegation(taskId),
    {
      outcome: 'completed',
      summary: '需求上下文完整，可以进入交付拆分。',
      artifact: {
        title: '需求分类与上下文',
        content: '# 需求上下文\n\n管理员导出当前筛选结果。',
      },
      questions: [],
      runtimeInputs: [],
      classification: 'feature',
      route: 'plan',
      feedbackResolutions: [],
      recoveryResolutions: [],
    },
  );
  const delegation = (await pipelineForTask(taskId))[0];
  assert.equal(delegation?.agent, 'story-splitter-agent');
  assert.equal(delegation?.pipeline, 'split');
  return { taskId, delegation: delegation! };
}

test('requires status first, accepts progressive edits, and submits a deterministic route without Agent JSON', async () => {
  const { createTask, getTask } = await import('./tasks');
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const taskId = await createTask({
    title: '渐进式需求上下文',
    description: '支持将筛选结果导出。',
  });
  const active = await begin(taskId);

  await assert.rejects(
    command(active.executionId, active.token!, [
      'requirement-context', 'goal', 'set', '--text', '支持用户导出当前筛选结果',
    ]),
    /尚未查看草稿状态/,
  );

  const initial = await command(active.executionId, active.token!, ['requirement-context', 'status']);
  assert.match(initial, /草稿 v1/);
  assert.match(initial, /缺少需求目标/);

  await command(active.executionId, active.token!, [
    'requirement-context', 'goal', 'set', '--text', '支持用户导出当前筛选结果',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'outcome', 'set', '--text', '下载文件与当前筛选列表一致',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'classification', 'set', 'feature',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'fact', 'add',
    '--key', 'filter-exists',
    '--statement', '列表已经支持组合筛选',
    '--source', '用户输入与仓库列表页面',
  ]);
  await command(active.executionId, active.token!, [
    'requirement-context', 'scope', 'include',
    '--key', 'filtered-data',
    '--text', '导出当前筛选条件命中的数据',
  ]);

  assert.equal(
    await command(active.executionId, active.token!, ['requirement-context', 'validate']),
    '需求上下文草稿结构校验通过。',
  );
  assert.match(
    await command(active.executionId, active.token!, ['requirement-context', 'complete']),
    /提交成功/,
  );
  assert.match(
    await command(active.executionId, active.token!, ['requirement-context', 'complete']),
    /已经提交成功/,
  );

  const result = await readAgentCommandSubmission(active.executionId);
  assert.equal(result?.classification, 'feature');
  assert.equal(result?.route, 'plan');
  assert.match(result?.artifact?.content || '', /列表已经支持组合筛选/);
  assert.match(result?.artifact?.content || '', /导出当前筛选条件命中的数据/);

  await applyAgentResult('RUN-command-progressive', active.delegation, result!, {
    executionId: active.executionId,
  });
  await completeExecution(active.executionId);
  const detail = await getTask(taskId);
  assert.equal(detail?.task.item_type, 'feature');
  assert.equal(detail?.task.agile_status, 'in plan');
  assert.equal(detail?.task.current_subagent, 'story-splitter-agent');
});

test('inherits a persisted clarification draft after resume and forces status again for the new execution', async () => {
  const {
    answerQuestion,
    createTask,
    getTask,
    pipelineForTask,
    submitClarificationAnswers,
  } = await import('./tasks');
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const taskId = await createTask({
    title: '需要确认导出受众',
    description: '增加导出入口，但没有说明哪些用户可以使用。',
  });
  const first = await begin(taskId);
  await command(first.executionId, first.token!, ['requirement-context', 'status']);
  await command(first.executionId, first.token!, [
    'requirement-context', 'goal', 'set', '--text', '为列表提供导出入口',
  ]);
  await command(first.executionId, first.token!, [
    'requirement-context', 'outcome', 'set', '--text', '目标用户可以下载列表数据',
  ]);
  await command(first.executionId, first.token!, [
    'requirement-context', 'classification', 'set', 'feature',
  ]);
  await command(first.executionId, first.token!, [
    'requirement-context', 'fact', 'add',
    '--key', 'audience-missing',
    '--statement', '当前输入没有说明导出入口面向哪些角色',
    '--source', '需求描述',
  ]);
  await command(first.executionId, first.token!, [
    'requirement-context', 'constraint', 'add',
    '--key', 'audience-must-be-confirmed',
    '--text', '目标用户必须由用户确认',
  ]);
  await command(first.executionId, first.token!, [
    'requirement-context', 'question', 'add',
    '--key', 'export-audience',
    '--title', '确认导出能力的目标用户',
    '--question', '只面向管理员还是同时面向普通成员？',
    '--impact', '目标用户会改变权限范围和交付边界',
  ]);
  await command(first.executionId, first.token!, [
    'requirement-context', 'question', 'option-add',
    '--key', 'export-audience',
    '--id', 'admin',
    '--label', '仅管理员',
    '--consequence', '保持较小权限范围',
  ]);
  await command(first.executionId, first.token!, [
    'requirement-context', 'question', 'option-add',
    '--key', 'export-audience',
    '--id', 'all-members',
    '--label', '所有成员',
    '--consequence', '需要新增成员权限行为',
  ]);
  await command(first.executionId, first.token!, [
    'requirement-context', 'question', 'recommend',
    '--key', 'export-audience',
    '--option', 'admin',
    '--reason', '这是满足当前目标的最小范围',
  ]);
  await command(first.executionId, first.token!, [
    'requirement-context', 'request-clarification',
  ]);

  const questionResult = await readAgentCommandSubmission(first.executionId);
  assert.equal(questionResult?.outcome, 'needs_input');
  assert.equal(questionResult?.questions[0]?.decisionKey, 'export-audience');
  await applyAgentResult('RUN-command-question', first.delegation, questionResult!, {
    executionId: first.executionId,
  });
  await completeExecution(first.executionId);

  let detail = await getTask(taskId);
  const question = detail?.questions.find((item) => item.decision_key === 'export-audience');
  assert.equal(detail?.task.run_state, 'waiting_for_answers');
  assert.ok(question);
  await answerQuestion({
    taskId,
    questionId: question!.question_id,
    answer: '本轮只面向管理员。',
  });
  await submitClarificationAnswers(taskId);

  const resumeDelegation = (await pipelineForTask(taskId))[0];
  assert.equal(resumeDelegation?.pipeline, 'resume');
  const resumed = await begin(taskId, 'resume');
  await assert.rejects(
    command(resumed.executionId, resumed.token!, ['requirement-context', 'complete']),
    /尚未查看草稿状态/,
  );
  const inherited = await command(resumed.executionId, resumed.token!, [
    'requirement-context', 'status',
  ]);
  assert.match(inherited, /草稿 v2/);
  assert.match(inherited, /export-audience：确认导出能力的目标用户 · 已回答：本轮只面向管理员/);
  assert.match(inherited, /audience-missing：当前输入没有说明导出入口面向哪些角色/);
  assert.match(inherited, /audience-must-be-confirmed：目标用户必须由用户确认/);
  await command(resumed.executionId, resumed.token!, [
    'requirement-context', 'constraint', 'add',
    '--key', 'audience-must-be-confirmed',
    '--text', '本轮导出能力只面向管理员',
  ]);
  const revised = await command(resumed.executionId, resumed.token!, ['requirement-context', 'status']);
  assert.match(revised, /约束：1/);
  assert.match(revised, /audience-must-be-confirmed：本轮导出能力只面向管理员/);
  await command(resumed.executionId, resumed.token!, ['requirement-context', 'complete']);

  const completedResult = await readAgentCommandSubmission(resumed.executionId);
  assert.equal(completedResult?.outcome, 'completed');
  assert.match(completedResult?.artifact?.content || '', /本轮只面向管理员/);
  await applyAgentResult('RUN-command-resume', resumed.delegation, completedResult!, {
    executionId: resumed.executionId,
  });
  await completeExecution(resumed.executionId);

  detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'in plan');
  assert.equal(detail?.questions.find((item) => item.question_id === question?.question_id)?.status, 'resolved');
  assert.ok(detail?.documents.some((document) =>
    document.kind === 'context' && document.content.includes('本轮只面向管理员')));
});

test('rejects commands with another execution token', async () => {
  const { createTask } = await import('./tasks');
  const firstTask = await createTask({ title: 'Token scope A' });
  const secondTask = await createTask({ title: 'Token scope B' });
  const first = await begin(firstTask);
  const second = await begin(secondTask);
  await assert.rejects(
    command(first.executionId, second.token!, ['requirement-context', 'status']),
    /命令凭证无效/,
  );
});

test('exposes the same execution-scoped protocol through the cross-platform Node CLI', async () => {
  const { createTask } = await import('./tasks');
  const taskId = await createTask({ title: 'Node CLI command surface' });
  const active = await begin(taskId);
  const env = { ...process.env } as NodeJS.ProcessEnv;
  delete env.LOOP_TEST;
  delete env.LOOP_TEST_SETUP_PID;
  delete env.NODE_TEST_CONTEXT;
  env.LOOP_EXECUTION_ID = active.executionId;
  env.LOOP_EXECUTION_TOKEN = active.token!;
  env.LOOP_APP_ROOT = process.cwd();
  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), 'scripts', 'loop', 'loop-agent.mjs'), 'requirement-context', 'status'],
    {
      cwd: process.env.LOOP_WORKSPACE_ROOT_OVERRIDE,
      env,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /需求上下文草稿 v1/);
  assert.match(result.stdout, /缺少需求目标/);

  const directory = mkdtempSync(join(tmpdir(), 'loop-agent-command-'));
  try {
    const goalPath = join(directory, 'goal.txt');
    writeFileSync(goalPath, '从 UTF-8 文件恢复一段较长的需求目标');
    const fileResult = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'loop', 'loop-agent.mjs'),
        'requirement-context', 'goal', 'set', '--text-file', goalPath,
      ],
      {
        cwd: process.env.LOOP_WORKSPACE_ROOT_OVERRIDE,
        env,
        encoding: 'utf8',
      },
    );
    assert.equal(fileResult.status, 0, fileResult.stderr);
    assert.match(fileResult.stdout, /需求目标已保存/);
    assert.match(
      await command(active.executionId, active.token!, ['requirement-context', 'status']),
      /从 UTF-8 文件恢复一段较长的需求目标/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('story splitter progressively restores, validates and submits an ordered delivery plan', async () => {
  const { getTask } = await import('./tasks');
  const { applyAgentResult } = await import('./agent-results');
  const {
    completeExecution,
    failExecution,
  } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { taskId, delegation } = await taskReadyForSplit('渐进式交付拆分');
  const first = await beginDelegation(delegation, 'delivery-plan-first');

  await assert.rejects(
    command(first.executionId, first.token!, [
      'delivery-plan', 'rationale', 'set', '--text', '按用户可独立验收的业务闭环拆分',
    ]),
    /尚未查看草稿状态/,
  );
  const initial = await command(first.executionId, first.token!, ['delivery-plan', 'status']);
  assert.match(initial, /交付计划草稿 v1/);
  assert.match(initial, /至少需要一个可独立交付/);
  await command(first.executionId, first.token!, [
    'delivery-plan', 'rationale', 'set', '--text', '按用户可独立验收的业务闭环拆分',
  ]);
  await command(first.executionId, first.token!, [
    'delivery-plan', 'coverage', 'set', '--text', '覆盖导出入口、筛选继承与 CSV 下载结果',
  ]);
  await command(first.executionId, first.token!, [
    'delivery-plan', 'unit', 'upsert',
    '--key', 'download-filtered-csv',
    '--title', '管理员下载当前筛选结果',
    '--actor', '管理员',
    '--trigger', '管理员在已有筛选条件的列表页点击导出',
    '--outcome', '浏览器下载只包含筛选命中数据的 CSV 文件',
    '--acceptance', '下载文件的记录与字段均和当前筛选结果一致',
  ]);
  await failExecution(first.executionId, '模拟 Agent 进程中断');

  const resumed = await beginDelegation(delegation, 'delivery-plan-retry');
  await assert.rejects(
    command(resumed.executionId, resumed.token!, ['delivery-plan', 'validate']),
    /尚未查看草稿状态/,
  );
  const restored = await command(resumed.executionId, resumed.token!, ['delivery-plan', 'status']);
  assert.match(restored, /交付计划草稿 v1/);
  assert.match(restored, /download-filtered-csv：管理员下载当前筛选结果/);
  await command(resumed.executionId, resumed.token!, [
    'delivery-plan', 'unit', 'upsert',
    '--key', 'configure-export-fields',
    '--title', '管理员确认导出字段',
    '--actor', '管理员',
    '--trigger', '管理员打开导出操作',
    '--outcome', '系统显示并采用当前列表可导出的字段',
    '--acceptance', '不在当前结果中的隐藏字段不会进入 CSV',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'delivery-plan', 'ordering', 'set', '--text', '先确认导出字段，再执行文件下载',
  ]);
  await command(resumed.executionId, resumed.token!, [
    'delivery-plan', 'unit', 'move', '--key', 'configure-export-fields', '--position', '1',
  ]);
  assert.equal(
    await command(resumed.executionId, resumed.token!, ['delivery-plan', 'validate']),
    '交付计划草稿结构校验通过。',
  );
  assert.match(
    await command(resumed.executionId, resumed.token!, ['delivery-plan', 'complete']),
    /提交成功/,
  );
  assert.match(
    await command(resumed.executionId, resumed.token!, ['delivery-plan', 'complete']),
    /已经提交成功/,
  );

  const result = await readAgentCommandSubmission(resumed.executionId);
  assert.deepEqual(
    result?.deliveryUnits?.map((unit) => unit.title),
    ['管理员确认导出字段', '管理员下载当前筛选结果'],
  );
  assert.match(result?.artifact?.content || '', /稳定标识：`configure-export-fields`/);
  assert.match(result?.artifact?.content || '', /先确认导出字段，再执行文件下载/);
  await applyAgentResult(`RUN-command-split-${taskId}`, delegation, result!, {
    executionId: resumed.executionId,
  });
  await completeExecution(resumed.executionId);

  const detail = await getTask(taskId);
  assert.deepEqual(
    detail?.stories.map((story) => story.title),
    ['管理员确认导出字段', '管理员下载当前筛选结果'],
  );
  assert.equal(detail?.task.current_subagent, 'analyst-agent');
  assert.equal(detail?.task.agile_status, 'ready for dev');
});

test('feedback split uses the same progressive protocol with an isolated draft', async () => {
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { taskId, delegation: splitDelegation } = await taskReadyForSplit('评论追加交付拆分');
  const feedbackDelegation: DelegationEnvelope = {
    ...splitDelegation,
    pipeline: 'feedback-split',
    description: '将范围新增评论拆为追加交付单元',
    feedbackBatchId: `FB-${taskId}`,
    feedbackGroupId: `FG-${taskId}`,
  };
  const active = await beginDelegation(feedbackDelegation, 'feedback-split');
  assert.match(
    await command(active.executionId, active.token!, ['help']),
    /delivery-plan unit upsert/,
  );
  const status = await command(active.executionId, active.token!, ['delivery-plan', 'status']);
  assert.match(status, /交付计划草稿 v1/);
  assert.doesNotMatch(status, /download-filtered-csv/);
  await command(active.executionId, active.token!, [
    'delivery-plan', 'rationale', 'set', '--text', '评论新增了一个可独立验收的业务范围',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-plan', 'coverage', 'set', '--text', '只覆盖评论要求的批量删除能力',
  ]);
  await command(active.executionId, active.token!, [
    'delivery-plan', 'unit', 'upsert',
    '--key', 'batch-delete',
    '--title', '管理员批量删除筛选结果',
    '--actor', '管理员',
    '--trigger', '管理员选择多条记录并确认删除',
    '--outcome', '选中记录被删除且列表刷新',
    '--acceptance', '仅选中记录被删除，失败项有明确提示',
  ]);
  await command(active.executionId, active.token!, ['delivery-plan', 'complete']);
  const result = await readAgentCommandSubmission(active.executionId);
  assert.deepEqual(result?.deliveryUnits, [{ title: '管理员批量删除筛选结果' }]);
});
