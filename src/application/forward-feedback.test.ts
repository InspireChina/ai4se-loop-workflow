import { beginTestExecutionAttempt } from '../test/execution-fixtures';
import { inspectAllDispatch, inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
import { randomUUID } from 'node:crypto';
import { parseAgentResult } from '../domain/agent-result';
import { databaseConnection } from '../infrastructure/database';
import {
  addDocumentComment,
  cancelTask,
  createTask,
  getTask,
  releaseBlock,
  upsertDocument,
  type DelegationEnvelope,
} from './tasks';
import { applyAgentResult, applyNextQueuedAgentResult, blockDelegation } from './agent-results';
import { applyFeedbackSplitResult } from './feedback';

async function completedRequirement(label: string, options: { readyToClose?: boolean } = {}) {
  const taskId = await createTask({ title: `前向反馈验证 · ${label} · ${randomUUID()}` });
  const db = await databaseConnection();
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
    SET total_stories = 1, analysis_index = 1, dev_index = 1, test_index = 1, spec_resolved_index = 1
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
    SET agile_status = ?, current_subagent = ?, analysis_index = 1, dev_index = 1,
        test_index = 1, total_stories = 1, spec_resolved_index = 1,
        run_state = ?, closure_status = ?, review_revision = ?,
        review_document_id = CASE WHEN ? THEN ? ELSE NULL END,
        next_step = '既有交付完成'
    WHERE task_id = ?
  `).run(
    options.readyToClose ? 'ready_to_close' : 'in review',
    options.readyToClose ? null : 'review-agent',
    options.readyToClose ? 'idle' : 'runnable',
    options.readyToClose ? 'awaiting_read' : 'none',
    options.readyToClose ? 1 : 0,
    options.readyToClose ? 1 : 0,
    documentId,
    taskId,
  );
  return { taskId, documentId };
}

async function comment(taskId: string, documentId: string, content: string) {
  return addDocumentComment({
    taskId,
    documentId,
    anchorType: 'file',
    content,
    intent: 'change_request',
  });
}

function result(value: Record<string, unknown>) {
  return parseAgentResult(JSON.stringify(value));
}

function plannedUnit(key: string, title: string, sourceKeys: string[] = [`change:${key}`]) {
  return {
    key,
    title,
    actor: '管理员',
    trigger: '管理员发起对应操作',
    observableOutcome: `${title}完成并产生可观察结果`,
    acceptance: `${title}可以独立验收`,
    sourceRefs: sourceKeys.map((sourceKey) => ({
      key: sourceKey,
      kind: sourceKey.startsWith('acceptance:') ? 'acceptance' as const : 'change' as const,
      content: title,
      sourceRef: `TEST:${sourceKey}`,
    })),
    dependsOn: [],
  };
}

async function applyNextFeedbackPlan(
  taskId: string,
  units: ReturnType<typeof plannedUnit>[],
) {
  const split = await delegation(taskId, 'feedback-split');
  assert.ok(split.feedbackBatchId);
  assert.ok(split.feedbackGroupId);
  const db = await databaseConnection();
  const draftId = `DRAFT-feedback-split-${randomUUID()}`;
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id, agent,
      status, terminal_action, submitted_at, command_chain_id
    ) VALUES(?, ?, 1, 'delivery_plan', ?, 'story-splitter-agent',
      'submitted', 'complete', CURRENT_TIMESTAMP, 'delivery-plan')
  `).run(draftId, `delivery-plan:${taskId}:feedback-split:${split.feedbackGroupId}`, taskId);
  await applyFeedbackSplitResult({
    taskId,
    batchId: split.feedbackBatchId,
    groupId: split.feedbackGroupId,
    deliveryUnits: units,
    sourceCommandChainDraftId: draftId,
  });
  return split;
}

async function delegation(taskId: string, pipeline?: string) {
  const lines = await inspectTaskDispatch(taskId);
  const line = lines.find((item) => !pipeline || item.pipeline === pipeline);
  assert.ok(line, `缺少预期派发：${pipeline || '任意'}`);
  const detail = await getTask(taskId);
  assert.ok(detail);
  return {
    ...line,
    title: detail.task.title,
    taskDescription: detail.task.description,
    itemType: detail.task.item_type,
    priority: detail.task.priority || '',
    link: detail.task.link || '',
    externalId: detail.task.external_id || '',
    externalStatus: detail.task.external_status || '',
    agileStatus: detail.task.agile_status,
    currentSubagent: detail.task.current_subagent || '',
    resumePending: detail.task.resume_pending,
    specResolvedIndex: detail.task.spec_resolved_index,
    runState: detail.task.run_state,
    closureStatus: detail.task.closure_status,
    reviewRevision: detail.task.review_revision,
    reviewDocumentId: detail.task.review_document_id || '',
    lastActor: detail.task.last_actor || '',
    analysisIndex: detail.task.analysis_index,
    devIndex: detail.task.dev_index,
    testIndex: detail.task.test_index,
    totalStories: detail.task.total_stories,
    nextStep: detail.task.next_step || '',
    blockedReason: detail.task.blocked_reason || '',
    owner: detail.task.owner || '',
    evidence: detail.task.evidence || '',
    risk: detail.task.risk || '',
  } as DelegationEnvelope;
}

