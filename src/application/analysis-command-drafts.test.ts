import assert from 'node:assert/strict';
import test from 'node:test';
import type { DelegationEnvelope } from './tasks';

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

async function begin(delegation: DelegationEnvelope, suffix: string) {
  const { beginExecutionAttempt } = await import('./executions');
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const started = await beginExecutionAttempt({
    runId: `RUN-analysis-${suffix}`,
    delegation,
    prompt: 'progressive analysis prompt',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { executionId: started.attempt.execution_id, token };
}

async function analysisDelegation(title: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, pipelineForTask } = await import('./tasks');
  const taskId = await createTask({
    title,
    description: '导出完成后用户需要选择下载 CSV，或在页面直接查看结果。',
  });
  const db = await databaseConnection();
  db.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET item_type = 'feature', agile_status = 'ready for dev',
          current_subagent = 'analyst-agent', total_stories = 1,
          analysis_index = 0, dev_index = 0, test_index = 0,
          next_step = '分析导出结果呈现方式'
      WHERE task_id = ?
    `).run(taskId);
    db.prepare(`
      INSERT INTO stories(task_id, story_index, title, directory)
      VALUES(?, 1, '用户获得可用的导出结果', 'story-001')
    `).run(taskId);
  })();
  const delegation = (await pipelineForTask(taskId)).find((item) =>
    item.agent === 'analyst-agent' && item.storyIndex === 1);
  assert.ok(delegation);
  return { taskId, delegation: delegation! as DelegationEnvelope };
}

async function recordAnalysisDraft(executionId: string, token: string) {
  await command(executionId, token, [
    'analysis', 'goal', 'set', '--text',
    '用户完成导出后获得一种明确、可验证的结果呈现方式',
  ]);
  await command(executionId, token, [
    'analysis', 'scope', 'upsert', '--key', 'export-result',
    '--direction', 'included', '--content', '导出完成后的结果呈现与下载入口',
  ]);
  await command(executionId, token, [
    'analysis', 'scope', 'upsert', '--key', 'export-engine',
    '--direction', 'excluded', '--content', '不改造底层导出计算与任务调度',
  ]);
  await command(executionId, token, [
    'analysis', 'behavior', 'upsert', '--key', 'completed-export',
    '--scenario', '用户的导出任务成功完成',
    '--expected', '页面按已确认模式提供可识别且可使用的导出结果',
  ]);
  await command(executionId, token, [
    'analysis', 'decision', 'upsert', '--key', 'output-mode',
    '--title', '选择结果呈现模式',
    '--question', '导出成功后应直接下载 CSV，还是在页面展示结果？',
    '--impact', '决定用户可观察流程、前端边界与验收方式',
  ]);
  await command(executionId, token, [
    'analysis', 'decision', 'option-upsert', '--key', 'output-mode',
    '--id', 'download', '--label', '下载 CSV',
    '--consequence', '保留文件型交付，并需要可访问的下载入口',
  ]);
  await command(executionId, token, [
    'analysis', 'decision', 'option-upsert', '--key', 'output-mode',
    '--id', 'inline', '--label', '页面内展示',
    '--consequence', '增加结果渲染和大数据量分页边界',
  ]);
  await command(executionId, token, [
    'analysis', 'decision', 'recommend', '--key', 'output-mode',
    '--option', 'download', '--reason', '现有交付单元聚焦导出结果，文件下载改动更窄',
  ]);
  await command(executionId, token, [
    'analysis', 'criterion', 'upsert', '--key', 'AC-download',
    '--description', '导出完成后按用户确认的模式提供结果',
    '--oracle', '结果入口的可见行为与已确认模式一致',
  ]);
  await command(executionId, token, [
    'analysis', 'verification', 'upsert', '--key', 'verify-download',
    '--criterion', 'AC-download', '--kind', 'browser',
    '--instruction', '在浏览器完成一次导出并检查结果入口',
  ]);
  await command(executionId, token, [
    'analysis', 'budget', 'upsert', '--key', 'result-capability',
    '--kind', 'capability', '--content', '只调整导出完成后的结果交付能力',
  ]);
  await command(executionId, token, [
    'analysis', 'budget', 'upsert', '--key', 'result-ui-path',
    '--kind', 'path', '--content', '导出结果页面及其应用服务',
  ]);
}

test('analysis agent persists an unresolved spec, consumes the answer on the same key, and completes', async () => {
  const {
    answerQuestion,
    getTask,
    pipelineForTask,
    submitClarificationAnswers,
  } = await import('./tasks');
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { taskId, delegation } = await analysisDelegation('渐进式方案分析');
  const first = await begin(delegation, `${taskId}-first`);

  await assert.rejects(
    command(first.executionId, first.token!, [
      'analysis', 'goal', 'set', '--text', '不能跳过 status',
    ]),
    /analysis status/,
  );
  assert.match(
    await command(first.executionId, first.token!, ['analysis', 'status']),
    /方案规格草稿 v1/,
  );
  await recordAnalysisDraft(first.executionId, first.token!);
  assert.equal(
    await command(first.executionId, first.token!, ['analysis', 'validate']),
    '方案规格草稿结构校验通过。',
  );
  await command(first.executionId, first.token!, ['analysis', 'request-clarification']);
  const pending = await readAgentCommandSubmission(first.executionId);
  assert.equal(pending?.outcome, 'needs_input');
  assert.equal(pending?.questions[0]?.decisionKey, 'output-mode');
  assert.equal(pending?.spec?.ambiguities[0]?.key, 'output-mode');
  await applyAgentResult(`RUN-analysis-pending-${taskId}`, delegation, pending!, {
    executionId: first.executionId,
  });
  await completeExecution(first.executionId);

  let detail = await getTask(taskId);
  const question = detail?.questions.find((item) => item.decision_key === 'output-mode');
  assert.equal(detail?.storySpecs[0]?.status, 'waiting_for_answers');
  assert.ok(question);
  await answerQuestion({
    taskId,
    questionId: question!.question_id,
    answer: '使用下载 CSV；不要在页面渲染完整结果。',
  });
  await submitClarificationAnswers(taskId);

  const resumedDelegation = (await pipelineForTask(taskId)).find((item) =>
    item.agent === 'analyst-agent' && item.pipeline === 'resume')! as DelegationEnvelope;
  assert.ok(resumedDelegation);
  const resumed = await begin(resumedDelegation, `${taskId}-resume`);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, ['analysis', 'complete']),
    /analysis status/,
  );
  const restored = await command(resumed.executionId, resumed.token!, ['analysis', 'status']);
  assert.match(restored, /方案规格草稿 v2/);
  assert.match(restored, /output-mode.*已回答=使用下载 CSV/);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, [
      'analysis', 'decision', 'remove', '--key', 'output-mode',
    ]),
    /必须保留原 decision key/,
  );
  await command(resumed.executionId, resumed.token!, [
    'analysis', 'decision', 'resolve', '--key', 'output-mode',
    '--option', 'download', '--source', 'user',
    '--decision', '导出完成后提供 CSV 下载，不在页面渲染完整结果',
    '--rationale', '用户明确选择文件型结果并排除页面内完整展示',
    '--evidence', '人工回答：使用下载 CSV；不要在页面渲染完整结果。',
  ]);
  assert.equal(
    await command(resumed.executionId, resumed.token!, ['analysis', 'validate']),
    '方案规格草稿结构校验通过。',
  );
  await command(resumed.executionId, resumed.token!, ['analysis', 'complete']);
  const completed = await readAgentCommandSubmission(resumed.executionId);
  assert.equal(completed?.outcome, 'completed');
  assert.equal(completed?.questions.length, 0);
  assert.equal(completed?.spec?.decisions[0]?.key, 'output-mode');
  const resolvedDecision = completed?.spec?.decisionTree[0];
  assert.equal(resolvedDecision?.status, 'resolved_from_context');
  assert.equal(
    resolvedDecision?.status === 'resolved_from_context' ? resolvedDecision.selectedOption : null,
    'download',
  );
  await applyAgentResult(`RUN-analysis-completed-${taskId}`, resumedDelegation, completed!, {
    executionId: resumed.executionId,
  });
  await completeExecution(resumed.executionId);

  detail = await getTask(taskId);
  assert.deepEqual(
    detail?.storySpecs.map((spec) => [spec.revision, spec.status]),
    [[1, 'superseded'], [2, 'resolved']],
  );
  assert.equal(detail?.task.analysis_index, 1);
  assert.notEqual(detail?.lanes.find((lane) => lane.lane === 'analysis')?.status, 'waiting_for_answers');
});

test('analysis work keys isolate delivery units while resume keeps the same draft identity', async () => {
  const { agentCommandWorkKey } = await import('../domain/agent-command-profile');
  assert.equal(
    agentCommandWorkKey('analyst-agent', 'analysis', 'REQ-1', 2, 'analysis:2'),
    'analysis:REQ-1:2',
  );
  assert.equal(
    agentCommandWorkKey('analyst-agent', 'resume', 'REQ-1', 2, 'resume:analysis:2'),
    'analysis:REQ-1:2',
  );
  assert.equal(
    agentCommandWorkKey('analyst-agent', 'analysis', 'REQ-1', 3, 'analysis:3'),
    'analysis:REQ-1:3',
  );
});
