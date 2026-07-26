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
    pipelineForTask,
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
  const delegation = (await pipelineForTask(taskId)).find((item) =>
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
  await command(executionId, token, [
    'feedback', 'summary', 'set', '--text',
    '评论要求新增可观察的空状态提示，需要形成一个向前追加的行为修订工作组',
  ]);
  await command(executionId, token, [
    'feedback', 'group', 'upsert',
    '--key', 'empty-state',
    '--type', 'behavior_change',
    '--title', '补充空状态提示',
    '--reason', '该评论改变用户可观察行为，不能改写既有交付历史',
  ]);
  await command(executionId, token, [
    'feedback', 'group', 'comment', 'add',
    '--key', 'empty-state', '--id', commentId,
  ]);
  await command(executionId, token, [
    'feedback', 'group', 'unit', 'add',
    '--key', 'empty-state', '--index', '1',
  ]);
  await command(executionId, token, [
    'feedback', 'group', 'acceptance', 'upsert',
    '--key', 'empty-state',
    '--acceptance-key', 'visible-empty-state',
    '--text', '空数据时页面展示清晰且可识别的提示',
  ]);
}

test('feedback triage progressively covers the frozen batch and appends forward work', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const { getTask } = await import('./tasks');
  const { taskId, commentId, delegation } = await completedRequirement('渐进式反馈分流');
  const started = await begin(delegation, `${taskId}-triage`);

  await assert.rejects(
    command(started.executionId, started.token!, [
      'feedback', 'summary', 'set', '--text', '不能跳过 status',
    ]),
    /feedback status/,
  );
  const initial = await command(started.executionId, started.token!, ['feedback', 'status']);
  assert.match(initial, /批次分流/);
  assert.match(initial, new RegExp(commentId));
  await recordBehaviorChange(started.executionId, started.token!, commentId);
  await command(started.executionId, started.token!, ['feedback', 'triage-complete']);

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
  const detail = await getTask(taskId);
  assert.equal(detail?.feedbackGroups[0]?.work_type, 'behavior_change');
  assert.equal(detail?.stories.length, 2);
  assert.equal(detail?.stories[1]?.origin_type, 'feedback_behavior');
});

test('feedback clarification preserves the original decision key and partial draft across resume', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { completeExecution } = await import('./executions');
  const { readAgentCommandSubmission } = await import('./agent-command-drafts');
  const {
    answerQuestion,
    getTask,
    pipelineForTask,
    submitClarificationAnswers,
  } = await import('./tasks');
  const { taskId, commentId, delegation } = await completedRequirement('反馈澄清恢复');
  const first = await begin(delegation, `${taskId}-question`);
  await command(first.executionId, first.token!, ['feedback', 'status']);
  await command(first.executionId, first.token!, [
    'feedback', 'summary', 'set', '--text',
    '评论中的适用用户范围不足以安全判断工作组边界',
  ]);
  await command(first.executionId, first.token!, [
    'feedback', 'question', 'upsert',
    '--key', 'empty-state-audience',
    '--title', '确认空状态适用范围',
    '--question', '空状态提示面向全部用户还是仅管理员？',
    '--impact', '该选择决定新增行为的用户范围',
  ]);
  await command(first.executionId, first.token!, [
    'feedback', 'question', 'option-upsert',
    '--key', 'empty-state-audience', '--id', 'all',
    '--label', '全部用户', '--consequence', '所有空数据页面统一显示提示',
  ]);
  await command(first.executionId, first.token!, [
    'feedback', 'question', 'option-upsert',
    '--key', 'empty-state-audience', '--id', 'admin',
    '--label', '仅管理员', '--consequence', '普通用户界面保持不变',
  ]);
  await command(first.executionId, first.token!, [
    'feedback', 'question', 'recommend',
    '--key', 'empty-state-audience', '--option', 'all',
    '--reason', '评论没有限定角色，统一行为更符合字面范围',
  ]);
  await command(first.executionId, first.token!, ['feedback', 'request-clarification']);
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
  const resumedDelegation = (await pipelineForTask(taskId)).find((item) =>
    item.pipeline === 'feedback-triage')! as DelegationEnvelope;
  const resumed = await begin(resumedDelegation, `${taskId}-resume`);
  const restored = await command(resumed.executionId, resumed.token!, ['feedback', 'status']);
  assert.match(restored, /反馈草稿 v2/);
  assert.match(restored, /empty-state-audience.*已回答=面向全部用户/);
  await assert.rejects(
    command(resumed.executionId, resumed.token!, [
      'feedback', 'question', 'remove', '--key', 'empty-state-audience',
    ]),
    /必须保留原 decision key/,
  );
  await recordBehaviorChange(resumed.executionId, resumed.token!, commentId);
  await command(resumed.executionId, resumed.token!, ['feedback', 'triage-complete']);
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
  const { getTask, pipelineForTask } = await import('./tasks');
  const { recordFeedbackUnitTestPassed } = await import('./feedback');
  const { taskId, commentId, delegation } = await completedRequirement('渐进式反馈验证');
  const triage = await begin(delegation, `${taskId}-triage`);
  await command(triage.executionId, triage.token!, ['feedback', 'status']);
  await recordBehaviorChange(triage.executionId, triage.token!, commentId);
  await command(triage.executionId, triage.token!, ['feedback', 'triage-complete']);
  const triageResult = await readAgentCommandSubmission(triage.executionId);
  await applyAgentResult(`RUN-feedback-verify-triage-${taskId}`, delegation, triageResult!, {
    executionId: triage.executionId,
  });
  await completeExecution(triage.executionId);

  const db = await databaseConnection();
  db.prepare(`
    UPDATE tasks
    SET analysis_index = 2, dev_index = 2, test_index = 2, spec_resolved_index = 2,
        current_subagent = 'feedback-agent', run_state = 'runnable'
    WHERE task_id = ?
  `).run(taskId);
  await recordFeedbackUnitTestPassed({ taskId, storyIndex: 2 });
  const verifyDelegation = (await pipelineForTask(taskId)).find((item) =>
    item.pipeline === 'feedback-verify')! as DelegationEnvelope;
  assert.ok(verifyDelegation);
  const verify = await begin(verifyDelegation, `${taskId}-verify`);
  const status = await command(verify.executionId, verify.token!, ['feedback', 'status']);
  assert.match(status, /独立验证/);
  assert.match(status, new RegExp(commentId));
  await command(verify.executionId, verify.token!, [
    'feedback', 'summary', 'set', '--text',
    '新增空状态提示已经实现，并由交付单元独立测试证明',
  ]);
  await command(verify.executionId, verify.token!, [
    'feedback', 'verification', 'reason', 'set', '--text',
    '评论要求的用户可观察结果已经存在，且没有改写既有交付历史',
  ]);
  await command(verify.executionId, verify.token!, [
    'feedback', 'evidence', 'upsert',
    '--key', 'unit-2-test',
    '--text', '交付单元 2 的 Test 结果通过，页面空数据场景展示明确提示',
  ]);
  await command(verify.executionId, verify.token!, ['feedback', 'resolve']);
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
