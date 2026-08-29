import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectAllDispatch, inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { stringify } from 'yaml';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
import type { DelegationEnvelope } from './tasks';

async function command(executionId: string, token: string, args: string[]) {
  const { runAgentCommand } = await import('./agent-command-drafts');
  return runAgentCommand({ executionId, token, args });
}

async function begin(delegation: DelegationEnvelope, suffix: string) {
  const { issueAgentCommandToken } = await import('./agent-command-drafts');
  const started = await beginTestExecutionAttempt({
    runId: `RUN-feedback-${suffix}`,
    delegation,
    prompt: 'progressive feedback prompt',
  });
  const token = await issueAgentCommandToken(started.attempt.execution_id);
  assert.ok(token);
  return { executionId: started.attempt.execution_id, token };
}

async function completedRequirement(label: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const {
    addDocumentComment,
    createTask,
    upsertDocument,
  } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'cancelled', run_state = 'idle', current_subagent = NULL
    WHERE agile_status NOT IN ('done', 'cancelled')
  `).run();
  const taskId = await createTask({ title: `${label} · ${randomUUID()}` });
  db.prepare(`
    INSERT INTO stories(task_id, story_index, title, directory)
    VALUES(?, 1, '既有交付单元', 'story-001')
  `).run(taskId);
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json, resolved_at)
    VALUES(?, ?, 1, 1, 'resolved', ?, CURRENT_TIMESTAMP)
  `).run(randomUUID(), taskId, JSON.stringify(deliverySpecFixture()));
  db.prepare(`
    UPDATE tasks
    SET total_stories = 1, analysis_index = 1, dev_index = 1,
        test_index = 1, spec_resolved_index = 1
    WHERE task_id = ?
  `).run(taskId);
  const documentId = await upsertDocument({
    taskId,
    storyIndex: 1,
    actor: 'test-agent',
    kind: 'test_result',
    title: '既有交付证据',
    content: '既有交付单元已经实现并验证。',
    format: 'markdown',
  });
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'ready_to_close', current_subagent = NULL,
        analysis_index = 1, dev_index = 1, test_index = 1,
        total_stories = 1, spec_resolved_index = 1,
        run_state = 'idle', closure_status = 'awaiting_read',
        review_revision = 1, review_document_id = ?,
        next_step = '等待用户阅读'
    WHERE task_id = ?
  `).run(documentId, taskId);
  const commentId = await addDocumentComment({
    taskId,
    documentId,
    anchorType: 'file',
    content: '空数据时需要显示明确提示。',
    intent: 'change_request',
  });
  const delegation = (await inspectTaskDispatch(taskId)).find((item) =>
    item.pipeline === 'feedback-triage');
  assert.ok(delegation);
  return {
    taskId,
    commentId,
    delegation: delegation! as DelegationEnvelope,
  };
}

async function recordBehaviorChange(
  executionId: string,
  token: string,
  commentId: string,
) {
  await command(executionId, token, ['artifact', 'put', '--artifact', 'feedback', '--block', 'summary', '--content',
    '评论要求新增可观察的空状态提示，需要形成一个向前追加的行为修订工作组']);
  await command(executionId, token, ['artifact', 'put', '--artifact', 'feedback', '--block', 'groups', '--key', 'empty-state', '--content', stringify({
    workType: 'behavior_change', title: '补充空状态提示',
    reason: '该评论改变用户可观察行为，不能改写既有交付历史',
    commentIds: [commentId], affectedDeliveryUnits: [1],
    acceptance: ['空数据时页面展示清晰且可识别的提示'],
  }).trim()]);
}

async function advanceFeedbackTriageToGrouping(executionId: string, token: string) {
  await command(executionId, token, ['phase', 'complete']);
  await command(executionId, token, ['phase', 'complete']);
  await command(executionId, token, ['phase', 'complete']);
  await command(executionId, token, ['artifact', 'put', '--artifact', 'feedback', '--block', 'answer-review', '--content', '本批次没有需要用户澄清的歧义。']);
  await command(executionId, token, ['phase', 'complete']);
}

async function finishFeedbackTriage(executionId: string, token: string) {
  await command(executionId, token, ['phase', 'complete']);
  await command(executionId, token, ['phase', 'complete']);
}

async function planBehaviorChange(taskId: string) {
  const { databaseConnection } = await import('../infrastructure/database');
  const { applyFeedbackSplitResult } = await import('./feedback');
  const split = (await inspectTaskDispatch(taskId)).find((item) =>
    item.pipeline === 'feedback-split') as DelegationEnvelope | undefined;
  assert.ok(split?.feedbackBatchId);
  assert.ok(split?.feedbackGroupId);
  const db = await databaseConnection();
  const draftId = `DRAFT-feedback-plan-${randomUUID()}`;
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id, agent,
      status, terminal_action, submitted_at, command_chain_id
    ) VALUES(?, ?, 1, 'delivery_plan', ?, 'story-splitter-agent',
      'submitted', 'complete', CURRENT_TIMESTAMP, 'delivery-plan')
  `).run(draftId, `delivery-plan:${taskId}:feedback-split:${split.feedbackGroupId}`, taskId);
  await applyFeedbackSplitResult({
    taskId,
    batchId: split.feedbackBatchId!,
    groupId: split.feedbackGroupId!,
    sourceCommandChainDraftId: draftId,
    deliveryUnits: [{
      key: 'feedback-empty-state',
      title: '补充空状态提示',
      actor: '页面用户',
      trigger: '页面用户进入没有数据的页面',
      observableOutcome: '页面展示清晰且可识别的空状态提示',
      acceptance: '用户可以从真实页面观察到空状态提示',
      sourceRefs: [{
        key: 'change:feedback:empty-state',
        kind: 'change',
        content: '补充空状态提示',
        sourceRef: `FEEDBACK_GROUP:${split.feedbackGroupId}`,
      }, {
        key: 'acceptance:feedback:empty-state:1',
        kind: 'acceptance',
        content: '空数据时页面展示清晰且可识别的提示',
        sourceRef: `FEEDBACK_GROUP:${split.feedbackGroupId}`,
      }],
      dependsOn: [],
    }],
  });
}