const resolvedSpec = deliverySpecFixture({
  decisions: [{
    key: 'feedback-unit-boundary',
    type: 'business',
    title: '反馈单元边界',
    question: '如何承载反馈修订？',
    impact: '决定是否改写历史交付',
    options: [
      { id: 'append', label: '追加交付单元', consequences: ['历史保持不变'] },
      { id: 'rewrite', label: '改写旧单元', consequences: ['历史语义会漂移'] },
    ],
    status: 'resolved',
    selectedOption: 'append',
    authority: 'user',
    decision: '只追加新的交付单元',
    rationale: '保留既有交付历史',
    evidence: '用户确认只使用向前追加流程',
  }],
  handoff: {
    implementationGuidance: '以向前追加单元处理反馈。',
    guardrails: [],
    verificationFocus: [{ key: 'AC-FB', expected: '反馈行为有效', oracle: '自动化验证通过' }],
  },
});

test('行为修订只追加新交付单元，并经过 Analysis、Dev、Test 和独立反馈验证', async () => {
  const { taskId, documentId } = await completedRequirement('行为修订');
  const commentId = await comment(taskId, documentId, '增加明确的空状态提示。');
  const triage = await delegation(taskId, 'feedback-triage');
  assert.equal(triage.feedbackIds?.[0], commentId);
  await applyAgentResult(`run-${randomUUID()}`, triage, result({
    outcome: 'completed',
    summary: '形成一个行为修订工作组。',
    feedback: {
      mode: 'triage',
      groups: [{
        groupKey: 'empty-state',
        commentIds: [commentId],
        workType: 'behavior_change',
        title: '补充空状态提示',
        affectedDeliveryUnits: [1],
        reason: '需要改变用户可观察行为。',
        acceptance: ['空数据时展示清晰提示'],
      }],
    },
  }));

  let detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'in feedback');
  assert.equal(detail?.stories.length, 1, 'Feedback Triage 不应直接写入残缺交付单元');
  assert.equal(detail?.feedbackGroups[0]?.status, 'waiting_for_plan');
  await applyNextFeedbackPlan(taskId, [
    plannedUnit('feedback-empty-state', '补充空状态提示', [
      'change:feedback:empty-state',
      'acceptance:feedback:empty-state:1',
    ]),
  ]);
  detail = await getTask(taskId);
  assert.equal(detail?.stories.length, 2);
  assert.equal(detail?.stories[0].origin_type, 'original');
  assert.equal(detail?.stories[1].origin_type, 'feedback_behavior');
  assert.equal(detail?.stories[1].unit_key, 'feedback-empty-state');
  assert.equal(detail?.stories[1].actor, '管理员');
  assert.match(detail?.stories[1].trigger_condition || '', /发起对应操作/);
  assert.match(detail?.stories[1].observable_outcome || '', /可观察结果/);
  assert.match(detail?.stories[1].acceptance || '', /独立验收/);
  assert.deepEqual(
    [detail?.task.analysis_index, detail?.task.dev_index, detail?.task.test_index],
    [1, 1, 1],
    '既有交付游标不能回退',
  );

  const analysis = await delegation(taskId, 'analysis');
  assert.equal(analysis.storyIndex, 2);
  await applyAgentResult(`run-${randomUUID()}`, analysis, result({
    outcome: 'completed',
    summary: '完成反馈单元规格。',
    artifact: { title: '反馈单元分析', content: '只定义新增修订，不改写旧规格。' },
    spec: resolvedSpec,
  }));
  const dev = await delegation(taskId, 'dev');
  await applyAgentResult(`run-${randomUUID()}`, dev, result({
    outcome: 'completed',
    summary: '实现空状态提示。',
    changedFiles: ['src/empty-state.ts'],
    tests: [{ command: 'npm test', passed: true, summary: '开发自测通过' }],
  }));
  const verifyUnit = await delegation(taskId, 'test');
  await applyAgentResult(`run-${randomUUID()}`, verifyUnit, result({
    outcome: 'completed',
    summary: '反馈单元验证通过。',
    verdict: 'passed',
    tests: [{ command: 'npm test', passed: true, summary: '通过' }],
  }));

  const feedbackVerify = await delegation(taskId, 'feedback-verify');
  await applyAgentResult(`run-${randomUUID()}`, feedbackVerify, result({
    outcome: 'completed',
    summary: '评论已由新增单元满足。',
    feedback: {
      mode: 'verify',
      commentId,
      verdict: 'resolved',
      reason: '新增单元已通过测试。',
      evidence: ['交付单元 2 Test 结果通过'],
    },
  }));
  detail = await getTask(taskId);
  assert.equal(detail?.documentComments[0].status, 'resolved');
  assert.equal(detail?.feedbackGroups[0].status, 'completed');
  assert.equal(detail?.task.agile_status, 'in review');
});

