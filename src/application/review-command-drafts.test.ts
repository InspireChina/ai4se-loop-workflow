import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
import type { DelegationEnvelope } from './tasks';

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

async function begin(delegation: DelegationEnvelope, suffix: string) {
  const { beginExecutionAttempt } = await import('./executions');
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const started = await beginExecutionAttempt({
    runId: `RUN-review-${suffix}`,
    delegation,
    prompt: 'progressive review prompt',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { executionId: started.attempt.execution_id, token };
}

async function reviewDelegation(title: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const {
    createTask,
    pipelineForTask,
    upsertDocument,
  } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'cancelled', run_state = 'idle', current_subagent = NULL
    WHERE agile_status NOT IN ('done', 'cancelled')
  `).run();
  const taskId = await createTask({
    title,
    description: '确认现有状态映射并完成独立验证。',
  });
  db.prepare(`
    INSERT INTO stories(task_id, story_index, title, directory)
    VALUES(?, 1, '确认状态映射', 'story-001')
  `).run(taskId);
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json, resolved_at)
    VALUES(?, ?, 1, 1, 'resolved', ?, CURRENT_TIMESTAMP)
  `).run(randomUUID(), taskId, JSON.stringify(deliverySpecFixture({
    handoff: {
      implementationGuidance: '保持现有状态映射。',
      guardrails: [],
      verificationFocus: [{
        key: 'AC-1',
        expected: '完成状态正确',
        oracle: '黑盒断言通过',
      }],
    },
  })));
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'in review', current_subagent = 'review-agent',
        total_stories = 1, analysis_index = 1, dev_index = 1, test_index = 1,
        spec_resolved_index = 1, run_state = 'runnable',
        next_step = '生成结卡报告'
    WHERE task_id = ?
  `).run(taskId);
  await upsertDocument({
    taskId,
    storyIndex: 1,
    actor: 'dev-agent',
    kind: 'dev_note',
    title: '开发实现结果',
    content: '走查确认现有实现符合规格，没有生产代码变更。',
    format: 'markdown',
  });
  await upsertDocument({
    taskId,
    storyIndex: 1,
    actor: 'test-agent',
    kind: 'test_result',
    title: '验证报告',
    content: '独立测试通过。',
    format: 'markdown',
  });
  const delegation = (await pipelineForTask(taskId)).find((item) =>
    item.agent === 'review-agent' && item.pipeline === 'review');
  assert.ok(delegation);
  return { taskId, delegation: delegation! as DelegationEnvelope };
}

async function recordCompleteReport(executionId: string, token: string) {
  await command(executionId, token, [
    'review', 'title', 'set', '--text', '状态映射需求结卡报告',
  ]);
  await command(executionId, token, [
    'review', 'summary', 'set', '--text',
    '现有状态映射符合需求，未修改生产代码，独立验证通过。',
  ]);
  const sections = [
    ['outcome', '原始目标与最终结果', '用户需要确认完成状态；最终行为与预期一致。'],
    ['scope', '实际交付范围', '包含状态映射走查和独立验证；不包含新增 API。'],
    ['decisions', '关键决策与取舍', '保持现有实现，不为制造变更而修改代码。'],
    ['implementation', '实现与代码变化', '走查确认现有实现满足规格；本轮没有生产代码变化。'],
    ['verification', '验收与验证证据', 'AC-1 通过；完整测试与黑盒断言均成功。'],
    ['deviations', '偏差与妥协', '没有规格偏差或隐藏妥协。'],
    ['risks', '已知限制与后续建议', '未发现已知残余风险。'],
    ['feedback', '评论与反馈处理', '本轮没有待处理评论。'],
  ];
  for (const [kind, heading, content] of sections) {
    await command(executionId, token, [
      'review', 'section', 'upsert',
      '--kind', kind, '--heading', heading, '--content', content,
    ]);
  }
  await command(executionId, token, [
    'review', 'evidence', 'upsert',
    '--key', 'implementation-walkthrough',
    '--section', 'implementation',
    '--reference', 'DOC:development-result',
    '--claim', '开发走查记录证明现有实现满足规格且未产生代码变更',
  ]);
  await command(executionId, token, [
    'review', 'evidence', 'upsert',
    '--key', 'independent-test',
    '--section', 'verification',
    '--reference', 'DOC:verification-result',
    '--claim', '验证报告证明 AC-1 与完整测试均通过',
  ]);
}

test('review agent progressively composes a traceable report and opens closure reading', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { getTask } = await import('./tasks');
  const { taskId, delegation } = await reviewDelegation('渐进式结卡报告');
  const started = await begin(delegation, `${taskId}-complete`);

  await assert.rejects(
    command(started.executionId, started.token!, [
      'review', 'summary', 'set', '--text', '不能跳过 status',
    ]),
    /review status/,
  );
  const initial = await command(started.executionId, started.token!, ['review', 'status']);
  assert.match(initial, /结卡报告草稿 v1/);
  assert.match(initial, /章节：0\/8/);
  await recordCompleteReport(started.executionId, started.token!);
  await command(started.executionId, started.token!, ['review', 'complete']);
  const result = await readAgentCommandSubmission(started.executionId);
  assert.equal(result?.outcome, 'completed');
  assert.equal(result?.verdict, 'report_ready');
  assert.match(result?.artifact?.content || '', /## 验收与验证证据/);
  assert.match(result?.artifact?.content || '', /DOC:verification-result/);

  await applyAgentResult(`RUN-review-complete-${taskId}`, delegation, result!, {
    executionId: started.executionId,
  });
  await completeExecution(started.executionId);
  const detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'ready_to_close');
  assert.equal(detail?.task.closure_status, 'awaiting_read');
  assert.equal(detail?.task.review_revision, 1);
  assert.match(
    detail?.documents.find((item) => item.kind === 'review_v1')?.content || '',
    /状态映射需求结卡报告/,
  );
});

test('review runtime input preserves one stable key and resumes the same report draft', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const {
    answerRuntimeInput,
    getTask,
    pipelineForTask,
    submitRuntimeInputs,
  } = await import('./tasks');
  const { taskId, delegation } = await reviewDelegation('结卡运行信息恢复');
  const first = await begin(delegation, `${taskId}-input`);
  await command(first.executionId, first.token!, ['review', 'status']);
  await command(first.executionId, first.token!, [
    'review', 'summary', 'set', '--text',
    '缺少部署环境名称，无法准确记录运维注意事项。',
  ]);
  await command(first.executionId, first.token!, [
    'review', 'runtime-input', 'upsert',
    '--key', 'deployment-environment',
    '--title', '部署环境名称',
    '--question', '本次验证对应哪个非敏感环境名称？',
    '--why', '结卡报告需要准确标注验证环境',
    '--recommendation', '使用现有测试环境的公开名称',
  ]);
  await command(first.executionId, first.token!, ['review', 'request-input']);
  const pending = await readAgentCommandSubmission(first.executionId);
  assert.equal(pending?.runtimeInputs[0]?.key, 'deployment-environment');
  await applyAgentResult(`RUN-review-input-${taskId}`, delegation, pending!, {
    executionId: first.executionId,
  });
  await completeExecution(first.executionId);

  let detail = await getTask(taskId);
  const request = detail?.runtimeInputs.find((item) =>
    item.request_key === 'deployment-environment');
  assert.ok(request);
  await answerRuntimeInput({
    taskId,
    requestId: request!.request_id,
    answer: '本地测试环境。',
  });
  await submitRuntimeInputs(taskId);
  const resumedDelegation = (await pipelineForTask(taskId)).find((item) =>
    item.agent === 'review-agent')! as DelegationEnvelope;
  assert.equal(resumedDelegation.pipeline, 'resume');
  const resumed = await begin(resumedDelegation, `${taskId}-resume`);
  const restored = await command(resumed.executionId, resumed.token!, ['review', 'status']);
  assert.match(restored, /结卡报告草稿 v2/);
  assert.match(restored, /deployment-environment.*已回答=本地测试环境/);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, [
      'review', 'runtime-input', 'remove', '--key', 'deployment-environment',
    ]),
    /必须保留原 request key/,
  );
  await recordCompleteReport(resumed.executionId, resumed.token!);
  await command(resumed.executionId, resumed.token!, ['review', 'complete']);
  const completed = await readAgentCommandSubmission(resumed.executionId);
  await applyAgentResult(`RUN-review-resume-${taskId}`, resumedDelegation, completed!, {
    executionId: resumed.executionId,
  });
  await completeExecution(resumed.executionId);
  detail = await getTask(taskId);
  assert.equal(detail?.runtimeInputs.find((item) =>
    item.request_key === 'deployment-environment')?.status, 'resolved');
  assert.equal(detail?.task.agile_status, 'ready_to_close');
});