test('feedback triage progressively covers the frozen batch and appends forward work', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { getTask } = await import('./tasks');
  const { taskId, commentId, delegation } = await completedRequirement('渐进式反馈分流');
  const started = await begin(delegation, `${taskId}-triage`);

  await assert.rejects(
    command(started.executionId, started.token!, ['artifact', 'put', '--artifact', 'feedback', '--block', 'summary', '--content', '不能跳过 status']),
    /先执行 status/,
  );
  const initial = await command(started.executionId, started.token!, ['status']);
  assert.match(initial, /FROZEN FEEDBACK BATCH/);
  assert.match(initial, new RegExp(commentId));
  await advanceFeedbackTriageToGrouping(started.executionId, started.token!);
  await recordBehaviorChange(started.executionId, started.token!, commentId);
  await finishFeedbackTriage(started.executionId, started.token!);

  const result = await readAgentCommandSubmission(started.executionId);
  assert.equal(result?.outcome, 'completed');
  assert.equal(result?.feedback?.mode, 'triage');
  if (result?.feedback?.mode === 'triage') {
    assert.equal(result.feedback.groups[0]?.groupKey, 'empty-state');
    assert.deepEqual(result.feedback.groups[0]?.commentIds, [commentId]);
    assert.deepEqual(result.feedback.groups[0]?.acceptance, ['空数据时页面展示清晰且可识别的提示']);
  }
  await applyAgentResult(`RUN-feedback-triage-${taskId}`, delegation, result!, {
    executionId: started.executionId,
  });
  await completeExecution(started.executionId);
  let detail = await getTask(taskId);
  assert.equal(detail?.feedbackGroups[0]?.work_type, 'behavior_change');
  assert.equal(detail?.feedbackGroups[0]?.status, 'waiting_for_plan');
  assert.equal(detail?.stories.length, 1);
  await planBehaviorChange(taskId);
  detail = await getTask(taskId);
  assert.equal(detail?.stories.length, 2);
  assert.equal(detail?.stories[1]?.origin_type, 'feedback_behavior');
  assert.equal(detail?.stories[1]?.unit_key, 'feedback-empty-state');
});