test('反馈交付规划解除系统阻塞后重新派发 feedback-split 而不是 resume', async () => {
  const { taskId, documentId } = await completedRequirement('反馈规划系统阻塞恢复');
  const commentId = await comment(taskId, documentId, '增加批量归档能力。');
  const triage = await delegation(taskId, 'feedback-triage');
  await applyAgentResult(`run-${randomUUID()}`, triage, result({
    outcome: 'completed',
    summary: '形成范围新增工作组。',
    feedback: {
      mode: 'triage',
      groups: [{
        groupKey: 'archive-selection',
        commentIds: [commentId],
        workType: 'scope_addition',
        title: '增加批量归档',
        affectedDeliveryUnits: [1],
        reason: '新增一个可独立验收的业务能力。',
        acceptance: ['选中记录可以被批量归档'],
      }],
    },
  }));
  const original = await delegation(taskId, 'feedback-split');

  await blockDelegation(
    original,
    '任务级 Agent 执行异常：story-splitter-agent/resume 没有配置渐进式命令协议',
  );
  assert.equal((await getTask(taskId))?.task.agile_status, 'blocked');

  await releaseBlock(taskId);
  const recovered = await delegation(taskId, 'feedback-split');
  assert.equal(recovered.agent, 'story-splitter-agent');
  assert.equal(recovered.feedbackGroupId, original.feedbackGroupId);
  assert.equal((await getTask(taskId))?.task.resume_pending, 0);
});