test('feedback clarification preserves the original decision key and partial draft across resume', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const {
    answerQuestion,
    getTask,
    submitClarificationAnswers,
  } = await import('./tasks');
  const { taskId, commentId, delegation } = await completedRequirement('反馈澄清恢复');
  const first = await begin(delegation, `${taskId}-question`);
  await command(first.executionId, first.token!, ['status']);
  await command(first.executionId, first.token!, ['phase', 'complete']);
  await command(first.executionId, first.token!, ['decision', 'put', '--tree', 'decisions', '--key', 'empty-state-audience', '--content', stringify({
    type: 'business', title: '确认空状态适用范围', question: '空状态提示面向全部用户还是仅管理员？',
    impact: '该选择决定新增行为的用户范围',
    options: [
      { id: 'all', label: '全部用户', consequence: '所有空数据页面统一显示提示' },
      { id: 'admin', label: '仅管理员', consequence: '普通用户界面保持不变' },
    ],
    recommendation: { option: 'all', reason: '评论没有限定角色，统一行为更符合字面范围', authority: 'user' },
    dependencies: [],
  }).trim()]);
  await command(first.executionId, first.token!, ['phase', 'complete']);
  await command(first.executionId, first.token!, ['decision', 'ask', '--tree', 'decisions', '--key', 'empty-state-audience']);
  await command(first.executionId, first.token!, ['phase', 'complete']);
  const pending = await readAgentCommandSubmission(first.executionId);
  assert.equal(pending?.questions[0]?.decisionKey, 'empty-state-audience');
  await applyAgentResult(`RUN-feedback-question-${taskId}`, delegation, pending!, {
    executionId: first.executionId,
  });
  await completeExecution(first.executionId);

  let detail = await getTask(taskId);
  const question = detail?.questions.find((item) =>
    item.decision_key === 'empty-state-audience');
  assert.ok(question);
  await answerQuestion({
    taskId,
    questionId: question!.question_id,
    answer: '面向全部用户。',
  });
  await submitClarificationAnswers(taskId);
  const resumedDelegation = (await inspectTaskDispatch(taskId)).find((item) =>
    item.pipeline === 'feedback-triage')! as DelegationEnvelope;
  const resumed = await begin(resumedDelegation, `${taskId}-resume`);
  const restored = await command(resumed.executionId, resumed.token!, ['status']);
  assert.match(restored, /Draft: v2/);
  assert.match(restored, /empty-state-audience.*answered=面向全部用户/);
  await command(resumed.executionId, resumed.token!, ['decision', 'resolve', '--tree', 'decisions', '--key', 'empty-state-audience',
    '--option', 'all', '--authority', 'user', '--decision', '面向全部用户', '--rationale', '用户明确回答', '--evidence', '用户答案']);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, ['decision', 'remove', '--tree', 'decisions', '--key', 'empty-state-audience']),
    /不属于当前 clarification_resolution 工作包/,
  );
  await command(resumed.executionId, resumed.token!, ['phase', 'complete']);
  await command(resumed.executionId, resumed.token!, ['artifact', 'put', '--artifact', 'feedback', '--block', 'answer-review', '--content', '用户确认空状态面向全部用户，分组按该范围登记。']);
  await command(resumed.executionId, resumed.token!, ['phase', 'complete']);
  await recordBehaviorChange(resumed.executionId, resumed.token!, commentId);
  await finishFeedbackTriage(resumed.executionId, resumed.token!);
  const completed = await readAgentCommandSubmission(resumed.executionId);
  await applyAgentResult(`RUN-feedback-resume-${taskId}`, resumedDelegation, completed!, {
    executionId: resumed.executionId,
  });
  await completeExecution(resumed.executionId);
  detail = await getTask(taskId);
  assert.equal(detail?.questions.find((item) =>
    item.decision_key === 'empty-state-audience')?.status, 'resolved');
  assert.equal(detail?.feedbackGroups.length, 1);
});

test('feedback verify progressively records independent evidence and resolves only the target comment', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { databaseConnection } = await import('../infrastructure/database');
  const { getTask } = await import('./tasks');
  const { recordFeedbackUnitTestPassed } = await import('./feedback');
  const { taskId, commentId, delegation } = await completedRequirement('渐进式反馈验证');
  const triage = await begin(delegation, `${taskId}-triage`);
  await command(triage.executionId, triage.token!, ['status']);
  await advanceFeedbackTriageToGrouping(triage.executionId, triage.token!);
  await recordBehaviorChange(triage.executionId, triage.token!, commentId);
  await finishFeedbackTriage(triage.executionId, triage.token!);
  const triageResult = await readAgentCommandSubmission(triage.executionId);
  await applyAgentResult(`RUN-feedback-verify-triage-${taskId}`, delegation, triageResult!, {
    executionId: triage.executionId,
  });
  await completeExecution(triage.executionId);
  await planBehaviorChange(taskId);

  const db = await databaseConnection();
  db.prepare(`
    UPDATE tasks
    SET analysis_index = 2, dev_index = 2, test_index = 2, spec_resolved_index = 2,
        current_subagent = 'feedback-agent', run_state = 'runnable'
    WHERE task_id = ?
  `).run(taskId);
  await recordFeedbackUnitTestPassed({ taskId, storyIndex: 2 });
  const verifyDelegation = (await inspectTaskDispatch(taskId)).find((item) =>
    item.pipeline === 'feedback-verify')! as DelegationEnvelope;
  assert.ok(verifyDelegation);
  const verify = await begin(verifyDelegation, `${taskId}-verify`);
  const status = await command(verify.executionId, verify.token!, ['status']);
  assert.match(status, /FROZEN FEEDBACK TARGET/);
  assert.match(status, new RegExp(commentId));
  await command(verify.executionId, verify.token!, ['phase', 'complete']);
  await command(verify.executionId, verify.token!, ['artifact', 'put', '--artifact', 'feedback', '--block', 'summary', '--content',
    '新增空状态提示已经实现，并由交付单元独立测试证明']);
  await command(verify.executionId, verify.token!, ['artifact', 'put', '--artifact', 'feedback', '--block', 'evidence', '--key', 'unit-2-test', '--content',
    '交付单元 2 的 Test 结果通过，页面空数据场景展示明确提示']);
  await command(verify.executionId, verify.token!, ['artifact', 'put', '--artifact', 'feedback', '--block', 'conclusion', '--content', stringify({
    verdict: 'resolved', reason: '评论要求的用户可观察结果已经存在，且没有改写既有交付历史',
  }).trim()]);
  await command(verify.executionId, verify.token!, ['phase', 'complete']);
  await command(verify.executionId, verify.token!, ['phase', 'complete']);
  const verifyResult = await readAgentCommandSubmission(verify.executionId);
  assert.equal(verifyResult?.feedback?.mode, 'verify');
  if (verifyResult?.feedback?.mode === 'verify') {
    assert.equal(verifyResult.feedback.commentId, commentId);
    assert.equal(verifyResult.feedback.verdict, 'resolved');
    assert.equal(verifyResult.feedback.evidence.length, 1);
  }
  await applyAgentResult(`RUN-feedback-verify-${taskId}`, verifyDelegation, verifyResult!, {
    executionId: verify.executionId,
  });
  await completeExecution(verify.executionId);
  const detail = await getTask(taskId);
  assert.equal(detail?.documentComments.find((item) =>
    item.comment_id === commentId)?.feedback_status, 'resolved');
  assert.equal(detail?.feedbackGroups[0]?.status, 'completed');
  assert.equal(detail?.task.agile_status, 'in review');
});