test('新版本会重新应用被旧版范围守卫误拒绝的反馈交付规划结果', async () => {
  const { taskId, documentId } = await completedRequirement('旧版反馈规划结果恢复');
  const commentId = await comment(taskId, documentId, '增加新的状态提示。');
  const triage = await delegation(taskId, 'feedback-triage');
  await applyAgentResult(`run-${randomUUID()}`, triage, result({
    outcome: 'completed',
    summary: '形成行为修订工作组。',
    feedback: {
      mode: 'triage',
      groups: [{
        groupKey: 'legacy-plan-recovery',
        commentIds: [commentId],
        workType: 'behavior_change',
        title: '增加新的状态提示',
        affectedDeliveryUnits: [1],
        reason: '需要改变用户可观察行为。',
        acceptance: ['页面展示新的状态提示'],
      }],
    },
  }));

  const split = await delegation(taskId, 'feedback-split');
  const planResult = result({
    outcome: 'completed',
    summary: '完成反馈交付规划。',
    deliveryUnits: [plannedUnit('legacy-plan-recovery', '增加新的状态提示', [
      'change:legacy-plan-recovery',
      'acceptance:legacy-plan-recovery:1',
    ])],
  });
  const { attempt } = await beginTestExecutionAttempt({
    runId: `RUN-legacy-plan-${randomUUID()}`,
    delegation: split,
    prompt: '模拟升级前已完成的交付规划 execution',
  });
  const db = await databaseConnection();
  const draftId = `DRAFT-legacy-plan-${randomUUID()}`;
  db.prepare(`
    INSERT INTO agent_work_drafts(
      draft_id, work_key, draft_version, draft_type, task_id, agent,
      status, terminal_execution_id, terminal_action, submitted_at, command_chain_id
    ) VALUES(?, ?, 1, 'delivery_plan', ?, 'story-splitter-agent',
      'submitted', ?, 'complete', CURRENT_TIMESTAMP, 'delivery-plan')
  `).run(
    draftId,
    `delivery-plan:${taskId}:feedback-split:${split.feedbackGroupId}`,
    taskId,
    attempt.execution_id,
  );
  db.prepare(`
    INSERT INTO agent_results(
      result_id, run_id, task_id, story_index, agent, pipeline, outcome,
      result_json, application_status, application_error, execution_id
    ) VALUES(?, ?, ?, NULL, 'story-splitter-agent', 'feedback-split',
      'completed', ?, 'failed', '反馈新增范围当前不能追加交付单元', ?)
  `).run(
    randomUUID(),
    `RUN-legacy-plan-${randomUUID()}`,
    taskId,
    JSON.stringify(planResult),
    attempt.execution_id,
  );
  db.prepare(`
    UPDATE execution_attempts
    SET status = 'system_blocked', result_json = ?,
        last_error = '应用 Agent 结果失败：反馈新增范围当前不能追加交付单元',
        finished_at = CURRENT_TIMESTAMP
    WHERE execution_id = ?
  `).run(JSON.stringify(planResult), attempt.execution_id);
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'blocked', current_subagent = 'story-splitter-agent',
        run_state = 'system_blocked',
        blocked_reason = '应用 Agent 结果失败：反馈新增范围当前不能追加交付单元'
    WHERE task_id = ?
  `).run(taskId);

  const recovered = await applyNextQueuedAgentResult();
  assert.equal(recovered.status, 'applied');
  const detail = await getTask(taskId);
  assert.equal(detail?.stories.length, 2);
  assert.equal(detail?.stories[1].unit_key, 'legacy-plan-recovery');
  assert.equal(detail?.task.agile_status, 'in feedback');
  assert.equal(detail?.task.run_state, 'runnable');
  assert.equal(detail?.task.blocked_reason, null);
  assert.equal(
    (db.prepare('SELECT status FROM execution_attempts WHERE execution_id = ?').get(attempt.execution_id) as { status: string }).status,
    'applied',
  );
});

test('Bug 反馈先复现，未复现时可人工对齐，复现后才追加修复单元', async () => {
  const { taskId, documentId } = await completedRequirement('Bug 复现');
  const commentId = await comment(taskId, documentId, 'Windows 下保存后页面崩溃。');
  const triage = await delegation(taskId, 'feedback-triage');
  await applyAgentResult(`run-${randomUUID()}`, triage, result({
    outcome: 'completed',
    summary: '识别为 Bug。',
    feedback: {
      mode: 'triage',
      groups: [{
        groupKey: 'windows-crash',
        commentIds: [commentId],
        workType: 'bug',
        title: '修复 Windows 保存崩溃',
        affectedDeliveryUnits: [1],
        reason: '必须先建立稳定复现证据。',
        acceptance: ['Windows 保存不再崩溃'],
      }],
    },
  }));
  let repro = await delegation(taskId, 'feedback-repro');
  assert.equal((await getTask(taskId))?.stories.length, 1);
  await applyAgentResult(`run-${randomUUID()}`, repro, result({
    outcome: 'needs_input',
    summary: '缺少 Windows 版本信息，暂未复现。',
    artifact: { title: '复现记录', content: '已完成合理尝试，缺少操作系统版本。' },
    reproVerdict: 'not_reproduced',
    questions: [{
      decisionKey: 'windows-version',
      title: 'Windows 版本',
      question: '问题发生在哪个 Windows 版本？',
      why: '需要匹配运行时差异。',
      recommendation: '提供系统版本号。',
    }],
  }));
  const detail = await getTask(taskId);
  const question = detail?.questions.find((item) => item.source_agent === 'repro-agent');
  assert.ok(question);
  const { answerQuestion, submitClarificationAnswers } = await import('./tasks');
  await answerQuestion({ taskId, questionId: question.question_id, answer: 'Windows 11 24H2' });
  await submitClarificationAnswers(taskId);
  repro = await delegation(taskId, 'feedback-repro');
  assert.equal(repro.feedbackGroupId, triage.feedbackGroupId || repro.feedbackGroupId);
  await applyAgentResult(`run-${randomUUID()}`, repro, result({
    outcome: 'completed',
    summary: '已在 Windows 11 复现。',
    artifact: { title: '复现证据', content: '保存操作稳定触发崩溃。' },
    reproVerdict: 'reproduced',
    route: 'plan',
  }));
  assert.equal((await getTask(taskId))?.stories.length, 1, '复现只确认事实，不应直接写入残缺修复单元');
  assert.equal((await getTask(taskId))?.feedbackGroups[0]?.status, 'waiting_for_plan');
  await applyNextFeedbackPlan(taskId, [
    plannedUnit('feedback-windows-crash-fix', '修复 Windows 保存崩溃', [
      'change:feedback:windows-crash',
      'acceptance:feedback:windows-crash:1',
    ]),
  ]);
  assert.equal((await getTask(taskId))?.stories[1].origin_type, 'feedback_bug');
});

test('范围新增通过追加拆分产生多个单元；回复和历史说明不创建单元', async () => {
  const { taskId, documentId } = await completedRequirement('范围新增');
  const scopeComment = await comment(taskId, documentId, '增加导出和批量删除两个独立能力。');
  const replyComment = await addDocumentComment({
    taskId,
    documentId,
    anchorType: 'file',
    content: '这里为什么采用当前命名？',
    intent: 'question',
  });
  const triage = await delegation(taskId, 'feedback-triage');
  await applyAgentResult(`run-${randomUUID()}`, triage, result({
    outcome: 'completed',
    summary: '范围新增与直接回复分别处理。',
    feedback: {
      mode: 'triage',
      groups: [{
        groupKey: 'more-capabilities',
        commentIds: [scopeComment],
        workType: 'scope_addition',
        title: '扩展管理能力',
        affectedDeliveryUnits: [1],
        reason: '包含两个可独立验收的新业务闭环。',
        acceptance: ['导出可独立使用', '批量删除可独立使用'],
      }, {
        groupKey: 'naming-answer',
        commentIds: [replyComment],
        workType: 'reply',
        affectedDeliveryUnits: [1],
        reason: '这是解释性问题，无需改代码。',
        acceptance: [],
        response: '当前命名与仓库既有领域语言保持一致。',
      }],
    },
  }));
  assert.equal((await getTask(taskId))?.stories.length, 1);
  await applyNextFeedbackPlan(taskId, [
    plannedUnit('feedback-export', '增加导出能力'),
    plannedUnit('feedback-batch-delete', '增加批量删除能力'),
  ]);
  const detail = await getTask(taskId);
  assert.equal(detail?.stories.length, 3);
  assert.deepEqual(detail?.stories.slice(1).map((story) => story.origin_type), ['feedback_scope', 'feedback_scope']);
  assert.equal(detail?.documentComments.find((item) => item.comment_id === replyComment)?.status, 'resolved');
});

test('结卡报告修订生成新版本，验证通过后直接回到等待阅读', async () => {
  const { taskId, documentId } = await completedRequirement('报告修订', { readyToClose: true });
  const commentId = await comment(taskId, documentId, '报告需要明确写出不支持离线模式。');
  const triage = await delegation(taskId, 'feedback-triage');
  await applyAgentResult(`run-${randomUUID()}`, triage, result({
    outcome: 'completed',
    summary: '仅修订结卡报告。',
    feedback: {
      mode: 'triage',
      groups: [{
        groupKey: 'offline-boundary',
        commentIds: [commentId],
        workType: 'report_correction',
        title: '补充离线模式边界',
        affectedDeliveryUnits: [1],
        reason: '实现不变，只修订最终事实表达。',
        acceptance: ['新版报告明确说明不支持离线模式'],
      }],
    },
  }));
  const report = await delegation(taskId, 'feedback-report');
  const reportOutcome = await applyAgentResult(`run-${randomUUID()}`, report, result({
    outcome: 'completed',
    summary: '结卡报告已补充离线边界。',
    artifact: { title: '结卡报告 v2', content: '# 已知限制\n\n当前不支持离线模式。' },
    verdict: 'report_ready',
  }));
  assert.equal(reportOutcome, 'advanced');
  const afterReport = await getTask(taskId);
  assert.equal(afterReport?.task.review_revision, 2);
  assert.equal(afterReport?.feedbackGroups[0]?.status, 'ready_for_verification');
  assert.equal(afterReport?.documentComments[0]?.feedback_status, 'verifying');
  const verify = await delegation(taskId, 'feedback-verify');
  await applyAgentResult(`run-${randomUUID()}`, verify, result({
    outcome: 'completed',
    summary: '报告修订满足评论。',
    feedback: {
      mode: 'verify',
      commentId,
      verdict: 'resolved',
      reason: '新版报告明确写出边界。',
      evidence: ['结卡报告 v2 的“已知限制”章节'],
    },
  }));
  const detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'ready_to_close');
  assert.equal(detail?.task.closure_status, 'awaiting_read');
  assert.equal(detail?.task.review_revision, 2);
  assert.equal(detail?.stories.length, 1);
});

test('反馈验证未通过会开启新批次，不回退旧单元或改写历史规格', async () => {
  const { taskId, documentId } = await completedRequirement('验证未通过');
  const commentId = await comment(taskId, documentId, '调整按钮文案。');
  const triage = await delegation(taskId, 'feedback-triage');
  await applyAgentResult(`run-${randomUUID()}`, triage, result({
    outcome: 'completed',
    summary: '追加文案修订单元。',
    feedback: {
      mode: 'triage',
      groups: [{
        groupKey: 'button-copy',
        commentIds: [commentId],
        workType: 'behavior_change',
        title: '调整按钮文案',
        affectedDeliveryUnits: [1],
        reason: '改变用户可见文本。',
        acceptance: ['按钮展示指定文案'],
      }],
    },
  }));
  await applyNextFeedbackPlan(taskId, [
    plannedUnit('feedback-button-copy', '调整按钮文案', [
      'change:feedback:button-copy',
      'acceptance:feedback:button-copy:1',
    ]),
  ]);
  const db = await databaseConnection();
  db.prepare(`
    UPDATE tasks SET analysis_index = 2, dev_index = 2, test_index = 2, spec_resolved_index = 2
    WHERE task_id = ?
  `).run(taskId);
  db.prepare(`
    UPDATE feedback_groups SET status = 'ready_for_verification' WHERE batch_id = ?
  `).run(triage.feedbackBatchId);
  db.prepare(`
    UPDATE document_comments SET feedback_status = 'verifying' WHERE comment_id = ?
  `).run(commentId);
  const verify = await delegation(taskId, 'feedback-verify');
  await applyAgentResult(`run-${randomUUID()}`, verify, result({
    outcome: 'completed',
    summary: '实际文案仍不符合要求。',
    feedback: {
      mode: 'verify',
      commentId,
      verdict: 'reopened',
      reason: '页面仍展示旧文案。',
      evidence: ['浏览器检查结果'],
    },
  }));
  const next = await delegation(taskId, 'feedback-triage');
  assert.notEqual(next.feedbackBatchId, triage.feedbackBatchId);
  const detail = await getTask(taskId);
  assert.deepEqual(
    [detail?.task.analysis_index, detail?.task.dev_index, detail?.task.test_index],
    [2, 2, 2],
  );
  assert.equal(detail?.deliverySpecs.filter((spec) => spec.story_index === 1).length, 1);
  const reopenedEvent = detail?.events.find((event) => event.event_type === 'FeedbackReopened');
  assert.ok(reopenedEvent);
  assert.doesNotMatch(reopenedEvent.summary, new RegExp(commentId));
  assert.match(reopenedEvent.summary, /反馈「调整按钮文案」验证未通过/);
});

test('反馈分流拒绝重复工作组标识和不存在的交付单元引用', async () => {
  const { taskId, documentId } = await completedRequirement('分流边界校验');
  const firstComment = await comment(taskId, documentId, '调整第一个既有行为。');
  const secondComment = await comment(taskId, documentId, '调整第二个既有行为。');
  const triage = await delegation(taskId, 'feedback-triage');
  const { applyFeedbackTriageGroups } = await import('./feedback');

  await assert.rejects(() => applyFeedbackTriageGroups({
    taskId,
    batchId: triage.feedbackBatchId!,
    summary: '两个分组错误地使用了同一个稳定标识。',
    groups: [{
      groupKey: 'duplicate-key',
      commentIds: [firstComment],
      workType: 'behavior_change',
      title: '调整第一个行为',
      affectedDeliveryUnits: [1],
      reason: '需要新增行为修订单元。',
      acceptance: ['第一个行为满足反馈'],
    }, {
      groupKey: 'duplicate-key',
      commentIds: [secondComment],
      workType: 'behavior_change',
      title: '调整第二个行为',
      affectedDeliveryUnits: [1],
      reason: '需要新增行为修订单元。',
      acceptance: ['第二个行为满足反馈'],
    }],
  }), /重复分组标识/);

  await assert.rejects(() => applyFeedbackTriageGroups({
    taskId,
    batchId: triage.feedbackBatchId!,
    summary: '引用了不存在的交付单元。',
    groups: [{
      groupKey: 'invalid-delivery-unit',
      commentIds: [firstComment, secondComment],
      workType: 'behavior_change',
      title: '调整两个既有行为',
      affectedDeliveryUnits: [0],
      reason: '需要新增行为修订单元。',
      acceptance: ['两个行为满足反馈'],
    }],
  }), /引用不存在的交付单元/);

  const detail = await getTask(taskId);
  assert.equal(detail?.stories.length, 1);
  assert.equal(detail?.feedbackGroups.length, 0);
});

test('直接回复、历史说明和长期建议在原位闭环，不改写历史也不追加交付单元', async () => {
  const { taskId, documentId } = await completedRequirement('原位闭环', { readyToClose: true });
  const replyComment = await comment(taskId, documentId, '解释当前领域命名。');
  const historyComment = await comment(taskId, documentId, '补充说明当时为何没有离线能力。');
  const learningComment = await comment(taskId, documentId, '以后都应明确列出离线边界。');
  const triage = await delegation(taskId, 'feedback-triage');

  await applyAgentResult(`run-${randomUUID()}`, triage, result({
    outcome: 'completed',
    summary: '三条反馈都不需要修改既有交付。',
    feedback: {
      mode: 'triage',
      groups: [{
        groupKey: 'naming-reply',
        commentIds: [replyComment],
        workType: 'reply',
        affectedDeliveryUnits: [1],
        reason: '属于解释性问题。',
        acceptance: [],
        response: '当前命名沿用仓库既有领域语言。',
      }, {
        groupKey: 'historical-offline-boundary',
        commentIds: [historyComment],
        workType: 'historical_correction',
        affectedDeliveryUnits: [1],
        reason: '只补充当时的决策背景，不改写历史文档。',
        acceptance: [],
        response: '当时的已确认范围明确排除了离线能力。',
      }, {
        groupKey: 'future-report-convention',
        commentIds: [learningComment],
        workType: 'learning_only',
        affectedDeliveryUnits: [],
        reason: '沉淀为长期表达建议，不改变当前交付。',
        acceptance: [],
      }],
    },
  }));

  const detail = await getTask(taskId);
  assert.equal(detail?.stories.length, 1);
  assert.equal(detail?.deliverySpecs.filter((spec) => spec.story_index === 1).length, 1);
  assert.equal(detail?.documents.length, 1);
  assert.equal(detail?.documentComments.every((item) => item.status === 'resolved'), true);
  assert.equal(detail?.feedbackGroups.every((group) => group.status === 'completed'), true);
  assert.deepEqual(detail?.feedbackGroups.map((group) => group.group_order), [1, 2, 3]);
  assert.equal(detail?.feedbackBatches[0]?.status, 'completed');
  assert.equal(detail?.task.agile_status, 'ready_to_close');
});

test('技术调整也先经过交付规划，再创建完整的独立交付单元', async () => {
  const { taskId, documentId } = await completedRequirement('技术调整');
  const commentId = await comment(taskId, documentId, '把持久化边界收敛到统一仓储接口。');
  const triage = await delegation(taskId, 'feedback-triage');
  await applyAgentResult(`run-${randomUUID()}`, triage, result({
    outcome: 'completed',
    summary: '技术边界调整需要一个独立交付单元。',
    feedback: {
      mode: 'triage',
      groups: [{
        groupKey: 'repository-boundary',
        commentIds: [commentId],
        workType: 'technical_change',
        title: '统一持久化仓储边界',
        affectedDeliveryUnits: [1],
        reason: '需要修改工程结构，但不改写原交付事实。',
        acceptance: ['所有持久化访问通过统一仓储接口'],
      }],
    },
  }));

  let detail = await getTask(taskId);
  assert.equal(detail?.stories.length, 1);
  assert.equal(detail?.feedbackGroups[0]?.status, 'waiting_for_plan');
  await applyNextFeedbackPlan(taskId, [
    plannedUnit('feedback-repository-boundary', '统一持久化仓储边界', [
      'change:feedback:repository-boundary',
      'acceptance:feedback:repository-boundary:1',
    ]),
  ]);
  detail = await getTask(taskId);
  assert.equal(detail?.stories.length, 2);
  assert.equal(detail?.stories[1].origin_type, 'feedback_technical');
  assert.equal(detail?.stories[1].unit_key, 'feedback-repository-boundary');
  assert.deepEqual(JSON.parse(detail?.stories[1].corrects_story_indexes_json || '[]'), [1]);
  assert.deepEqual(
    [detail?.task.analysis_index, detail?.task.dev_index, detail?.task.test_index],
    [1, 1, 1],
  );
});

test('活动批次执行期间新增的评论进入下一批，不污染已冻结输入', async () => {
  const { taskId, documentId } = await completedRequirement('批次冻结', { readyToClose: true });
  const firstComment = await comment(taskId, documentId, '解释第一次交付的命名。');
  const firstBatch = await delegation(taskId, 'feedback-triage');
  const laterComment = await comment(taskId, documentId, '补充第二条独立说明。');

  assert.deepEqual(firstBatch.feedbackIds, [firstComment]);
  await applyAgentResult(`run-${randomUUID()}`, firstBatch, result({
    outcome: 'completed',
    summary: '只处理批次冻结时已经存在的评论。',
    feedback: {
      mode: 'triage',
      groups: [{
        groupKey: 'first-answer',
        commentIds: [firstComment],
        workType: 'reply',
        affectedDeliveryUnits: [1],
        reason: '直接回答第一条评论。',
        acceptance: [],
        response: '第一次交付沿用了既有命名。',
      }],
    },
  }));

  const secondBatch = await delegation(taskId, 'feedback-triage');
  assert.notEqual(secondBatch.feedbackBatchId, firstBatch.feedbackBatchId);
  assert.deepEqual(secondBatch.feedbackIds, [laterComment]);
  const detail = await getTask(taskId);
  assert.equal(detail?.feedbackBatches.length, 2);
  assert.deepEqual(detail?.feedbackBatches.map((batch) => batch.batch_number), [1, 2]);
  assert.equal(detail?.feedbackBatches[0].status, 'completed');
  assert.equal(detail?.feedbackBatches[1].status, 'triaging');
  const batchEvents = detail?.events.filter((event) => event.event_type === 'FeedbackBatchCreated') || [];
  assert.deepEqual(batchEvents.map((event) => event.summary).sort(), [
    '冻结 1 条评论形成反馈批次 1',
    '冻结 1 条评论形成反馈批次 2',
  ]);
  assert.equal(batchEvents.some((event) => event.summary.includes(firstBatch.feedbackBatchId!)), false);
});

test('反馈追加单元测试失败时只重做当前新单元，并保持反馈处理状态', async () => {
  const { taskId, documentId } = await completedRequirement('反馈单元失败恢复');
  const commentId = await comment(taskId, documentId, '增加明确的空状态操作入口。');
  const triage = await delegation(taskId, 'feedback-triage');
  await applyAgentResult(`run-${randomUUID()}`, triage, result({
    outcome: 'completed',
    summary: '追加一个行为修订单元。',
    feedback: {
      mode: 'triage',
      groups: [{
        groupKey: 'empty-state-action',
        commentIds: [commentId],
        workType: 'behavior_change',
        title: '增加空状态操作入口',
        affectedDeliveryUnits: [1],
        reason: '需要新增用户可观察行为。',
        acceptance: ['空状态展示可用操作入口'],
      }],
    },
  }));
  await applyNextFeedbackPlan(taskId, [
    plannedUnit('feedback-empty-state-action', '增加空状态操作入口', [
      'change:feedback:empty-state-action',
      'acceptance:feedback:empty-state-action:1',
    ]),
  ]);
  const analysis = await delegation(taskId, 'analysis');
  await applyAgentResult(`run-${randomUUID()}`, analysis, result({
    outcome: 'completed',
    summary: '完成追加单元规格。',
    artifact: { title: '空状态操作入口分析', content: '只定义新增单元。' },
    spec: resolvedSpec,
  }));
  const dev = await delegation(taskId, 'dev');
  await applyAgentResult(`run-${randomUUID()}`, dev, result({
    outcome: 'completed',
    summary: '首次实现操作入口。',
    changedFiles: ['src/empty-state-action.ts'],
    tests: [{ command: 'npm test', passed: true }],
  }));
  const failedTest = await delegation(taskId, 'test');
  await applyAgentResult(`run-${randomUUID()}`, failedTest, result({
    outcome: 'failed',
    summary: '操作入口点击后没有进入预期流程。',
    verdict: 'failed',
    rewindTo: 'dev',
    rewindDeliveryUnit: 2,
    tests: [{ command: 'npm test -- empty-state-action', passed: false, summary: '点击无响应' }],
  }));

  let detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'in feedback');
  assert.deepEqual(
    [detail?.task.analysis_index, detail?.task.dev_index, detail?.task.test_index],
    [2, 1, 1],
  );
  assert.equal(detail?.stories[0].origin_type, 'original');
  assert.equal(detail?.feedbackGroups[0].status, 'executing');
  assert.equal(detail?.recoveryItems.length, 1);

  const retryDev = await delegation(taskId, 'dev');
  assert.equal(retryDev.storyIndex, 2);
  await applyAgentResult(`run-${randomUUID()}`, retryDev, result({
    outcome: 'completed',
    summary: '修复操作入口。',
    changedFiles: ['src/empty-state-action.ts'],
    tests: [{ command: 'npm test -- empty-state-action', passed: true }],
  }));
  const passedTest = await delegation(taskId, 'test');
  await applyAgentResult(`run-${randomUUID()}`, passedTest, result({
    outcome: 'completed',
    summary: '追加单元重新验证通过。',
    verdict: 'passed',
    tests: [{ command: 'npm test -- empty-state-action', passed: true }],
  }));
  detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'in feedback');
  assert.equal(detail?.feedbackGroups[0].status, 'ready_for_verification');
  assert.equal(detail?.recoveryItems[0].status, 'resolved');
  assert.equal((await delegation(taskId, 'feedback-verify')).feedbackId, commentId);
});

test('取消处于反馈处理中的需求会清理活动批次和工作组，不再派发', async () => {
  const { taskId, documentId } = await completedRequirement('取消反馈');
  const commentId = await comment(taskId, documentId, '增加一个不再需要的行为。');
  const triage = await delegation(taskId, 'feedback-triage');
  await applyAgentResult(`run-${randomUUID()}`, triage, result({
    outcome: 'completed',
    summary: '创建一个待推进的反馈单元。',
    feedback: {
      mode: 'triage',
      groups: [{
        groupKey: 'cancelled-behavior',
        commentIds: [commentId],
        workType: 'behavior_change',
        title: '不再需要的行为',
        affectedDeliveryUnits: [1],
        reason: '测试取消清理。',
        acceptance: ['行为存在'],
      }],
    },
  }));

  await cancelTask({ taskId, reason: '用户撤销整个需求' });
  const detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'cancelled');
  assert.equal(detail?.feedbackBatches[0].status, 'cancelled');
  assert.equal(detail?.feedbackGroups[0].status, 'cancelled');
  assert.deepEqual(await inspectTaskDispatch(taskId), []);
});
