import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('updates an existing task-level document instead of inserting a duplicate NULL-story row', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { listDocuments, upsertDocument } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, work_dir)
    VALUES('TASK-doc-null', 'Document upsert', 'task', 'backlog', '')
  `).run();

  const firstId = await upsertDocument({
    taskId: 'TASK-doc-null',
    kind: 'final_review',
    title: 'First review',
    content: 'first',
    actor: 'review-agent',
  });
  const secondId = await upsertDocument({
    taskId: 'TASK-doc-null',
    kind: 'final_review',
    title: 'Second review',
    content: 'second',
    actor: 'review-agent',
  });

  const documents = await listDocuments('TASK-doc-null');
  assert.equal(secondId, firstId);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].title, 'Second review');
  assert.equal(documents[0].content, 'second');
  assert.equal(documents[0].story_index, null);

});

test('anchors verified file feedback to document revisions and supplies it to Agent evolution', async () => {
  const { addDocumentComment, applyFeedbackTriage, applyFeedbackVerification, createTask, getTask, upsertDocument } = await import('./tasks');
  const { applyEvolutionResult, beginEvolutionRun } = await import('./agent-evolution');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Artifact feedback evidence' });
  const documentId = await upsertDocument({
    taskId,
    kind: 'final_review',
    title: 'Review report',
    content: '# Result\n\nThe first version needs a clearer boundary.',
    actor: 'review-agent',
  });
  const commentId = await addDocumentComment({
    taskId,
    documentId,
    anchorType: 'selection',
    quotedText: 'needs a clearer boundary',
    startOffset: 25,
    endOffset: 49,
    content: 'State the boundary explicitly and preserve this convention in future reports.',
  });

  await upsertDocument({
    taskId,
    kind: 'final_review',
    title: 'Review report',
    content: '# Result\n\nThe boundary is now explicit.',
    actor: 'review-agent',
  });
  let detail = await getTask(taskId);
  assert.equal(detail?.documents[0].revision, 2);
  assert.equal(detail?.documentComments[0].document_revision, 1);
  assert.equal(detail?.documentComments[0].quoted_text, 'needs a clearer boundary');
  assert.equal(detail?.documentComments[0].status, 'open');

  await applyFeedbackTriage(taskId, {
    commentId,
    disposition: 'learning_only',
    reason: 'The report was already updated; preserve the convention as learning evidence.',
    acceptance: [],
  });
  await applyFeedbackVerification(taskId, {
    commentId,
    verdict: 'resolved',
    reason: 'Revision 2 states the boundary explicitly.',
    evidence: ['Review report revision 2 contains an explicit boundary statement.'],
  });
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, agent, pipeline, delegation_key,
      attempt, status, input_hash, input_json
    ) VALUES('execution-comment-evolution', 'run-comment-evolution', ?, 'review-agent', 'review', 'comment-evolution', 1, 'applied', 'comment-hash', '{}')
  `).run(taskId);
  const evidence = {
    executionId: 'execution-comment-evolution',
    taskId,
    storyIndex: null,
    agentId: 'review-agent',
    attempt: 1,
    promptVersion: 1,
    result: { outcome: 'completed', summary: 'The review report was revised.' },
    applicationOutcome: 'advanced',
    diagnostics: [],
  };
  const run = await beginEvolutionRun(evidence);
  assert.match(run?.prompt || '', new RegExp(commentId));
  assert.match(run?.prompt || '', /State the boundary explicitly/);
  await applyEvolutionResult(run!.evolutionId, evidence, {
    summary: 'The human feedback was retained as execution evidence.',
    observations: [{
      fingerprint: 'state-review-boundaries-explicitly',
      category: 'output-contract',
      summary: 'Review reports should state important product boundaries explicitly',
      guidance: 'When a report relies on a product boundary, state that boundary directly instead of leaving it implicit.',
      target: 'daily',
      confidence: 0.8,
      reusable: false,
      evidenceCommentIds: [commentId],
    }],
  });

  detail = await getTask(taskId);
  assert.equal(detail?.documentComments[0].status, 'resolved');
  assert.equal(detail?.documentComments[0].evolution_status, 'analyzed');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM agent_observation_comment_evidence WHERE comment_id = ?').get(commentId) as { count: number }).count, 1);
});

test('creates title-only and described Tasks without blocking delegation and serializes description into agent context', async () => {
  const { createTask, getTaskContext, getTask, pipelineAllEnvelopes, pipelineForTask, toJsonlEnvelope } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const titleOnlyTaskId = await createTask({ title: 'Title only Task' });
  const blankDescriptionTaskId = await createTask({ title: 'Blank description Task', description: '   ' });
  const describedTaskId = await createTask({ title: 'Described Task', description: 'Keep this value for the next story.' });
  assert.match(titleOnlyTaskId, /^REQ-/);

  const titleOnlyTask = await getTask(titleOnlyTaskId);
  const blankDescriptionTask = await getTask(blankDescriptionTaskId);
  const describedTask = await getTask(describedTaskId);
  assert.equal(titleOnlyTask?.task.description, null);
  assert.equal(blankDescriptionTask?.task.description, null);
  assert.equal(describedTask?.task.description, 'Keep this value for the next story.');

  const titleOnlyContext = await getTaskContext(titleOnlyTaskId);
  const describedContext = await getTaskContext(describedTaskId);
  assert.equal(titleOnlyContext.task.description, null);
  assert.equal(describedContext.task.description, 'Keep this value for the next story.');

  // Each creation path can produce the normal backlog delegation; a missing
  // description must never be interpreted as a pipeline blocker.
  assert.equal((await pipelineForTask(titleOnlyTaskId))[0]?.agent, 'backlog-agent');
  assert.equal((await pipelineForTask(describedTaskId))[0]?.agent, 'backlog-agent');

  // A backlog delegation consumes the browser resource, so isolate each path
  // when inspecting its serialized Agent input.
  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id NOT IN (?, ?, ?)").run(titleOnlyTaskId, blankDescriptionTaskId, describedTaskId);
  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id = ?").run(blankDescriptionTaskId);
  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id = ?").run(describedTaskId);
  const titleOnlyEnvelope = (await pipelineAllEnvelopes()).find((item) => item.taskId === titleOnlyTaskId);
  assert.ok(titleOnlyEnvelope);

  const titleOnlyAgentInput = JSON.parse(toJsonlEnvelope(titleOnlyEnvelope));
  assert.equal(titleOnlyAgentInput.task_description, null);

  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id = ?").run(titleOnlyTaskId);
  db.prepare("UPDATE tasks SET agile_status = 'backlog' WHERE task_id = ?").run(describedTaskId);
  const describedEnvelope = (await pipelineAllEnvelopes()).find((item) => item.taskId === describedTaskId);
  assert.ok(describedEnvelope);
  const describedAgentInput = JSON.parse(toJsonlEnvelope(describedEnvelope));
  assert.equal(describedAgentInput.task_description, 'Keep this value for the next story.');
  assert.equal(describedAgentInput.description, '收集上下文并完成分类');
});

test('lists only completed Tasks in completion order while preserving terminal Task details', async () => {
  const { getTask, listCompletedTasks, listTasks } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();

  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, work_dir, completed_at, updated_at)
    VALUES (?, ?, 'task', ?, '', ?, ?)
  `).run('TASK-completed-new', 'Recently completed', 'done', '2026-07-14 10:00:00', '2026-07-14 10:00:00');
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, work_dir, completed_at, updated_at)
    VALUES (?, ?, 'task', ?, '', ?, ?)
  `).run('TASK-completed-legacy', 'Legacy completed', 'done', null, '2026-07-14 09:00:00');
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, work_dir, updated_at)
    VALUES (?, ?, 'task', ?, '', ?)
  `).run('TASK-cancelled', 'Cancelled', 'cancelled', '2026-07-14 11:00:00');
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, work_dir, updated_at)
    VALUES (?, ?, 'task', ?, '', ?)
  `).run('TASK-active', 'Active', 'backlog', '2026-07-14 12:00:00');
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES('TASK-completed-new', 1, 'Completed story', 'story-001')").run();
  db.prepare("INSERT INTO documents(document_id, task_id, kind, title, content) VALUES('DOC-completed', 'TASK-completed-new', 'analysis', 'Completed analysis', 'History remains available')").run();
  db.prepare("INSERT INTO task_events(event_id, task_id, actor, event_type, summary) VALUES('EVENT-completed', 'TASK-completed-new', 'dev-agent', 'completed', 'Task completed')").run();

  const completed = await listCompletedTasks();
  const completedIds = completed.map((task) => task.task_id);
  assert.deepEqual(
    completedIds.filter((taskId) => taskId === 'TASK-completed-new' || taskId === 'TASK-completed-legacy'),
    ['TASK-completed-new', 'TASK-completed-legacy'],
  );
  assert.ok(completed.every((task) => task.agile_status === 'done'));
  assert.ok(!completedIds.includes('TASK-cancelled'));
  assert.ok(!completedIds.includes('TASK-active'));

  const activeIds = (await listTasks()).map((task) => task.task_id);
  assert.ok(!activeIds.includes('TASK-completed-new'));
  assert.ok(!activeIds.includes('TASK-cancelled'));
  assert.ok(activeIds.includes('TASK-active'));

  const detail = await getTask('TASK-completed-new');
  assert.equal(detail?.task.task_id, 'TASK-completed-new');
  assert.equal(detail?.stories[0]?.title, 'Completed story');
  assert.equal(detail?.documents[0]?.content, 'History remains available');
  assert.equal(detail?.events[0]?.summary, 'Task completed');
});

test('pauses requirement intake for user alignment and resumes the same backlog agent before splitting', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { parseAgentResult } = await import('../domain/agent-result');
  const { answerQuestion, createTask, getTask, pipelineForTask, submitClarificationAnswers } = await import('./tasks');
  const taskId = await createTask({
    title: 'Requirement-level clarification',
    description: 'Add an export action, but the intended audience is not specified.',
  });
  const firstDelegation = (await pipelineForTask(taskId))[0] as Parameters<typeof applyAgentResult>[1];
  assert.deepEqual([firstDelegation.lane, firstDelegation.pipeline, firstDelegation.agent, firstDelegation.storyIndex], ['control', 'backlog', 'backlog-agent', null]);

  const blocked = await applyAgentResult('run-requirement-clarification', firstDelegation, parseAgentResult(JSON.stringify({
    outcome: 'needs_input',
    summary: 'The target audience changes the requirement scope and delivery boundary.',
    artifact: {
      title: 'Requirement context with an open boundary',
      content: 'The export action is requested. The supported audience remains unresolved.',
    },
    questions: [{
      decisionKey: 'export-audience',
      title: '确认导出能力的目标用户',
      question: '本次导出能力只面向管理员，还是同时面向普通成员？',
      why: '目标用户会改变权限范围和后续交付单元拆分。',
      recommendation: '本轮只面向管理员。',
      recommendationReason: '这是满足当前目标的最小范围。',
      alternatives: [
        { id: 'admin', label: '仅管理员', consequences: ['保持较小权限范围'] },
        { id: 'all-members', label: '所有成员', consequences: ['需要新增成员权限和兼容行为'] },
      ],
      dependsOn: [],
    }],
  })));
  assert.equal(blocked, 'blocked');

  let detail = await getTask(taskId);
  const question = detail?.questions.find((item) => item.source_agent === 'backlog-agent');
  assert.equal(detail?.task.agile_status, 'backlog');
  assert.equal(detail?.task.run_state, 'waiting_for_answers');
  assert.equal(detail?.task.current_subagent, 'backlog-agent');
  assert.equal(question?.story_index, null);
  assert.equal(question?.kind, 'local');
  assert.equal(question?.status, 'pending');
  assert.deepEqual(await pipelineForTask(taskId), []);

  await answerQuestion({ taskId, questionId: question!.question_id, answer: '本轮只面向管理员。' });
  await submitClarificationAnswers(taskId);
  detail = await getTask(taskId);
  assert.equal(detail?.task.run_state, 'runnable');
  assert.equal(detail?.task.resume_pending, 1);
  const resumedDelegation = (await pipelineForTask(taskId))[0] as Parameters<typeof applyAgentResult>[1];
  assert.deepEqual([resumedDelegation.lane, resumedDelegation.pipeline, resumedDelegation.agent, resumedDelegation.storyIndex], ['control', 'resume', 'backlog-agent', null]);

  await applyAgentResult('run-requirement-clarification-resume', resumedDelegation, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'The export action is limited to administrators and can proceed to delivery planning.',
    classification: 'feature',
    route: 'plan',
    artifact: {
      title: 'Resolved requirement context',
      content: 'The export action is limited to administrators. Ordinary members are out of scope.',
    },
  })));

  detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'in plan');
  assert.equal(detail?.task.run_state, 'runnable');
  assert.equal(detail?.task.resume_pending, 0);
  assert.equal(detail?.questions.find((item) => item.question_id === question?.question_id)?.status, 'resolved');
  assert.ok(detail?.events.some((event) => event.event_type === 'RequirementClarificationsResolved'));
  assert.equal((await pipelineForTask(taskId))[0]?.agent, 'story-splitter-agent');
});

test('submits answered analysis clarifications back to the analyst without approving or advancing', async () => {
  const { addQuestion, answerQuestion, getTask, submitClarificationAnswers } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-agent-analysis-question';
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, current_subagent, total_stories, work_dir)
    VALUES(?, 'Agent analysis Question', 'feature', 'ready for dev', 'analyst-agent', 1, '')
  `).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Analysis story', 'story-001')").run(taskId);

  const questionId = await addQuestion({
    taskId,
    storyIndex: 1,
    actor: 'analyst-agent',
    kind: 'analysis',
    title: 'Confirm API boundary',
    question: 'Should the existing endpoint remain public?',
    why: 'The implementation needs a stable compatibility decision.',
    recommendation: 'Keep it public for this release.',
    blockedReason: 'Waiting for API decision',
    blockTask: true,
  });

  let detail = await getTask(taskId);
  const question = detail?.questions.find((item) => item.question_id === questionId);
  assert.equal(question?.title, 'Confirm API boundary');
  assert.equal(question?.question, 'Should the existing endpoint remain public?');
  assert.equal(question?.kind, 'analysis');
  assert.equal(question?.source_agent, 'analyst-agent');
  assert.equal(question?.story_index, 1);
  assert.equal(question?.why, 'The implementation needs a stable compatibility decision.');
  assert.equal(question?.recommendation, 'Keep it public for this release.');
  assert.equal(question?.status, 'pending');
  assert.equal(detail?.task.agile_status, 'ready for dev');
  assert.equal(detail?.task.run_state, 'waiting_for_answers');
  await assert.rejects(() => submitClarificationAnswers(taskId), /仍有未回答的澄清问题/);

  await answerQuestion({ taskId, questionId, answer: 'Keep it public.' });
  detail = await getTask(taskId);
  assert.equal(detail?.questions.find((item) => item.question_id === questionId)?.status, 'answered');
  assert.equal(detail?.questions.find((item) => item.question_id === questionId)?.answer, 'Keep it public.');
  assert.ok(detail?.events.some((event) => event.event_type === 'QuestionAnswered'));

  await submitClarificationAnswers(taskId);
  detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'ready for dev');
  assert.equal(detail?.task.current_subagent, 'analyst-agent');
  assert.equal(detail?.task.run_state, 'runnable');
  assert.equal(detail?.task.resume_pending, 1);
  assert.equal(detail?.task.resume_status, null);
  assert.equal(detail?.task.analysis_index, 0);
  assert.equal(detail?.task.spec_resolved_index, 0);
});

test('acknowledges the current review report as read without an approval decision', async () => {
  const { acknowledgeClosure, addDocumentComment, addQuestion, applyFeedbackTriage, applyFeedbackVerification, getTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-closure-acknowledgement';
  const documentId = 'DOC-closure-report';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index,
      run_state, closure_status, review_revision, review_document_id, work_dir
    ) VALUES(?, 'Closure acknowledgement', 'feature', 'ready_to_close', NULL, 1, 1, 1, 1, 1, 'idle', 'awaiting_read', 1, ?, '')
  `).run(taskId, documentId);
  db.prepare(`
    INSERT INTO documents(document_id, task_id, kind, title, content, source_agent)
    VALUES(?, ?, 'review', '结卡报告', '完整结卡报告', 'review-agent')
  `).run(documentId, taskId);

  await assert.rejects(() => addQuestion({
    taskId,
    actor: 'review-agent',
    kind: 'review',
    title: 'Approve delivery',
    question: 'Can this be approved?',
  }), /不能创建人工审批/);

  const noteId = await addDocumentComment({
    taskId,
    documentId,
    anchorType: 'file',
    intent: 'note',
    content: '请在后续报告中保留这个表述约定。',
  });
  await assert.rejects(() => acknowledgeClosure({ taskId, reviewRevision: 1 }), /1 条反馈尚未通过/);
  await applyFeedbackTriage(taskId, {
    commentId: noteId,
    disposition: 'learning_only',
    reason: '该评论是长期表述建议，不需要修改当前交付。',
    acceptance: [],
  });
  await applyFeedbackVerification(taskId, {
    commentId: noteId,
    verdict: 'resolved',
    reason: '已记录为可演化的长期证据。',
    evidence: ['Feedback triage record'],
  });
  await applyFeedbackVerification(taskId, {
    commentId: noteId,
    verdict: 'resolved',
    reason: '已记录为可演化的长期证据。',
    evidence: ['Feedback triage record'],
  });

  await acknowledgeClosure({ taskId, reviewRevision: 1 });
  const detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'done');
  assert.equal(detail?.task.closure_status, 'acknowledged');
  assert.equal(detail?.task.run_state, 'idle');
  assert.ok(detail?.task.closure_acknowledged_at);
  assert.equal(detail?.closureAcknowledgements.length, 1);
  assert.equal(detail?.closureAcknowledgements[0]?.review_revision, 1);
  assert.ok(detail?.events.some((event) => event.event_type === 'ClosureAcknowledged'));

  await assert.rejects(() => acknowledgeClosure({ taskId, reviewRevision: 1 }), /没有等待阅读/);
});

test('routes closure feedback through triage, implementation, testing, and independent verification', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { parseAgentResult } = await import('../domain/agent-result');
  const {
    acknowledgeClosure,
    addDocumentComment,
    getTask,
    pipelineForTask,
  } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-closure-feedback-loop';
  const documentId = 'DOC-closure-feedback-v1';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index,
      run_state, closure_status, review_revision, review_document_id, work_dir
    ) VALUES(?, 'Closure feedback loop', 'feature', 'ready_to_close', NULL, 1, 1, 1, 1, 1, 'idle', 'awaiting_read', 1, ?, '')
  `).run(taskId, documentId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Compatibility behavior', 'story-001')").run(taskId);
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json)
    VALUES('SPEC-closure-feedback', ?, 1, 1, 'resolved', '{}')
  `).run(taskId);
  db.prepare(`
    INSERT INTO documents(document_id, task_id, kind, title, content, source_agent)
    VALUES(?, ?, 'review_v1', '结卡报告 v1', '遗漏了一个重要限制。', 'review-agent')
  `).run(documentId, taskId);
  const commentId = await addDocumentComment({
    taskId,
    documentId,
    anchorType: 'file',
    content: '旧接口现在已经无法使用，这不是报告表述问题，请修复兼容性实现并重新验证。',
  });

  await assert.rejects(
    () => acknowledgeClosure({ taskId, reviewRevision: 1 }),
    /还有 1 条反馈尚未通过反馈闭环验证/,
  );
  const feedbackDelegation = (await pipelineForTask(taskId))[0] as Parameters<typeof applyAgentResult>[1];
  assert.equal(feedbackDelegation.agent, 'feedback-agent');
  assert.equal(feedbackDelegation.pipeline, 'feedback-triage');
  await applyAgentResult('run-feedback-triage', feedbackDelegation, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: '评论指出实现兼容性缺陷，应回退开发阶段。',
    artifact: {
      title: '不应保存的 Feedback Agent 临时说明',
      content: 'Feedback Agent 只提交结构化判断，不创建交付文档。',
    },
    feedback: {
      mode: 'triage',
      commentId,
      disposition: 'rewind',
      targetStage: 'dev',
      targetDeliveryUnit: 1,
      reason: '旧接口行为属于实现兼容性问题。',
      acceptance: ['旧接口恢复可用', '兼容性回归测试通过'],
    },
  })));
  let detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'in dev');
  assert.equal(detail?.task.current_subagent, 'dev-agent');
  assert.equal(detail?.documentComments.find((comment) => comment.comment_id === commentId)?.feedback_status, 'in_progress');
  assert.equal(detail?.documents.some((document) => document.title === '不应保存的 Feedback Agent 临时说明'), false);

  const delegation = {
    taskId,
    pipeline: 'review',
    agent: 'review-agent',
    storyIndex: null,
    resource: 'none' as const,
    description: '根据用户评论更新结卡报告',
    title: 'Closure feedback loop',
    taskDescription: null,
    itemType: 'feature',
    priority: '',
    link: '',
    externalId: '',
    externalStatus: '',
    agileStatus: 'in review',
    currentSubagent: 'review-agent',
    resumePending: 0,
    specResolvedIndex: 1,
    runState: 'runnable',
    closureStatus: 'none',
    reviewRevision: 1,
    reviewDocumentId: '',
    lastActor: 'human',
    analysisIndex: 1,
    devIndex: 1,
    testIndex: 1,
    totalStories: 1,
    nextStep: '根据评论更新报告',
    blockedReason: '',
    owner: '',
    evidence: '',
    risk: '',
  };
  await applyAgentResult('run-closure-feedback-dev', {
    ...delegation,
    pipeline: 'dev',
    agent: 'dev-agent',
    storyIndex: 1,
    description: '修复用户在结卡评论中指出的兼容性问题',
    agileStatus: 'in dev',
    currentSubagent: 'dev-agent',
    devIndex: 0,
    testIndex: 0,
  }, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: '已恢复旧接口兼容性。',
    changedFiles: ['src/compatibility.ts'],
    tests: [{ command: 'npm test', passed: true }],
  })));
  detail = await getTask(taskId);
  assert.equal(detail?.documentComments.find((comment) => comment.comment_id === commentId)?.resolution_claim_json, null);
  await applyAgentResult('run-closure-feedback-test', {
    ...delegation,
    pipeline: 'test',
    agent: 'test-agent',
    storyIndex: 1,
    resource: 'browser',
    description: '重新验证兼容性行为',
    agileStatus: 'in dev',
    currentSubagent: 'test-agent',
    devIndex: 1,
    testIndex: 0,
  }, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: '旧接口兼容性验证通过。',
    verdict: 'passed',
    tests: [{ command: 'npm test', passed: true }],
  })));
  detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'in review');
  assert.equal(detail?.documentComments.find((comment) => comment.comment_id === commentId)?.status, 'open');
  assert.equal(detail?.documentComments.find((comment) => comment.comment_id === commentId)?.feedback_status, 'verifying');

  const verifyDelegation = (await pipelineForTask(taskId))[0] as Parameters<typeof applyAgentResult>[1];
  assert.equal(verifyDelegation.agent, 'feedback-agent');
  assert.equal(verifyDelegation.pipeline, 'feedback-verify');
  await applyAgentResult('run-feedback-verify', verifyDelegation, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: '兼容性反馈已经处理并通过验证。',
    feedback: {
      mode: 'verify',
      commentId,
      verdict: 'resolved',
      reason: '实现已修复且兼容性回归验证通过。',
      evidence: ['src/compatibility.ts', 'npm test passed'],
    },
  })));

  await applyAgentResult('run-closure-feedback-review-v2', {
    ...delegation,
    description: '在修复和重新验证后生成新版结卡报告',
    agileStatus: 'in review',
    lastActor: 'test-agent',
  }, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: '实现已修复并重新验证，生成新版结卡报告。',
    artifact: {
      title: '结卡报告 v2',
      content: '## 兼容性\n\n旧接口兼容性已经恢复并通过重新验证。\n\n## 评论处理\n\n用户指出的实现问题已修复。',
    },
    verdict: 'report_ready',
  })));

  detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'ready_to_close');
  assert.equal(detail?.task.closure_status, 'awaiting_read');
  assert.equal(detail?.task.review_revision, 2);
  assert.notEqual(detail?.task.review_document_id, documentId);
  assert.equal(detail?.documentComments.find((comment) => comment.comment_id === commentId)?.status, 'resolved');
  assert.equal(detail?.documentComments.find((comment) => comment.comment_id === commentId)?.feedback_status, 'resolved');
  assert.equal(detail?.documentComments.find((comment) => comment.comment_id === commentId)?.evolution_status, 'pending');
  assert.equal(detail?.closureAcknowledgements.length, 0);

  await acknowledgeClosure({ taskId, reviewRevision: 2 });
  detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'done');
  assert.equal(detail?.closureAcknowledgements[0]?.review_revision, 2);
});

test('clears stale delivery units when the Harness routes feedback back to planning', async () => {
  const { getTask, pipelineForTask, rewindTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-review-rewind-plan';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Review replan', 'feature', 'in review', 'review-agent', 1, 1, 1, 1, 1, '')
  `).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Old boundary', 'story-001')").run(taskId);
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json)
    VALUES('SPEC-review-replan', ?, 1, 1, 'resolved', '{}')
  `).run(taskId);

  await rewindTask({ taskId, actor: 'system', to: 'plan', reason: '用户评论要求重新划分交付边界' });
  const detail = await getTask(taskId);
  assert.equal(detail?.task.total_stories, 0);
  assert.equal(detail?.task.analysis_index, 0);
  assert.equal(detail?.task.dev_index, 0);
  assert.equal(detail?.task.test_index, 0);
  assert.equal(detail?.stories.length, 0);
  assert.equal(detail?.storySpecs.length, 0);
  assert.equal((await pipelineForTask(taskId))[0]?.agent, 'story-splitter-agent');
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle' WHERE task_id = ?").run(taskId);
});

test('queues a feedback rewind outside the code slot when another task already owns it', async () => {
  const { getTask, pipelineForTask, rewindTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const ownerId = 'TASK-feedback-code-owner';
  const rewoundId = 'TASK-feedback-code-waiter';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Code owner', 'feature', 'in dev', 'dev-agent', 1, 1, 0, 1, 1, '')
  `).run(ownerId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Owner unit', 'story-001')").run(ownerId);
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index,
      run_state, closure_status, review_revision, review_document_id, work_dir
    ) VALUES(?, 'Feedback waiter', 'feature', 'ready_to_close', NULL, 1, 1, 1, 1, 1,
      'idle', 'awaiting_read', 1, 'DOC-feedback-code-waiter', '')
  `).run(rewoundId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Waiter unit', 'story-001')").run(rewoundId);
  db.prepare(`
    INSERT INTO documents(document_id, task_id, kind, title, content, source_agent)
    VALUES('DOC-feedback-code-waiter', ?, 'review', 'Review', 'Report', 'review-agent')
  `).run(rewoundId);

  await rewindTask({ taskId: rewoundId, actor: 'system', to: 'context', reason: '需要重新确认需求范围' });
  const detail = await getTask(rewoundId);
  assert.equal(detail?.task.agile_status, 'backlog');
  assert.equal(detail?.task.current_subagent, 'backlog-agent');
  assert.equal((await pipelineForTask(rewoundId))[0]?.agent, 'backlog-agent');
  const codeOwners = db.prepare("SELECT task_id FROM tasks WHERE agile_status = 'in dev'").all() as { task_id: string }[];
  assert.deepEqual(codeOwners.map((item) => item.task_id), [ownerId]);

  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle', current_subagent = NULL WHERE task_id IN (?, ?)").run(ownerId, rewoundId);
});

test('defers feedback across user waits and recovers a durable triaged handoff', async () => {
  const { addDocumentComment, getTask, pipelineForTask, reopenDocumentComment } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-feedback-wait-gate';
  const documentId = 'DOC-feedback-wait-gate';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      run_state, resume_pending, blocked_reason, work_dir
    ) VALUES(?, 'Feedback wait gate', 'feature', 'backlog', 'backlog-agent',
      'waiting_for_answers', 0, 'Need product answer', '')
  `).run(taskId);
  db.prepare(`
    INSERT INTO documents(document_id, task_id, kind, title, content, source_agent)
    VALUES(?, ?, 'context', 'Context', 'Context with an open question.', 'backlog-agent')
  `).run(documentId, taskId);
  const commentId = await addDocumentComment({
    taskId,
    documentId,
    anchorType: 'file',
    content: '这条反馈必须等当前澄清恢复完成后再分流。',
  });
  assert.deepEqual(await pipelineForTask(taskId), []);

  db.prepare(`
    UPDATE tasks SET run_state = 'runnable', resume_pending = 1, blocked_reason = NULL
    WHERE task_id = ?
  `).run(taskId);
  let delegation = (await pipelineForTask(taskId))[0];
  assert.equal(delegation.agent, 'backlog-agent');
  assert.equal(delegation.pipeline, 'resume');

  db.prepare(`
    UPDATE tasks SET agile_status = 'in plan', current_subagent = 'story-splitter-agent', resume_pending = 0
    WHERE task_id = ?
  `).run(taskId);
  delegation = (await pipelineForTask(taskId))[0];
  assert.equal(delegation.agent, 'feedback-agent');
  assert.equal(delegation.pipeline, 'feedback-triage');

  db.prepare("UPDATE document_comments SET feedback_status = 'triaged' WHERE comment_id = ?").run(commentId);
  delegation = (await pipelineForTask(taskId))[0];
  assert.equal(delegation.agent, 'feedback-agent');
  assert.equal(delegation.pipeline, 'feedback-triage');
  assert.equal((await getTask(taskId))?.documentComments[0]?.feedback_status, 'triaged');

  db.prepare(`
    UPDATE document_comments
    SET status = 'resolved', feedback_status = 'resolved', disposition = 'rewind',
        target_stage = 'dev', target_agent = 'dev-agent', target_story_index = 1,
        acceptance_json = '["old"]', triage_reason = 'old',
        resolution_claim_json = '{"summary":"old"}', triaged_at = CURRENT_TIMESTAMP
    WHERE comment_id = ?
  `).run(commentId);
  await reopenDocumentComment({ taskId, commentId });
  const reopened = (await getTask(taskId))?.documentComments[0];
  assert.equal(reopened?.feedback_status, 'reopened');
  assert.equal(reopened?.target_stage, null);
  assert.equal(reopened?.target_agent, null);
  assert.equal(reopened?.resolution_claim_json, null);
  db.prepare("UPDATE document_comments SET status = 'resolved', feedback_status = 'resolved' WHERE comment_id = ?").run(commentId);
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle', current_subagent = NULL WHERE task_id = ?").run(taskId);
});

test('holds review-targeted feedback until the normal forward flow reaches Review', async () => {
  const { addDocumentComment, applyFeedbackTriage, getTask, pipelineForTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-feedback-review-deferred';
  const documentId = 'DOC-feedback-review-deferred';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Deferred review feedback', 'feature', 'in dev', 'test-agent', 1, 1, 0, 1, 1, '')
  `).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Reviewed unit', 'story-001')").run(taskId);
  db.prepare(`
    INSERT INTO documents(document_id, task_id, kind, title, content, source_agent)
    VALUES(?, ?, 'test_result', 'Test result', 'The final report should use clearer wording.', 'test-agent')
  `).run(documentId, taskId);
  const commentId = await addDocumentComment({ taskId, documentId, anchorType: 'file', content: '请在最终报告中澄清这个表述。' });

  await applyFeedbackTriage(taskId, {
    commentId,
    disposition: 'revise',
    targetStage: 'review',
    reason: '只需在最终报告中修订表述。',
    acceptance: ['最终报告使用无歧义表述'],
  });
  const detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'in dev');
  assert.equal(detail?.documentComments[0]?.target_agent, 'review-agent');
  assert.equal(detail?.documentComments[0]?.feedback_status, 'in_progress');
  assert.equal((await pipelineForTask(taskId))[0]?.agent, 'test-agent');

  db.prepare("UPDATE document_comments SET status = 'resolved', feedback_status = 'resolved' WHERE comment_id = ?").run(commentId);
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle', current_subagent = NULL WHERE task_id = ?").run(taskId);
});

test('applies valid Feedback decisions and leaves omitted comments queued for the next turn', async () => {
  const { parseAgentResult } = await import('../domain/agent-result');
  const { applyAgentResult } = await import('./agent-results');
  const { addDocumentComment, getTask, pipelineForTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-feedback-partial-batch';
  const documentId = 'DOC-feedback-partial-batch';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Partial feedback batch', 'feature', 'in review', 'review-agent', 1, 1, 1, 1, 1, '')
  `).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Reviewed unit', 'story-001')").run(taskId);
  db.prepare(`
    INSERT INTO documents(document_id, task_id, story_index, kind, title, content, source_agent)
    VALUES(?, ?, 1, 'test_result', 'Verification result', 'Evidence', 'test-agent')
  `).run(documentId, taskId);
  const first = await addDocumentComment({ taskId, documentId, anchorType: 'file', content: '补充第一个测试说明。' });
  const second = await addDocumentComment({ taskId, documentId, anchorType: 'file', content: '补充第二个测试说明。' });
  const delegation = (await pipelineForTask(taskId))[0] as Parameters<typeof applyAgentResult>[1];
  await applyAgentResult('run-feedback-partial-batch', delegation, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: '本轮只形成了第一条评论的有效判断。',
    feedback: {
      mode: 'triage',
      decisions: [{
        commentId: first,
        disposition: 'revise',
        targetStage: 'test',
        targetDeliveryUnit: 1,
        reason: '需要补充验证证据。',
        acceptance: ['验证结果包含对应证据'],
      }],
    },
  })));
  const detail = await getTask(taskId);
  const comments = new Map(detail?.documentComments.map((comment) => [comment.comment_id, comment]));
  assert.equal(comments.get(first)?.feedback_status, 'in_progress');
  assert.equal(comments.get(second)?.feedback_status, 'submitted');
  const next = (await pipelineForTask(taskId))[0];
  assert.equal(next?.agent, 'feedback-agent');
  assert.deepEqual(next?.feedbackIds, [second]);
  db.prepare("UPDATE document_comments SET status = 'resolved', feedback_status = 'resolved' WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle', current_subagent = NULL WHERE task_id = ?").run(taskId);
});

test('triages one task feedback snapshot as a batch, rewinds once, and defers downstream comments by stage', async () => {
  const { parseAgentResult } = await import('../domain/agent-result');
  const { applyAgentResult } = await import('./agent-results');
  const { addDocumentComment, getTask, pipelineForTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-feedback-batch-frontier';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Feedback batch frontier', 'feature', 'in review', 'review-agent', 2, 2, 2, 2, 2, '')
  `).run(taskId);
  for (let index = 1; index <= 2; index += 1) {
    db.prepare('INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, ?, ?, ?)').run(taskId, index, `Old unit ${index}`, `old-${index}`);
  }
  const documents = [
    { id: 'DOC-feedback-batch-context', story: null, kind: 'context', title: 'Requirement context' },
    { id: 'DOC-feedback-batch-dev', story: 1, kind: 'dev_note', title: 'Implementation note' },
    { id: 'DOC-feedback-batch-test', story: 2, kind: 'test_result', title: 'Test result' },
  ];
  for (const document of documents) {
    db.prepare(`
      INSERT INTO documents(document_id, task_id, story_index, kind, title, content, source_agent)
      VALUES(?, ?, ?, ?, ?, 'Old evidence', 'review-agent')
    `).run(document.id, taskId, document.story, document.kind, document.title);
  }
  const contextComment = await addDocumentComment({ taskId, documentId: documents[0].id, anchorType: 'file', content: '需求范围需要重新确认。' });
  const devComment = await addDocumentComment({ taskId, documentId: documents[1].id, anchorType: 'file', content: '实现需要修正。' });
  const testComment = await addDocumentComment({ taskId, documentId: documents[2].id, anchorType: 'file', content: '测试证据需要补充。' });

  const triage = (await pipelineForTask(taskId))[0] as Parameters<typeof applyAgentResult>[1];
  assert.equal(triage.agent, 'feedback-agent');
  assert.equal(triage.pipeline, 'feedback-triage');
  assert.deepEqual(new Set(triage.feedbackIds), new Set([contextComment, devComment, testComment]));
  await applyAgentResult('run-feedback-batch-frontier', triage, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: '三个评论已完成批量分流。',
    feedback: {
      mode: 'triage',
      decisions: [
        { commentId: contextComment, disposition: 'rewind', targetStage: 'context', reason: '需求范围失效。', acceptance: ['重新确认需求范围'] },
        { commentId: devComment, disposition: 'revise', targetStage: 'dev', targetDeliveryUnit: 1, reason: '实现需要修正。', acceptance: ['实现符合更新后的规格'] },
        { commentId: testComment, disposition: 'revise', targetStage: 'test', targetDeliveryUnit: 2, reason: '测试证据不足。', acceptance: ['补齐测试证据'] },
      ],
    },
  })));

  let detail = await getTask(taskId);
  assert.equal(detail?.task.total_stories, 0);
  assert.equal(detail?.task.current_subagent, 'backlog-agent');
  const comments = new Map(detail?.documentComments.map((comment) => [comment.comment_id, comment]));
  assert.equal(comments.get(contextComment)?.feedback_is_rewind_frontier, 1);
  assert.equal(comments.get(contextComment)?.feedback_needs_rebase, 0);
  assert.equal(comments.get(devComment)?.feedback_is_rewind_frontier, 0);
  assert.equal(comments.get(devComment)?.feedback_needs_rebase, 1);
  assert.equal(comments.get(testComment)?.feedback_needs_rebase, 1);
  assert.equal((await pipelineForTask(taskId))[0]?.agent, 'backlog-agent');

  const lateComment = await addDocumentComment({ taskId, documentId: documents[2].id, anchorType: 'file', content: '回退期间新增的测试评论。' });
  const lateTriage = (await pipelineForTask(taskId))[0] as Parameters<typeof applyAgentResult>[1];
  assert.deepEqual(lateTriage.feedbackIds, [lateComment]);
  await applyAgentResult('run-feedback-batch-late-comment', lateTriage, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: '后续阶段评论只登记，不跳转。',
    feedback: {
      mode: 'triage',
      decisions: [{ commentId: lateComment, disposition: 'revise', targetStage: 'test', targetDeliveryUnit: 2, reason: '应在 Test 阶段处理。', acceptance: ['覆盖新增测试意见'] }],
    },
  })));
  detail = await getTask(taskId);
  assert.equal(detail?.task.current_subagent, 'backlog-agent');
  assert.equal(detail?.documentComments.find((comment) => comment.comment_id === lateComment)?.feedback_needs_rebase, 1);
  assert.equal((await pipelineForTask(taskId))[0]?.agent, 'backlog-agent');

  for (let index = 1; index <= 2; index += 1) {
    db.prepare('INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, ?, ?, ?)').run(taskId, index, `New unit ${index}`, `new-${index}`);
  }
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'ready for dev', current_subagent = 'analyst-agent',
        total_stories = 2, analysis_index = 0, dev_index = 0, test_index = 0, spec_resolved_index = 0
    WHERE task_id = ?
  `).run(taskId);
  const rebase = (await pipelineForTask(taskId))[0] as Parameters<typeof applyAgentResult>[1];
  assert.equal(rebase.agent, 'feedback-agent');
  assert.deepEqual(new Set(rebase.feedbackIds), new Set([devComment, testComment, lateComment]));
  await applyAgentResult('run-feedback-batch-rebase', rebase, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: '后续评论已绑定到新交付单元，不产生新的跳转。',
    feedback: {
      mode: 'triage',
      decisions: [
        { commentId: devComment, disposition: 'revise', targetStage: 'dev', targetDeliveryUnit: 1, reason: '绑定新单元 1。', acceptance: ['实现符合更新后的规格'] },
        { commentId: testComment, disposition: 'revise', targetStage: 'test', targetDeliveryUnit: 2, reason: '绑定新单元 2。', acceptance: ['补齐测试证据'] },
        { commentId: lateComment, disposition: 'revise', targetStage: 'test', targetDeliveryUnit: 2, reason: '绑定新单元 2。', acceptance: ['覆盖新增测试意见'] },
      ],
    },
  })));
  detail = await getTask(taskId);
  assert.equal(detail?.task.analysis_index, 0);
  assert.equal(detail?.task.dev_index, 0);
  assert.equal(detail?.task.test_index, 0);
  assert.ok(detail?.documentComments.filter((comment) => [devComment, testComment, lateComment].includes(comment.comment_id)).every((comment) => comment.feedback_needs_rebase === 0));
  assert.equal((await pipelineForTask(taskId))[0]?.agent, 'analyst-agent');

  db.prepare("UPDATE document_comments SET status = 'resolved', feedback_status = 'resolved' WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle', current_subagent = NULL WHERE task_id = ?").run(taskId);
});

test('merges feedback for different delivery units into one cursor rewind', async () => {
  const { applyFeedbackTriageBatch, addDocumentComment, getTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-feedback-vector-rewind';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Feedback vector rewind', 'feature', 'in review', 'review-agent', 3, 3, 3, 3, 3, '')
  `).run(taskId);
  const commentIds: string[] = [];
  for (let index = 1; index <= 3; index += 1) {
    db.prepare('INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, ?, ?, ?)').run(taskId, index, `Unit ${index}`, `unit-${index}`);
    const documentId = `DOC-feedback-vector-${index}`;
    db.prepare(`
      INSERT INTO documents(document_id, task_id, story_index, kind, title, content, source_agent)
      VALUES(?, ?, ?, 'review', ?, 'Evidence', 'review-agent')
    `).run(documentId, taskId, index, `Unit ${index} review`);
    commentIds.push(await addDocumentComment({ taskId, documentId, anchorType: 'file', content: `Comment ${index}` }));
  }
  await applyFeedbackTriageBatch(taskId, [
    { commentId: commentIds[2], disposition: 'rewind', targetStage: 'analysis', targetDeliveryUnit: 3, reason: 'Unit 3 analysis changed.', acceptance: ['Reanalyze unit 3'] },
    { commentId: commentIds[0], disposition: 'rewind', targetStage: 'dev', targetDeliveryUnit: 1, reason: 'Unit 1 implementation changed.', acceptance: ['Reimplement unit 1'] },
    { commentId: commentIds[1], disposition: 'rewind', targetStage: 'test', targetDeliveryUnit: 2, reason: 'Unit 2 verification changed.', acceptance: ['Retest unit 2'] },
  ], 'execution-feedback-vector');

  const detail = await getTask(taskId);
  assert.equal(detail?.task.analysis_index, 2);
  assert.equal(detail?.task.dev_index, 0);
  assert.equal(detail?.task.test_index, 0);
  assert.equal(detail?.documentComments.find((comment) => comment.comment_id === commentIds[0])?.feedback_is_rewind_frontier, 1);
  assert.equal(detail?.events.filter((event) => event.event_type === 'FeedbackBatchRewound').length, 1);
  assert.equal(detail?.events.filter((event) => event.event_type === 'TaskRewound').length, 0);

  db.prepare("UPDATE document_comments SET status = 'resolved', feedback_status = 'resolved' WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle', current_subagent = NULL WHERE task_id = ?").run(taskId);
});

test('preserves a pending repro stage after an earlier context feedback rewind', async () => {
  const { parseAgentResult } = await import('../domain/agent-result');
  const { applyAgentResult } = await import('./agent-results');
  const { addDocumentComment, applyFeedbackTriageBatch, pipelineForTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-feedback-context-then-repro';
  const documentId = 'DOC-feedback-context-then-repro';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Context then repro', 'bug', 'in review', 'review-agent', 1, 1, 1, 1, 1, '')
  `).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Old unit', 'old-unit')").run(taskId);
  db.prepare(`
    INSERT INTO documents(document_id, task_id, kind, title, content, source_agent)
    VALUES(?, ?, 'review', 'Review', 'Evidence', 'review-agent')
  `).run(documentId, taskId);
  const contextComment = await addDocumentComment({ taskId, documentId, anchorType: 'file', content: '重新确认需求。' });
  const reproComment = await addDocumentComment({ taskId, documentId, anchorType: 'file', content: '重新复现问题。' });
  await applyFeedbackTriageBatch(taskId, [
    { commentId: contextComment, disposition: 'rewind', targetStage: 'context', reason: 'Context changed.', acceptance: ['Context refreshed'] },
    { commentId: reproComment, disposition: 'rewind', targetStage: 'repro', reason: 'Repro evidence missing.', acceptance: ['Repro refreshed'] },
  ], 'execution-context-repro');

  const backlog = (await pipelineForTask(taskId))[0] as Parameters<typeof applyAgentResult>[1];
  assert.equal(backlog.agent, 'backlog-agent');
  await applyAgentResult('run-context-repro-backlog', backlog, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: '上下文已更新；通常会直接进入规划。',
    classification: 'bug',
    route: 'plan',
    feedbackResolutions: [{ commentId: contextComment, summary: '上下文已更新。', evidence: ['context'] }],
  })));
  const repro = (await pipelineForTask(taskId))[0];
  assert.equal(repro.agent, 'repro-agent');
  assert.equal(repro.pipeline, 'repro');

  db.prepare("UPDATE document_comments SET status = 'resolved', feedback_status = 'resolved' WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle', current_subagent = NULL WHERE task_id = ?").run(taskId);
});

test('recovers the original feedback batch snapshot when applying a queued result', async () => {
  const { parseAgentResult } = await import('../domain/agent-result');
  const { applyNextQueuedAgentResult } = await import('./agent-results');
  const { beginExecutionAttempt } = await import('./executions');
  const { addDocumentComment, createTask, pipelineForTask, upsertDocument, getTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  db.prepare("UPDATE agent_results SET application_status = 'applied' WHERE application_status = 'pending'").run();
  const taskId = await createTask({ title: 'Recover feedback batch snapshot' });
  const documentId = await upsertDocument({ taskId, kind: 'context', title: 'Context', content: 'Context', actor: 'backlog-agent' });
  const firstComment = await addDocumentComment({ taskId, documentId, anchorType: 'file', content: 'First comment' });
  const secondComment = await addDocumentComment({ taskId, documentId, anchorType: 'file', content: 'Second comment' });
  const delegation = (await pipelineForTask(taskId))[0] as Parameters<typeof beginExecutionAttempt>[0]['delegation'];
  assert.deepEqual(new Set(delegation.feedbackIds), new Set([firstComment, secondComment]));
  const attempt = await beginExecutionAttempt({ runId: 'run-feedback-batch-recovery', delegation, prompt: 'feedback batch prompt' });
  const result = parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'Both comments only need a recorded reply.',
    feedback: {
      mode: 'triage',
      decisions: [
        { commentId: firstComment, disposition: 'reply', reason: 'Answered by existing evidence.', acceptance: [] },
        { commentId: secondComment, disposition: 'no_change', reason: 'No delivery change is needed.', acceptance: [] },
      ],
    },
  }));
  db.prepare(`
    INSERT INTO agent_results(
      result_id, run_id, task_id, story_index, agent, pipeline, outcome,
      result_json, application_status, execution_id
    ) VALUES('RESULT-feedback-batch-recovery', 'run-feedback-batch-recovery', ?, NULL,
      'feedback-agent', 'feedback-triage', 'completed', ?, 'pending', ?)
  `).run(taskId, JSON.stringify(result), attempt.attempt.execution_id);

  const applied = await applyNextQueuedAgentResult();
  assert.equal(applied.status, 'applied');
  const detail = await getTask(taskId);
  assert.ok(detail?.documentComments.every((comment) => comment.feedback_batch_id === attempt.attempt.execution_id));
  assert.ok(detail?.documentComments.every((comment) => comment.feedback_status === 'verifying'));

  db.prepare("UPDATE document_comments SET status = 'resolved', feedback_status = 'resolved' WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle', current_subagent = NULL WHERE task_id = ?").run(taskId);
});

test('lets Feedback Agent choose only a stage while the Harness routes context and repro work', async () => {
  const { parseAgentResult } = await import('../domain/agent-result');
  const { applyAgentResult } = await import('./agent-results');
  const {
    FEEDBACK_STAGE_AGENTS,
    answerQuestion,
    addDocumentComment,
    applyFeedbackTriage,
    getTask,
    pipelineForTask,
    submitClarificationAnswers,
  } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();

  assert.deepEqual(FEEDBACK_STAGE_AGENTS, {
    context: 'backlog-agent',
    repro: 'repro-agent',
    plan: 'story-splitter-agent',
    analysis: 'analyst-agent',
    dev: 'dev-agent',
    test: 'test-agent',
    review: 'review-agent',
  });

  for (const stage of ['context', 'repro'] as const) {
    const taskId = `TASK-feedback-stage-${stage}`;
    const documentId = `DOC-feedback-stage-${stage}`;
    db.prepare(`
      INSERT INTO tasks(
        task_id, title, item_type, agile_status, current_subagent,
        analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
      ) VALUES(?, ?, 'bug', 'in review', 'review-agent', 1, 1, 1, 1, 1, '')
    `).run(taskId, `Feedback ${stage} routing`);
    db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Old unit', 'story-001')").run(taskId);
    db.prepare(`
      INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json)
      VALUES(?, ?, 1, 1, 'resolved', '{}')
    `).run(`SPEC-feedback-stage-${stage}`, taskId);
    db.prepare(`
      INSERT INTO documents(document_id, task_id, kind, title, content, source_agent)
      VALUES(?, ?, 'review', 'Review report', 'The report needs correction.', 'review-agent')
    `).run(documentId, taskId);
    const commentId = await addDocumentComment({
      taskId,
      documentId,
      anchorType: 'file',
      content: stage === 'context' ? '需求范围理解错误，请重新收集上下文。' : '缺少可靠的 Bug 复现与根因证据。',
    });

    await applyFeedbackTriage(taskId, {
      commentId,
      disposition: 'rewind',
      targetStage: stage,
      reason: `Feedback requires ${stage}`,
      acceptance: [`${stage} evidence is refreshed`],
    });
    await applyFeedbackTriage(taskId, {
      commentId,
      disposition: 'rewind',
      targetStage: stage,
      reason: `Feedback requires ${stage}`,
      acceptance: [`${stage} evidence is refreshed`],
    });

    let detail = await getTask(taskId);
    const comment = detail?.documentComments.find((item) => item.comment_id === commentId);
    assert.equal(comment?.target_stage, stage);
    assert.equal(comment?.target_agent, FEEDBACK_STAGE_AGENTS[stage]);
    assert.equal(detail?.task.current_subagent, FEEDBACK_STAGE_AGENTS[stage]);
    assert.equal(detail?.task.total_stories, 0);
    const routed = (await pipelineForTask(taskId))[0];
    assert.equal(routed?.agent, FEEDBACK_STAGE_AGENTS[stage]);
    assert.equal(routed?.pipeline, stage === 'context' ? 'backlog' : 'repro');

    let targetDelegation = routed;
    if (stage === 'context') {
      await applyAgentResult('run-feedback-stage-context-question', targetDelegation as Parameters<typeof applyAgentResult>[1], parseAgentResult(JSON.stringify({
        outcome: 'needs_input',
        summary: '原始上下文无法确定该需求是否仍需要保留旧兼容行为。',
        questions: [{
          decisionKey: 'legacy-compatibility',
          title: '确认兼容范围',
          question: '本轮是否仍要求保留旧兼容行为？',
          why: '答案会改变需求边界。',
          recommendation: '保留旧兼容行为。',
          alternatives: [
            { id: 'keep', label: '保留', consequences: ['继续支持旧调用方'] },
            { id: 'remove', label: '移除', consequences: ['旧调用方需迁移'] },
          ],
        }],
      })));
      detail = await getTask(taskId);
      const question = detail?.questions.find((item) => item.source_agent === 'backlog-agent' && item.status === 'pending');
      assert.ok(question);
      await answerQuestion({ taskId, questionId: question!.question_id, answer: '保留旧兼容行为。' });
      await submitClarificationAnswers(taskId);
      targetDelegation = (await pipelineForTask(taskId))[0];
      assert.equal(targetDelegation.pipeline, 'resume');
    }

    const result = stage === 'context'
      ? parseAgentResult(JSON.stringify({
        outcome: 'completed',
        summary: '已重新确认需求范围与任务分类。',
        classification: 'bug',
        route: 'plan',
        feedbackResolutions: [{ commentId, summary: '上下文已更新。', evidence: ['context document'] }],
      }))
      : parseAgentResult(JSON.stringify({
        outcome: 'completed',
        summary: '已复现问题并定位根因。',
        artifact: { title: 'Bug repro', content: 'Reproduction and root-cause evidence.' },
        route: 'plan',
        feedbackResolutions: [{ commentId, summary: '复现与根因证据已补齐。', evidence: ['repro document'] }],
      }));
    await applyAgentResult(`run-feedback-stage-${stage}`, targetDelegation as Parameters<typeof applyAgentResult>[1], result);
    detail = await getTask(taskId);
    assert.ok(detail?.documentComments.find((item) => item.comment_id === commentId)?.resolution_claim_json);
    if (stage === 'context') assert.equal(detail?.questions.find((item) => item.source_agent === 'backlog-agent')?.status, 'resolved');
    assert.equal(detail?.task.agile_status, 'in dev');
    assert.equal(detail?.task.current_subagent, 'story-splitter-agent');

    const split = (await pipelineForTask(taskId))[0];
    assert.equal(split?.agent, 'story-splitter-agent');
    await applyAgentResult(`run-feedback-stage-${stage}-split`, split as Parameters<typeof applyAgentResult>[1], parseAgentResult(JSON.stringify({
      outcome: 'completed',
      summary: '已根据更新后的上下文重新拆分交付单元。',
      deliveryUnits: [{ title: 'Updated delivery unit' }],
    })));
    detail = await getTask(taskId);
    assert.equal(detail?.task.agile_status, 'in dev');
    assert.equal(detail?.task.current_subagent, 'analyst-agent');
    assert.equal(detail?.task.total_stories, 1);

    db.prepare("UPDATE document_comments SET status = 'resolved', feedback_status = 'resolved' WHERE comment_id = ?").run(commentId);
    db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle', current_subagent = NULL WHERE task_id = ?").run(taskId);
  }
});

test('versions Slice Specs and advances Dev without requiring a commit', async () => {
  const { addQuestion, answerQuestion, getTask, saveStorySpec, updateTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-versioned-slice-spec';
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, current_subagent, total_stories, work_dir)
    VALUES(?, 'Versioned slice spec', 'feature', 'ready for dev', 'analyst-agent', 1, '')
  `).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Contracted unit', 'story-001')").run(taskId);

  const baseSpec = {
    goal: 'Deliver one deterministic behavior.',
    scope: { included: ['The contracted behavior'], excluded: ['Other features'] },
    behaviors: [{ scenario: 'The behavior is invoked', expected: 'The documented result is produced' }],
    decisions: [],
    decisionTree: [{
      key: 'output-mode',
      question: 'Which output mode should be used?',
      impact: 'Changes the visible output contract.',
      options: [
        { id: 'structured', label: 'Structured JSON', consequences: ['Stable machine-readable contract'] },
        { id: 'text', label: 'Readable text', consequences: ['Optimized for direct reading'] },
      ],
      status: 'needs_user_input' as const,
    }],
    ambiguities: [{ key: 'output-mode', description: 'The output mode must be chosen.' }],
    acceptanceCriteria: [{ id: 'AC-1', description: 'The runtime is available', oracle: 'node --version exits with zero' }],
    verificationPlan: [{ criterionId: 'AC-1', kind: 'command' as const, instruction: 'Check Node runtime', command: 'node --version' }],
    dependencies: [],
    changeBudget: { capabilities: ['One behavior'], paths: [] },
  };
  const first = await saveStorySpec({ taskId, storyIndex: 1, status: 'waiting_for_answers', spec: baseSpec });
  const questionId = await addQuestion({
    taskId,
    storyIndex: 1,
    actor: 'analyst-agent',
    kind: 'analysis',
    title: 'Choose output mode',
    question: 'Which output mode should be used?',
    decisionKey: 'output-mode',
    specRevision: first.revision,
  });
  await answerQuestion({ taskId, questionId, answer: 'Use structured JSON.' });
  const second = await saveStorySpec({
    taskId,
    storyIndex: 1,
    status: 'resolved',
    spec: {
      ...baseSpec,
      decisions: [{ key: 'output-mode', decision: 'Structured JSON', rationale: 'User answer', source: 'user' as const }],
      decisionTree: [{
        ...baseSpec.decisionTree[0],
        status: 'resolved_from_context' as const,
        selectedOption: 'structured',
        source: 'user' as const,
        evidence: ['The user answered: Use structured JSON.'],
      }],
      ambiguities: [],
    },
  });
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);

  db.prepare("UPDATE tasks SET analysis_index = 1, spec_resolved_index = 1, current_subagent = 'dev-agent' WHERE task_id = ?").run(taskId);
  await updateTask(taskId, 'dev-agent', {
    agile_status: 'in dev',
    current_subagent: 'dev-agent',
    dev_index: 1,
    next_step: '现有实现已经满足规格，无须创建 commit',
  });

  const detail = await getTask(taskId);
  assert.deepEqual(detail?.storySpecs.map((item) => [item.revision, item.status]), [[1, 'superseded'], [2, 'resolved']]);
  assert.equal(detail?.questions.find((item) => item.question_id === questionId)?.status, 'resolved');
});

test('lets Dev and Test request runtime information and resume the same delivery unit', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { beginEvolutionRun } = await import('./agent-evolution');
  const { completeExecution } = await import('./executions');
  const { parseAgentResult } = await import('../domain/agent-result');
  const {
    answerRuntimeInput,
    getTask,
    pipelineForTask,
    submitRuntimeInputs,
  } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle'").run();
  const taskId = 'TASK-runtime-input-resume';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Runtime input resume', 'feature', 'ready for dev', 'analyst-agent', 1, 1, 1, '')
  `).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Runtime-aware unit', 'story-001')").run(taskId);
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json)
    VALUES('SPEC-runtime-input', ?, 1, 1, 'resolved', '{}')
  `).run(taskId);

  const addExecution = (executionId: string, agent: string, pipeline: string) => db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, story_index, agent, pipeline, delegation_key,
      attempt, status, input_hash, input_json
    ) VALUES(?, 'run-runtime-input', ?, 1, ?, ?, ?, 1, 'output_received', ?, '{}')
  `).run(executionId, taskId, agent, pipeline, `key-${executionId}`, `hash-${executionId}`);
  const envelope = (agent: 'dev-agent' | 'test-agent', pipeline: string) => ({
    taskId,
    pipeline,
    agent,
    storyIndex: 1,
    resource: agent === 'test-agent' ? 'browser' as const : 'none' as const,
    description: 'runtime input test',
    title: 'Runtime input resume',
    taskDescription: null,
    itemType: 'feature',
    priority: '',
    link: '',
    externalId: '',
    externalStatus: '',
    agileStatus: agent === 'dev-agent' ? 'ready for dev' : 'in dev',
    currentSubagent: agent,
    resumePending: 0,
    specResolvedIndex: 1,
    runState: 'runnable',
    closureStatus: 'none',
    reviewRevision: 0,
    reviewDocumentId: '',
    lastActor: '',
    analysisIndex: 1,
    devIndex: agent === 'dev-agent' ? 0 : 1,
    testIndex: 0,
    totalStories: 1,
    nextStep: '',
    blockedReason: '',
    owner: '',
    evidence: '',
    risk: '',
  });

  addExecution('execution-runtime-dev-request', 'dev-agent', 'dev');
  await applyAgentResult('run-runtime-input', envelope('dev-agent', 'dev'), parseAgentResult(JSON.stringify({
    outcome: 'needs_input',
    summary: 'Commit hook requires a delivery card number.',
    runtimeInputs: [{
      title: '交付单元卡号',
      question: '本次提交应关联哪个交付单元卡号？',
      why: '仓库 commit-msg hook 要求该字段。',
      recommendation: '无关联项时确认仓库允许的占位值。',
    }],
  })), { executionId: 'execution-runtime-dev-request' });
  await completeExecution('execution-runtime-dev-request');

  let detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'ready for dev');
  assert.equal(detail?.task.run_state, 'waiting_for_runtime_input');
  assert.equal(detail?.task.current_subagent, 'dev-agent');
  assert.equal(detail?.runtimeInputs[0]?.status, 'pending');
  await answerRuntimeInput({ taskId, requestId: detail!.runtimeInputs[0].request_id, answer: '#N/A' });
  await submitRuntimeInputs(taskId);
  assert.deepEqual((await pipelineForTask(taskId))[0], {
    taskId,
    lane: 'delivery',
    pipeline: 'resume',
    agent: 'dev-agent',
    storyIndex: 1,
    resource: 'none',
    description: '读取人工输入，并恢复 Delivery Lane',
  });

  addExecution('execution-runtime-dev-resume', 'dev-agent', 'resume');
  await applyAgentResult('run-runtime-input', envelope('dev-agent', 'resume'), parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'Implementation completed using the supplied repository metadata.',
    changedFiles: [],
  })), { executionId: 'execution-runtime-dev-resume' });
  await completeExecution('execution-runtime-dev-resume');
  detail = await getTask(taskId);
  assert.equal(detail?.task.dev_index, 1);
  assert.equal(detail?.runtimeInputs[0]?.status, 'resolved');
  assert.equal(detail?.runtimeInputs[0]?.resolved_execution_id, 'execution-runtime-dev-resume');
  const evolution = await beginEvolutionRun({
    executionId: 'execution-runtime-dev-resume',
    taskId,
    storyIndex: 1,
    agentId: 'dev-agent',
    attempt: 1,
    promptVersion: 1,
    result: { outcome: 'completed', summary: 'Resumed successfully.' },
    applicationOutcome: 'advanced',
    diagnostics: [],
  });
  assert.match(evolution?.prompt || '', /交付单元卡号/);
  assert.match(evolution?.prompt || '', /#N\/A/);

  addExecution('execution-runtime-test-request', 'test-agent', 'test');
  await applyAgentResult('run-runtime-input', envelope('test-agent', 'test'), parseAgentResult(JSON.stringify({
    outcome: 'needs_input',
    summary: 'A target test environment is required.',
    runtimeInputs: [{ title: '测试环境', question: '应在哪个已配置环境执行黑盒验证？' }],
  })), { executionId: 'execution-runtime-test-request' });
  await completeExecution('execution-runtime-test-request');
  detail = await getTask(taskId);
  const testInput = detail!.runtimeInputs.find((input) => input.source_agent === 'test-agent')!;
  assert.equal(detail?.task.run_state, 'waiting_for_runtime_input');
  await answerRuntimeInput({ taskId, requestId: testInput.request_id, answer: '使用本地预览环境。' });
  await submitRuntimeInputs(taskId);
  assert.equal((await pipelineForTask(taskId))[0]?.agent, 'test-agent');
  assert.equal((await pipelineForTask(taskId))[0]?.pipeline, 'resume');

  addExecution('execution-runtime-test-resume', 'test-agent', 'resume');
  await applyAgentResult('run-runtime-input', envelope('test-agent', 'resume'), parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'Black-box verification passed.',
    verdict: 'passed',
    tests: [{ command: 'npm test', passed: true }],
  })), { executionId: 'execution-runtime-test-resume' });
  await completeExecution('execution-runtime-test-resume');
  detail = await getTask(taskId);
  assert.equal(detail?.task.test_index, 1);
  assert.equal(detail?.task.agile_status, 'in review');
  assert.equal(detail?.runtimeInputs.find((input) => input.source_agent === 'test-agent')?.status, 'resolved');
});

test('persists execution input before work and recovers output without rerunning the Agent', async () => {
  const { createTask, pipelineAllEnvelopes } = await import('./tasks');
  const {
    beginExecutionAttempt,
    completeExecution,
    markExecutionOutput,
    recoverNextExecutionAttempt,
    recordExecutionReceipt,
  } = await import('./executions');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Durable execution input' });
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle' WHERE task_id != ?").run(taskId);
  const delegation = (await pipelineAllEnvelopes()).find((item) => item.taskId === taskId);
  assert.ok(delegation);

  const started = await beginExecutionAttempt({ runId: 'run-durable-test', delegation, prompt: 'stable prompt' });
  assert.equal(started.recovered, false);
  assert.equal(started.attempt.status, 'running');
  await markExecutionOutput(started.attempt.execution_id, { outcome: 'completed', summary: 'captured output' });
  const recoverable = await recoverNextExecutionAttempt();
  assert.equal(recoverable?.execution_id, started.attempt.execution_id);
  assert.match(recoverable?.result_json || '', /captured output/);

  await recordExecutionReceipt(started.attempt.execution_id, 'code_commit', 'abc123', { committed: true });
  await completeExecution(started.attempt.execution_id);
  const repeated = await beginExecutionAttempt({ runId: 'run-durable-test-2', delegation, prompt: 'stable prompt' });
  assert.equal(repeated.recovered, true);
  assert.equal(repeated.attempt.status, 'applied');
  const row = db.prepare('SELECT code_commit FROM execution_attempts WHERE execution_id = ?').get(started.attempt.execution_id) as { code_commit: string };
  assert.equal(row.code_commit, 'abc123');
});

test('keeps retry attempts in one logical generation even when the rebuilt prompt changes', async () => {
  const { createTask, pipelineAllEnvelopes } = await import('./tasks');
  const { beginExecutionAttempt, completeExecution, failExecution } = await import('./executions');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Stable retry generation' });
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle' WHERE task_id != ?").run(taskId);
  const delegation = (await pipelineAllEnvelopes()).find((item) => item.taskId === taskId);
  assert.ok(delegation);

  const first = await beginExecutionAttempt({ runId: 'run-retry-1', delegation, prompt: 'prompt before execution history exists' });
  await failExecution(first.attempt.execution_id, 'executor failed', false);
  const second = await beginExecutionAttempt({ runId: 'run-retry-2', delegation, prompt: 'prompt now includes attempt one' });
  await failExecution(second.attempt.execution_id, 'executor failed again', false);
  const third = await beginExecutionAttempt({ runId: 'run-retry-3', delegation, prompt: 'prompt now includes attempts one and two' });

  assert.deepEqual([first.attempt.attempt, second.attempt.attempt, third.attempt.attempt], [1, 2, 3]);
  assert.equal(second.attempt.delegation_key, first.attempt.delegation_key);
  assert.equal(third.attempt.delegation_key, first.attempt.delegation_key);

  await completeExecution(third.attempt.execution_id);
  const rework = await beginExecutionAttempt({ runId: 'run-rework-1', delegation, prompt: 'new rework generation after completion' });
  assert.equal(rework.recovered, false);
  assert.equal(rework.attempt.attempt, 1);
  assert.notEqual(rework.attempt.delegation_key, first.attempt.delegation_key);
  await completeExecution(rework.attempt.execution_id);
});

test('records a late Agent result after cancellation without reopening task lanes or applying effects', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { parseAgentResult } = await import('../domain/agent-result');
  const { cancelTask, createTask, getTask, pipelineAllEnvelopes } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Cancel while Agent is running' });
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle' WHERE task_id != ?").run(taskId);
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE status != 'applied'").run();
  db.prepare("UPDATE agent_results SET application_status = 'applied' WHERE application_status = 'pending'").run();
  const delegation = (await pipelineAllEnvelopes()).find((item) => item.taskId === taskId);
  assert.ok(delegation);

  await cancelTask({ taskId, reason: 'No longer needed' });
  const outcome = await applyAgentResult('run-late-cancelled-result', delegation, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'This result arrived after cancellation.',
  })));

  assert.equal(outcome, 'discarded');
  const detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'cancelled');
  assert.deepEqual(detail?.lanes.map((lane) => lane.status), ['completed', 'completed']);
  const recorded = db.prepare("SELECT application_status, effect_outcome FROM agent_results WHERE task_id = ? AND run_id = 'run-late-cancelled-result'").get(taskId) as { application_status: string; effect_outcome: string };
  assert.deepEqual(recorded, { application_status: 'applied', effect_outcome: 'discarded' });
});

test('isolates feedback scheduling per task and emits one concurrent delegation for each task queue', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { addDocumentComment, createTask, pipelineAllEnvelopes, upsertDocument } = await import('./tasks');
  const feedbackTasks: string[] = [];
  for (const [index, suffix] of ['A', 'B'].entries()) {
    const taskId = await createTask({ title: `Isolated feedback task ${suffix}` });
    const documentId = await upsertDocument({
      taskId,
      kind: 'context',
      title: `Feedback source ${suffix}`,
      content: `Document ${suffix}`,
      actor: 'review-agent',
    });
    await addDocumentComment({
      taskId,
      documentId,
      anchorType: 'file',
      content: `Change request ${suffix}`,
      intent: index === 0 ? 'change_request' : 'question',
    });
    feedbackTasks.push(taskId);
  }
  const normalTaskId = await createTask({ title: 'Task without feedback continues independently' });
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'in plan' WHERE task_id = ?").run(normalTaskId);

  const delegations = await pipelineAllEnvelopes();
  const first = delegations.find((item) => item.taskId === feedbackTasks[0]);
  const second = delegations.find((item) => item.taskId === feedbackTasks[1]);
  const normal = delegations.find((item) => item.taskId === normalTaskId);
  assert.equal(first?.agent, 'feedback-agent');
  assert.equal(second?.agent, 'feedback-agent');
  assert.notEqual(first?.feedbackId, second?.feedbackId);
  assert.equal(normal?.agent, 'story-splitter-agent');
});

test('dispatches independent Analysis and Delivery lanes for the same task', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { pipelineAllEnvelopes, pipelineForTask, toPipeEnvelope } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle'").run();
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE status != 'applied'").run();
  db.prepare("UPDATE agent_results SET application_status = 'applied' WHERE application_status = 'pending'").run();
  const taskId = 'TASK-parallel-lanes';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, priority, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Parallel lanes', 'feature', 'P1', 'ready for dev', 'analyst-agent', 1, 0, 0, 3, 1, '')
  `).run(taskId);
  for (let index = 1; index <= 3; index += 1) {
    db.prepare('INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, ?, ?, ?)').run(taskId, index, `Unit ${index}`, `unit-${index}`);
  }
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json)
    VALUES('SPEC-parallel-1', ?, 1, 1, 'resolved', '{}')
  `).run(taskId);

  const delegations = await pipelineForTask(taskId);
  assert.deepEqual(delegations.map((item) => [item.lane, item.agent, item.storyIndex]).sort(), [
    ['analysis', 'analyst-agent', 2],
    ['delivery', 'dev-agent', 1],
  ]);
  const envelope = (await pipelineAllEnvelopes()).find((item) => item.taskId === taskId && item.lane === 'analysis');
  assert.ok(envelope);
  const pipeColumns = toPipeEnvelope(envelope).split('|');
  assert.deepEqual(pipeColumns.slice(2, 5), ['analysis', 'analyst-agent', '2']);
  assert.equal(pipeColumns[6], 'analysis');
});

test('keeps Delivery runnable while Analysis waits for human clarification', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { getTask, pipelineForTask, setTaskLaneState } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle'").run();
  const taskId = 'TASK-analysis-waits-delivery-runs';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Lane-local clarification', 'feature', 'ready for dev', 'analyst-agent', 1, 0, 0, 2, 1, '')
  `).run(taskId);
  for (let index = 1; index <= 2; index += 1) {
    db.prepare('INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, ?, ?, ?)').run(taskId, index, `Unit ${index}`, `unit-${index}`);
  }
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json)
    VALUES('SPEC-lane-wait-1', ?, 1, 1, 'resolved', '{}')
  `).run(taskId);
  await getTask(taskId);
  await setTaskLaneState({
    taskId,
    lane: 'analysis',
    status: 'waiting_for_answers',
    currentAgent: 'analyst-agent',
    currentStoryIndex: 2,
    blockedReason: 'Need product decision',
  });

  const delegations = await pipelineForTask(taskId);
  assert.deepEqual(delegations.map((item) => [item.lane, item.agent, item.storyIndex]), [['delivery', 'dev-agent', 1]]);
  const detail = await getTask(taskId);
  assert.equal(detail?.lanes.find((lane) => lane.lane === 'analysis')?.status, 'waiting_for_answers');
  assert.equal(detail?.lanes.find((lane) => lane.lane === 'delivery')?.status, 'runnable');

  await setTaskLaneState({ taskId, lane: 'analysis', status: 'runnable' });
  await setTaskLaneState({
    taskId,
    lane: 'delivery',
    status: 'system_blocked',
    currentAgent: 'dev-agent',
    currentStoryIndex: 1,
    blockedReason: 'Development executor unavailable',
  });
  const whileDeliveryBlocked = await pipelineForTask(taskId);
  assert.deepEqual(whileDeliveryBlocked.map((item) => [item.lane, item.agent, item.storyIndex]), [['analysis', 'analyst-agent', 2]]);
});

test('caps Analysis concurrency at four and preserves existing task cursors when lanes are materialized', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { getTask, pipelineAllEnvelopes } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle'").run();
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE status != 'applied'").run();
  db.prepare("UPDATE agent_results SET application_status = 'applied' WHERE application_status = 'pending'").run();

  const preservedTaskId = 'TASK-preserved-lane-cursors';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Preserved cursors', 'feature', 'ready for dev', 'analyst-agent', 3, 2, 1, 4, 3, '')
  `).run(preservedTaskId);
  const preserved = await getTask(preservedTaskId);
  assert.deepEqual(
    [preserved?.task.analysis_index, preserved?.task.dev_index, preserved?.task.test_index],
    [3, 2, 1],
  );
  assert.deepEqual(preserved?.lanes.map((lane) => [lane.lane, lane.status]), [
    ['analysis', 'runnable'],
    ['delivery', 'runnable'],
  ]);
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle' WHERE task_id = ?").run(preservedTaskId);

  const taskIds: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const taskId = `TASK-analysis-cap-${index}`;
    taskIds.push(taskId);
    db.prepare(`
      INSERT INTO tasks(
        task_id, title, item_type, priority, agile_status, current_subagent,
        analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
      ) VALUES(?, ?, 'feature', ?, 'ready for dev', 'analyst-agent', 0, 0, 0, 1, 0, '')
    `).run(taskId, `Analysis cap ${index}`, index === 4 ? 'P0' : 'P3');
    db.prepare('INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, ?, ?)').run(taskId, `Unit ${index}`, `unit-${index}`);
  }
  const analysis = (await pipelineAllEnvelopes()).filter((item) => taskIds.includes(item.taskId) && item.lane === 'analysis');
  assert.equal(analysis.length, 4);
  assert.equal(analysis.some((item) => item.taskId === 'TASK-analysis-cap-4'), true);
});

test('releases only the requested blocked lane and resumes its persisted delivery unit', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { getTask, pipelineForTask, releaseBlock, setTaskLaneState } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle'").run();
  const taskId = 'TASK-two-blocked-lanes';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Two blocked lanes', 'feature', 'ready for dev', 'analyst-agent', 0, 0, 0, 2, 0, '')
  `).run(taskId);
  await getTask(taskId);
  await setTaskLaneState({ taskId, lane: 'analysis', status: 'system_blocked', currentAgent: 'analyst-agent', currentStoryIndex: 1, blockedReason: 'analysis failed' });
  await setTaskLaneState({ taskId, lane: 'delivery', status: 'system_blocked', currentAgent: 'dev-agent', currentStoryIndex: 1, blockedReason: 'delivery failed' });

  await releaseBlock(taskId, 'analysis');

  const detail = await getTask(taskId);
  assert.deepEqual(detail?.lanes.map((lane) => [lane.lane, lane.status, lane.resume_pending]), [
    ['analysis', 'runnable', 1],
    ['delivery', 'system_blocked', 0],
  ]);
  assert.deepEqual((await pipelineForTask(taskId)).map((item) => [item.lane, item.pipeline, item.storyIndex]), [
    ['analysis', 'resume', 1],
  ]);
});

test('opens Review only after both lanes are completed and never skips a post-result lane block', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { getTask, pipelineForTask, releaseBlock, setTaskLaneState } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle'").run();
  const taskId = 'TASK-review-lane-gate';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Review lane gate', 'feature', 'in dev', 'test-agent', 1, 1, 1, 1, 1, '')
  `).run(taskId);
  await getTask(taskId);
  await setTaskLaneState({ taskId, lane: 'analysis', status: 'system_blocked', currentAgent: 'analyst-agent', currentStoryIndex: 1, blockedReason: 'post-result hook failed' });

  assert.deepEqual(await pipelineForTask(taskId), []);
  await releaseBlock(taskId, 'analysis');
  assert.deepEqual((await pipelineForTask(taskId)).map((item) => [item.lane, item.pipeline, item.storyIndex]), [
    ['analysis', 'resume', 1],
  ]);

  await setTaskLaneState({ taskId, lane: 'analysis', status: 'completed' });
  const review = await pipelineForTask(taskId);
  assert.equal(review.length, 1);
  assert.deepEqual([review[0].lane, review[0].agent, review[0].pipeline], ['control', 'review-agent', 'review']);
});

test('does not dispatch Review when a task is manually moved to review with incomplete units', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { pipelineForTask } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle'").run();
  const taskId = 'TASK-incomplete-manual-review';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Incomplete manual review', 'feature', 'in review', 'review-agent', 1, 0, 0, 2, 1, '')
  `).run(taskId);
  assert.deepEqual(await pipelineForTask(taskId), []);
});

test('treats legacy task-level blocked state as an exclusive control gate', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { getTask, pipelineAllEnvelopes, pipelineForTask } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle'").run();
  const taskId = 'TASK-global-control-block';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, resume_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index,
      run_state, blocked_reason, work_dir
    ) VALUES(?, 'Global control block', 'feature', 'blocked', 'ready for dev', 'story-splitter-agent',
      1, 0, 0, 2, 1, 'system_blocked', 'control failed', '')
  `).run(taskId);
  const detail = await getTask(taskId);
  assert.equal(detail?.lanes.some((lane) => lane.status === 'runnable'), true);
  assert.deepEqual(await pipelineForTask(taskId), []);
  assert.equal((await pipelineAllEnvelopes()).some((item) => item.taskId === taskId), false);
});

test('counts one active Analysis lane once when both its execution and queued result are visible', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { pipelineAllEnvelopes } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle'").run();
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE status != 'applied'").run();
  db.prepare("UPDATE agent_results SET application_status = 'applied' WHERE application_status = 'pending'").run();
  const activeTaskId = 'TASK-active-analysis-dedup';
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, current_subagent, total_stories, work_dir)
    VALUES(?, 'Active Analysis', 'feature', 'ready for dev', 'analyst-agent', 1, '')
  `).run(activeTaskId);
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, story_index, agent, pipeline, lane,
      delegation_key, attempt, status, input_hash, input_json
    ) VALUES('EXEC-analysis-dedup', 'run-dedup', ?, 1, 'analyst-agent', 'analysis', 'analysis',
      'key-analysis-dedup', 1, 'applying', 'hash', '{}')
  `).run(activeTaskId);
  db.prepare(`
    INSERT INTO agent_results(
      result_id, run_id, task_id, story_index, agent, pipeline, outcome,
      result_json, application_status, execution_id
    ) VALUES('RESULT-analysis-dedup', 'run-dedup', ?, 1, 'analyst-agent', 'analysis', 'completed',
      '{}', 'pending', 'EXEC-analysis-dedup')
  `).run(activeTaskId);

  const candidates: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const taskId = `TASK-analysis-dedup-candidate-${index}`;
    candidates.push(taskId);
    db.prepare(`
      INSERT INTO tasks(task_id, title, item_type, priority, agile_status, current_subagent, total_stories, work_dir)
      VALUES(?, ?, 'feature', 'P2', 'ready for dev', 'analyst-agent', 1, '')
    `).run(taskId, `Analysis candidate ${index}`);
  }
  const dispatched = (await pipelineAllEnvelopes()).filter((item) => candidates.includes(item.taskId) && item.lane === 'analysis');
  assert.equal(dispatched.length, 3);
});

test('materializes editable Agent Prompt and Memory outside the workspace with version history', async () => {
  const {
    ensureAgentRuntimeWorkspace,
    agentProfileInternals,
    getAgentProfile,
    loadAgentRuntime,
    rollbackAgentPrompt,
    saveAgentMemory,
    saveAgentPrompt,
  } = await import('./agent-profiles');
  const { databaseConnection, hash } = await import('../infrastructure/database');

  const runtimeRoot = await ensureAgentRuntimeWorkspace();
  assert.ok(!runtimeRoot.startsWith(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE || ''));
  const original = await getAgentProfile('dev-agent');
  assert.equal(original.profile.prompt_seed_revision, 13);
  assert.ok(original.currentPrompt.content.length > 800);
  assert.match(original.currentPrompt.content, /# 角色目标/);
  assert.match(original.currentPrompt.content, /# 完成条件/);

  const db = await databaseConnection();
  const legacyPrompt = '判断需求类型并整理上下文，完成时提供分类、流程方向和需求文档。';
  db.prepare(`
    UPDATE agent_prompt_versions SET content = ?, content_hash = ?, source = 'seed'
    WHERE agent_id = 'backlog-agent' AND version = 1
  `).run(legacyPrompt, hash(legacyPrompt));
  db.prepare(`
    UPDATE agent_profiles SET current_prompt_version = 1, candidate_prompt_version = NULL, prompt_seed_revision = 1
    WHERE agent_id = 'backlog-agent'
  `).run();
  agentProfileInternals.atomicWrite(join(agentProfileInternals.agentDirectory('backlog-agent'), 'PROMPT.md'), legacyPrompt);
  await ensureAgentRuntimeWorkspace();
  const upgradedSeed = await getAgentProfile('backlog-agent');
  assert.equal(upgradedSeed.profile.prompt_seed_revision, 13);
  assert.equal(upgradedSeed.currentPrompt.source, 'seed');
  assert.ok(upgradedSeed.currentPrompt.version > 1);
  assert.match(upgradedSeed.currentPrompt.content, /# 输入与证据优先级/);
  const resumedBacklog = await loadAgentRuntime('backlog-agent', 'resume');
  assert.match(resumedBacklog.prompt, /已回答的需求级产品问题/);

  const promptContent = `${original.currentPrompt.content}\n\n- 在修改前先读取相关 Slice Spec。`;
  const promptVersion = await saveAgentPrompt({ agentId: 'dev-agent', content: promptContent, reason: 'test prompt version' });
  const memoryRevision = await saveAgentMemory({
    agentId: 'dev-agent',
    content: '# Durable Memory\n\n- 项目使用 npm test 运行确定性测试。',
    reason: 'test memory revision',
  });
  const edited = await getAgentProfile('dev-agent');
  assert.equal(edited.currentPrompt.version, promptVersion);
  assert.equal(edited.currentMemory.revision, memoryRevision);
  assert.equal(readFileSync(join(edited.runtimeDirectory, 'PROMPT.md'), 'utf8').trim(), promptContent.trim());
  assert.match(readFileSync(join(edited.runtimeDirectory, 'MEMORY.md'), 'utf8'), /npm test/);

  db.prepare("UPDATE agent_profiles SET prompt_seed_revision = 1 WHERE agent_id = 'dev-agent'").run();
  await ensureAgentRuntimeWorkspace();
  const preservedHumanPrompt = await getAgentProfile('dev-agent');
  assert.equal(preservedHumanPrompt.currentPrompt.version, promptVersion);
  assert.equal(preservedHumanPrompt.currentPrompt.source, 'human');
  assert.equal(preservedHumanPrompt.profile.prompt_seed_revision, 13);

  const localPrompt = `${promptContent}\n- 本地文件修改也必须形成版本。`;
  writeFileSync(join(edited.runtimeDirectory, 'PROMPT.md'), localPrompt);
  await ensureAgentRuntimeWorkspace();
  const reconciled = await getAgentProfile('dev-agent');
  assert.equal(reconciled.currentPrompt.source, 'local');
  assert.match(reconciled.currentPrompt.content, /本地文件修改/);

  const rolledBackVersion = await rollbackAgentPrompt({ agentId: 'dev-agent', version: promptVersion });
  const rolledBack = await loadAgentRuntime('dev-agent', 'plan');
  assert.equal(rolledBack.promptVersion, rolledBackVersion);
  assert.equal(rolledBack.promptStatus, 'active');
  assert.match(rolledBack.memory, /npm test/);
});

test('promotes repeated evolution evidence and gates Prompt changes through deterministic Canary runs', async () => {
  const { createTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const { applyEvolutionResult, beginEvolutionRun, updatePromptCanary } = await import('./agent-evolution');
  const { getAgentProfile, loadAgentRuntime } = await import('./agent-profiles');
  const db = await databaseConnection();
  const taskA = await createTask({ title: 'Evolution evidence A' });
  const taskB = await createTask({ title: 'Evolution evidence B' });

  const addExecution = (executionId: string, taskId: string, candidateId: string | null = null) => {
    db.prepare(`
      INSERT INTO execution_attempts(
        execution_id, run_id, task_id, agent, pipeline, delegation_key,
        attempt, status, input_hash, input_json, evolution_candidate_id
      ) VALUES(?, 'run-evolution-test', ?, 'dev-agent', 'dev', ?, 1, 'applied', ?, '{}', ?)
    `).run(executionId, taskId, `key-${executionId}`, `hash-${executionId}`, candidateId);
  };
  const evaluate = async (executionId: string, taskId: string, fingerprint: string, target: 'memory' | 'prompt') => {
    addExecution(executionId, taskId);
    const evidence = {
      executionId,
      taskId,
      storyIndex: 1,
      agentId: 'dev-agent',
      attempt: 1,
      promptVersion: 1,
      result: { outcome: 'completed', summary: 'Execution completed with verified evidence.' },
      applicationOutcome: 'advanced',
      diagnostics: [],
    };
    const run = await beginEvolutionRun(evidence);
    assert.ok(run?.prompt);
    await applyEvolutionResult(run!.evolutionId, evidence, {
      summary: 'A reusable behavior was observed.',
      observations: [{
        fingerprint,
        category: 'verification',
        summary: 'Use the repository test command before declaring completion',
        guidance: 'When implementation changes are complete, run the repository test command and retain its deterministic result.',
        target,
        confidence: 0.9,
        reusable: true,
      }],
    });
  };

  const beforeMemory = await getAgentProfile('dev-agent');
  await evaluate('evo-memory-1', taskA, 'run-repository-tests', 'memory');
  await evaluate('evo-memory-2', taskA, 'run-repository-tests', 'memory');
  let detail = await getAgentProfile('dev-agent');
  assert.equal(detail.currentMemory.revision, beforeMemory.currentMemory.revision);
  await evaluate('evo-memory-3', taskB, 'run-repository-tests', 'memory');
  detail = await getAgentProfile('dev-agent');
  assert.equal(detail.currentMemory.revision, beforeMemory.currentMemory.revision + 1);
  assert.match(detail.currentMemory.content, /EVOLUTION:run-repository-tests/);

  await evaluate('evo-prompt-1', taskA, 'verify-before-completion', 'prompt');
  await evaluate('evo-prompt-2', taskA, 'verify-before-completion', 'prompt');
  await evaluate('evo-prompt-3', taskB, 'verify-before-completion', 'prompt');
  detail = await getAgentProfile('dev-agent');
  assert.ok(detail.candidatePrompt);
  assert.equal(detail.profile.canary_remaining, 3);
  const candidateId = `dev-agent:prompt:v${detail.candidatePrompt!.version}`;
  assert.equal((await loadAgentRuntime('dev-agent')).evolutionCandidateId, candidateId);

  for (const index of [1, 2, 3]) {
    const executionId = `canary-success-${index}`;
    addExecution(executionId, index === 1 ? taskA : taskB, candidateId);
    await updatePromptCanary('dev-agent', true, executionId);
  }
  detail = await getAgentProfile('dev-agent');
  assert.equal(detail.candidatePrompt, null);
  assert.match(detail.currentPrompt.content, /EVOLUTION:verify-before-completion/);
  assert.equal(detail.observations.find((item) => item.fingerprint === 'verify-before-completion')?.status, 'promoted_prompt');

  await evaluate('evo-rollback-1', taskA, 'avoid-ambiguous-tool-order', 'prompt');
  await evaluate('evo-rollback-2', taskB, 'avoid-ambiguous-tool-order', 'prompt');
  await evaluate('evo-rollback-3', taskB, 'avoid-ambiguous-tool-order', 'prompt');
  detail = await getAgentProfile('dev-agent');
  const rejectedVersion = detail.candidatePrompt!.version;
  const rejectedCandidateId = `dev-agent:prompt:v${rejectedVersion}`;
  addExecution('canary-failure', taskB, rejectedCandidateId);
  await updatePromptCanary('dev-agent', false, 'canary-failure');
  detail = await getAgentProfile('dev-agent');
  assert.equal(detail.candidatePrompt, null);
  assert.equal(detail.promptHistory.find((item) => item.version === rejectedVersion)?.status, 'rolled_back');
  assert.equal(detail.observations.find((item) => item.fingerprint === 'avoid-ambiguous-tool-order')?.status, 'rejected');
});

test('correlates and redacts structured runtime events before queuing a durable software maintenance job', async () => {
  const { createTask, appendLoopRunLog } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const { clearRuntimeEventContext, recordRuntimeEvent, setRuntimeEventContext } = await import('./runtime-events');
  const { claimNextSoftwareMaintenanceJob, enqueueSoftwareMaintenance, updateSoftwareMaintenanceJob } = await import('./software-maintenance');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Structured maintenance evidence' });
  const executionId = 'execution-structured-maintenance';
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, agent, pipeline, delegation_key,
      attempt, status, input_hash, input_json
    ) VALUES(?, 'run-structured-maintenance', ?, 'dev-agent', 'dev', ?, 1, 'applied', 'maintenance-hash', '{}')
  `).run(executionId, taskId, `key-${executionId}`);

  setRuntimeEventContext({ runId: 'run-structured-maintenance', executionId, taskId, agentId: 'dev-agent', stage: 'verifying' });
  try {
    const fromId = await recordRuntimeEvent({
      eventName: 'loop.execution.cycle.started', component: 'loop-runner', body: 'cycle started',
    });
    await appendLoopRunLog('run-structured-maintenance', '[错误] verification failed token=super-secret password=hunter2');
    const event = db.prepare(`
      SELECT * FROM runtime_events WHERE run_id = ? ORDER BY event_id DESC LIMIT 1
    `).get('run-structured-maintenance') as { execution_id: string; task_id: string; severity_text: string; body: string };
    assert.equal(event.execution_id, executionId);
    assert.equal(event.task_id, taskId);
    assert.equal(event.severity_text, 'ERROR');
    assert.doesNotMatch(event.body, /super-secret|hunter2/);
    assert.match(event.body, /\[REDACTED\]/);

    const firstJob = await enqueueSoftwareMaintenance({
      triggerKind: 'execution_finally', runId: 'run-structured-maintenance', executionId, eventFromId: fromId,
    });
    const repeatedJob = await enqueueSoftwareMaintenance({
      triggerKind: 'execution_finally', runId: 'run-structured-maintenance', executionId, eventFromId: fromId,
    });
    assert.equal(repeatedJob, firstJob);
    const claimed = await claimNextSoftwareMaintenanceJob();
    assert.equal(claimed?.job_id, firstJob);
    assert.equal(claimed?.severity_text, 'ERROR');
    assert.equal(claimed?.status, 'running');
    await updateSoftwareMaintenanceJob(claimed!.job_id, { status: 'no_issue', summary: 'test cleanup', finished: true });
  } finally {
    clearRuntimeEventContext();
  }
});

test('redacts nested authorization attributes before persisting runtime events', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { recordRuntimeEventInDb } = await import('./runtime-events');
  const db = await databaseConnection();
  const secret = 'nested-authorization-secret';

  const eventId = recordRuntimeEventInDb(db, {
    eventName: 'loop.test.nested_authorization',
    component: 'test',
    body: 'record nested authorization attributes',
    attributes: {
      metadata: {
        authorization: secret,
        requestId: 'safe-context',
      },
    },
  });
  const event = db.prepare('SELECT attributes_json FROM runtime_events WHERE event_id = ?')
    .get(eventId) as { attributes_json: string };

  assert.doesNotMatch(event.attributes_json, new RegExp(secret));
  assert.deepEqual(JSON.parse(event.attributes_json), {
    metadata: {
      authorization: '[REDACTED]',
      requestId: 'safe-context',
    },
  });
});

test('runtime-event-tolerance run-log: retains text log and writes maintenance warning when its structured mirror fails', async () => {
  const { appendLoopRunLog, readLoopRunLogChunk } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const runId = 'runtime-event-tolerance-run-log';

  db.exec('ALTER TABLE runtime_events RENAME TO runtime_events_unavailable');
  try {
    await assert.doesNotReject(appendLoopRunLog(runId, '[运行] text record must survive'));
    const log = await readLoopRunLogChunk(runId);
    assert.match(log.raw, /\[运行\] text record must survive/);
    assert.match(log.raw, /\[维护\] 结构化运行时事件写入失败/);
  } finally {
    db.exec('ALTER TABLE runtime_events_unavailable RENAME TO runtime_events');
  }
});

test('runtime-event-tolerance cycle-start: isolates startup event writes and preserves a null boundary', async () => {
  const { recordRuntimeEventWithFallback, readLoopRunLogChunk } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const { recordRuntimeEvent } = await import('./runtime-events');
  const db = await databaseConnection();
  const runId = 'runtime-event-tolerance-cycle-start';

  db.exec('ALTER TABLE runtime_events RENAME TO runtime_events_unavailable');
  try {
    const eventFromId = await recordRuntimeEventWithFallback(runId, 'cycle.started 结构化事件写入失败，不影响主流程', () => recordRuntimeEvent({
      eventName: 'loop.execution.cycle.started', component: 'loop-runner', body: 'injected cycle-start failure', context: { runId },
    }));
    assert.equal(eventFromId, null);
    assert.match((await readLoopRunLogChunk(runId)).raw, /\[维护\] cycle\.started 结构化事件写入失败/);
  } finally {
    db.exec('ALTER TABLE runtime_events_unavailable RENAME TO runtime_events');
  }
  const source = readFileSync(join(process.cwd(), 'scripts/loop/agent-runner.ts'), 'utf8');
  assert.match(source, /recordRuntimeEventWithFallback\([\s\S]*?cycle\.started 结构化事件写入失败[\s\S]*?recordRuntimeEvent/);
  assert.match(source, /eventFromId: number \| null/);
});

test('runtime-event-tolerance dispatch-waiter: isolates exception writes and records a maintenance warning', async () => {
  const { recordRuntimeEventWithFallback, readLoopRunLogChunk } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const { recordRuntimeException } = await import('./runtime-events');
  const db = await databaseConnection();
  const runId = 'runtime-event-tolerance-dispatch-waiter';

  db.exec('ALTER TABLE runtime_events RENAME TO runtime_events_unavailable');
  try {
    const eventId = await recordRuntimeEventWithFallback(runId, 'dispatch-waiter 结构化异常事件写入失败，不影响原始失败', () => recordRuntimeException({
      runId, component: 'dispatch-waiter', stage: 'finally', error: new Error('injected dispatch-waiter exception failure'), fatal: true,
    }));
    assert.equal(eventId, null);
    assert.match((await readLoopRunLogChunk(runId)).raw, /\[维护\] dispatch-waiter 结构化异常事件写入失败/);
  } finally {
    db.exec('ALTER TABLE runtime_events_unavailable RENAME TO runtime_events');
  }
  const source = readFileSync(join(process.cwd(), 'scripts/loop/dispatch-waiter.ts'), 'utf8');
  assert.match(source, /recordRuntimeEventWithFallback\([\s\S]*?dispatch-waiter 结构化异常事件写入失败[\s\S]*?recordRuntimeException/);
});

test('infers event metadata from message prefix', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { recordLoopLogEventInDb } = await import('./runtime-events');
  const db = await databaseConnection();
  const runId = 'run-prefix-inference';

  const cases = [
    { message: '[执行器工具] call tool', eventName: 'loop.agent.tool', component: 'agent-executor', severity: 'INFO' },
    { message: '[执行器错误] tool failed', eventName: 'loop.agent.error', component: 'agent-executor', severity: 'ERROR' },
    { message: '[执行器输出] result', eventName: 'loop.agent.output', component: 'agent-executor', severity: 'INFO' },
    { message: '[验证] test passed', eventName: 'loop.verification', component: 'harness', severity: 'INFO' },
    { message: '[演化] prompt updated', eventName: 'loop.agent_evolution', component: 'agent-evolution', severity: 'INFO' },
    { message: '[维护] check started', eventName: 'loop.software_maintenance', component: 'software-maintenance', severity: 'INFO' },
    { message: '[错误] something broke', eventName: 'loop.error', component: 'loop-runner', severity: 'ERROR' },
    { message: '[恢复] retry succeeded', eventName: 'loop.recovery', component: 'loop-runner', severity: 'INFO' },
    { message: '[派发] task assigned', eventName: 'loop.dispatch', component: 'orchestrator', severity: 'INFO' },
    { message: '[执行器警告] deprecation', eventName: 'loop.log', component: 'loop-runner', severity: 'WARN' },
    { message: '[警告] resource low', eventName: 'loop.log', component: 'loop-runner', severity: 'WARN' },
    { message: '[致命] unrecoverable', eventName: 'loop.log', component: 'loop-runner', severity: 'ERROR' },
    { message: 'plain log without prefix', eventName: 'loop.log', component: 'loop-runner', severity: 'INFO' },
  ];

  for (const c of cases) {
    const id = recordLoopLogEventInDb(db, runId, c.message);
    const event = db.prepare('SELECT event_name, component, severity_text, body FROM runtime_events WHERE event_id = ?').get(id) as any;
    assert.equal(event.event_name, c.eventName, `event_name mismatch for "${c.message}"`);
    assert.equal(event.component, c.component, `component mismatch for "${c.message}"`);
    assert.equal(event.severity_text, c.severity, `severity mismatch for "${c.message}"`);
    assert.equal(event.body, c.message);
  }

  const attributesEvent = db.prepare("SELECT attributes_json FROM runtime_events WHERE body = 'plain log without prefix'").get() as any;
  assert.equal(attributesEvent.attributes_json, '{}');

  const kvEvent = db.prepare("SELECT attributes_json FROM runtime_events WHERE body = '[派发] task assigned'").get() as any;
  assert.equal(kvEvent.attributes_json, '{}');

  const kvMessage = '[派发] executor=agent-runner lane=delivery agent=dev-agent requirement=REQ-1 unit=1 flow=dev resource=none tool=harness code=main';
  recordLoopLogEventInDb(db, runId, kvMessage);
  const kvRich = db.prepare("SELECT attributes_json FROM runtime_events WHERE body = ?").get(kvMessage) as any;
  const parsed = JSON.parse(kvRich.attributes_json);
  assert.equal(parsed.executor, 'agent-runner');
  assert.equal(parsed.lane, 'delivery');
  assert.equal(parsed.agent, 'dev-agent');
  assert.equal(parsed.requirement, 'REQ-1');
  assert.equal(parsed.unit, '1');
  assert.equal(parsed.flow, 'dev');
  assert.equal(parsed.resource, 'none');
  assert.equal(parsed.tool, 'harness');
  assert.equal(parsed.code, 'main');
});

test('generates exception fingerprint', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { recordRuntimeEventInDb } = await import('./runtime-events');
  const db = await databaseConnection();

  const err = new Error('something broke at line 42');
  const id = recordRuntimeEventInDb(db, {
    eventName: 'loop.test.exception',
    component: 'test',
    body: 'test exception',
    error: err,
  });

  const event = db.prepare(
    'SELECT exception_type, exception_message, exception_stack, exception_fingerprint FROM runtime_events WHERE event_id = ?'
  ).get(id) as any;

  assert.equal(event.exception_type, 'Error');
  assert.equal(event.exception_message, 'something broke at line 42');
  assert.ok(event.exception_stack.includes('Error: something broke at line 42'));
  assert.ok(event.exception_stack.includes('tasks.test.ts'));
  assert.equal(event.exception_fingerprint.length, 24);
  assert.match(event.exception_fingerprint, /^[a-f0-9]{24}$/);

  const sameFingerprint = recordRuntimeEventInDb(db, {
    eventName: 'loop.test.exception2',
    component: 'test',
    body: 'same shape',
    error: new Error('something broke at line 99'),
  });
  const event2 = db.prepare(
    'SELECT exception_fingerprint FROM runtime_events WHERE event_id = ?'
  ).get(sameFingerprint) as any;
  assert.equal(event2.exception_fingerprint, event.exception_fingerprint,
    'fingerprints should match after normalization (numbers→#)');

  const nonError = recordRuntimeEventInDb(db, {
    eventName: 'loop.test.nonerror',
    component: 'test',
    body: 'string error',
    error: 'plain string error',
  });
  const ne = db.prepare(
    'SELECT exception_type, exception_message, exception_fingerprint FROM runtime_events WHERE event_id = ?'
  ).get(nonError) as any;
  assert.equal(ne.exception_type, 'string');
  assert.ok(ne.exception_fingerprint.length > 0);

  const noError = recordRuntimeEventInDb(db, {
    eventName: 'loop.test.noerror',
    component: 'test',
    body: 'no error',
  });
  const clean = db.prepare(
    'SELECT exception_type, exception_message, exception_stack, exception_fingerprint FROM runtime_events WHERE event_id = ?'
  ).get(noError) as any;
  assert.equal(clean.exception_type, null);
  assert.equal(clean.exception_message, null);
  assert.equal(clean.exception_stack, null);
  assert.equal(clean.exception_fingerprint, null);

  const sanitized = recordRuntimeEventInDb(db, {
    eventName: 'loop.test.secret_in_error',
    component: 'test',
    body: 'error with secret',
    error: new Error('auth failed token=super-secret-123'),
  });
  const se = db.prepare(
    'SELECT exception_message FROM runtime_events WHERE event_id = ?'
  ).get(sanitized) as any;
  assert.match(se.exception_message, /\[REDACTED\]/);
  assert.doesNotMatch(se.exception_message, /super-secret-123/);
});

test('evidence-window: loads events by event_from_id..event_to_id window in ascending order', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { recordRuntimeEventInDb } = await import('./runtime-events');
  const { loadMaintenanceEvidence } = await import('./software-maintenance');
  const db = await databaseConnection();

  const ids: number[] = [];
  db.transaction(() => {
    for (let i = 0; i < 10; i++) {
      ids.push(recordRuntimeEventInDb(db, {
        eventName: `test.window.${i}`, component: 'test', body: `window event ${i}`,
      }));
    }
  })();

  const events = await loadMaintenanceEvidence({
    event_from_id: ids[2], event_to_id: ids[6],
    trigger_run_id: null, trigger_execution_id: null,
  } as Parameters<typeof loadMaintenanceEvidence>[0]);

  assert.equal(events.length, 5);
  assert.deepEqual(events.map((e) => e.event_id), ids.slice(2, 7));
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].event_id > events[i - 1].event_id, 'events should be in ascending order');
  }
});

test('self-referential: filters out component=software-maintenance events from evidence', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { clearRuntimeEventContext, recordRuntimeEventInDb, setRuntimeEventContext } = await import('./runtime-events');
  const { loadMaintenanceEvidence } = await import('./software-maintenance');
  const db = await databaseConnection();
  const runId = 'self-ref-test-run';

  setRuntimeEventContext({ runId });
  try {
    const normalIds: number[] = [];
    db.transaction(() => {
      for (let i = 0; i < 3; i++) {
        normalIds.push(recordRuntimeEventInDb(db, {
          eventName: `test.normal.${i}`, component: 'loop-runner', body: `normal event ${i}`,
        }));
      }
      for (let i = 0; i < 2; i++) {
        recordRuntimeEventInDb(db, {
          eventName: 'loop.software_maintenance.check', component: 'software-maintenance', body: `maintenance event ${i}`,
        });
      }
    })();

    const events = await loadMaintenanceEvidence({
      event_from_id: 0, event_to_id: Number.MAX_SAFE_INTEGER,
      trigger_run_id: runId, trigger_execution_id: null,
    } as Parameters<typeof loadMaintenanceEvidence>[0]);

    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.event_id), normalIds);
    for (const e of events) {
      assert.notEqual(e.component, 'software-maintenance');
    }
  } finally {
    clearRuntimeEventContext();
  }
});

test('evidence-limit: truncates to 500 events when window exceeds limit', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { loadMaintenanceEvidence } = await import('./software-maintenance');
  const db = await databaseConnection();

  const insert = db.prepare(`
    INSERT INTO runtime_events(timestamp, observed_at, event_name, component, severity_text, severity_number, body, attributes_json)
    VALUES(datetime('now'), datetime('now'), 'test.limit', 'test', 'INFO', 9, ?, '{}')
  `);
  db.transaction(() => {
    for (let i = 0; i < 600; i++) {
      insert.run(`limit event ${i}`);
    }
  })();

  const events = await loadMaintenanceEvidence({
    event_from_id: 0, event_to_id: Number.MAX_SAFE_INTEGER,
    trigger_run_id: null, trigger_execution_id: null,
  } as Parameters<typeof loadMaintenanceEvidence>[0]);

  assert.equal(events.length, 500);
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].event_id > events[i - 1].event_id, 'events should be in ascending order');
  }
});

test('fallback-evidence: falls back to run_id when window query returns empty', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { loadMaintenanceEvidence } = await import('./software-maintenance');
  const db = await databaseConnection();
  const runId = 'fallback-evidence-run';

  const ids: number[] = [];
  const insert = db.prepare(`
    INSERT INTO runtime_events(timestamp, observed_at, run_id, event_name, component, severity_text, severity_number, body, attributes_json)
    VALUES(datetime('now'), datetime('now'), ?, 'test.fallback', 'loop-runner', 'INFO', 9, ?, '{}')
  `);
  db.transaction(() => {
    for (let i = 0; i < 50; i++) {
      const info = insert.run(runId, `fallback event ${i}`);
      ids.push(Number(info.lastInsertRowid));
    }
  })();

  const events = await loadMaintenanceEvidence({
    event_from_id: 999_999, event_to_id: 999_999,
    trigger_run_id: runId, trigger_execution_id: null,
  } as Parameters<typeof loadMaintenanceEvidence>[0]);

  assert.equal(events.length, 50);
  assert.deepEqual(events.map((e) => e.event_id), ids);
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].event_id > events[i - 1].event_id, 'events should be in ascending order');
  }
});

test('settings-gate: skips non-manual enqueue when software_maintenance_enabled is false', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { enqueueSoftwareMaintenance } = await import('./software-maintenance');
  const db = await databaseConnection();

  db.prepare(`UPDATE project_settings SET setting_value = 'false' WHERE setting_key = 'software_maintenance_enabled'`).run();
  try {
    const nonManual = await enqueueSoftwareMaintenance({ triggerKind: 'execution_finally' });
    assert.equal(nonManual, null);
    const manual = await enqueueSoftwareMaintenance({ triggerKind: 'manual' });
    assert.ok(manual, 'manual trigger should bypass enabled check');
    assert.match(manual!, /^[a-f0-9-]{36}$/);
  } finally {
    db.prepare(`UPDATE project_settings SET setting_value = 'true' WHERE setting_key = 'software_maintenance_enabled'`).run();
  }
});

test('prompt-build: maps RuntimeEventRow fields to stable JSON evidence structure including exception', async () => {
  const { buildSoftwareMaintenancePrompt } = await import('./software-maintenance');
  const job = {
    job_id: 'test-job-id',
    trigger_kind: 'execution_finally',
    severity_text: 'INFO',
    base_commit: null,
  } as Parameters<typeof buildSoftwareMaintenancePrompt>[0];

  const event = {
    event_id: 42,
    timestamp: '2026-07-20T10:00:00.000Z',
    run_id: 'test-run',
    execution_id: 'test-exec',
    task_id: 'test-task',
    agent_id: 'dev-agent',
    event_name: 'loop.exception.fatal',
    component: 'loop-runner',
    stage: 'verifying',
    severity_text: 'FATAL',
    body: 'something broke',
    attributes_json: JSON.stringify({ key: 'value', nested: { a: 1 } }),
    exception_type: 'TypeError',
    exception_message: 'cannot read property X',
    exception_stack: 'at foo (bar.ts:10:5)',
    exception_fingerprint: 'abc123def456',
  };

  const prompt = buildSoftwareMaintenancePrompt(job, [event]);
  assert.ok(prompt.includes('结构化运行证据'), 'prompt should contain evidence section');

  const evidenceMatch = prompt.match(/结构化运行证据：\n(\[[\s\S]*?\])\n\n结果结构：/);
  assert.ok(evidenceMatch, 'prompt should contain a JSON evidence array');
  const evidence = JSON.parse(evidenceMatch![1]);

  assert.equal(evidence.length, 1);
  const e = evidence[0];
  assert.equal(e.id, 42);
  assert.equal(e.timestamp, '2026-07-20T10:00:00.000Z');
  assert.equal(e.eventName, 'loop.exception.fatal');
  assert.equal(e.component, 'loop-runner');
  assert.equal(e.stage, 'verifying');
  assert.equal(e.severity, 'FATAL');
  assert.equal(e.runId, 'test-run');
  assert.equal(e.executionId, 'test-exec');
  assert.equal(e.taskId, 'test-task');
  assert.equal(e.agentId, 'dev-agent');
  assert.equal(e.body, 'something broke');
  assert.deepEqual(e.attributes, { key: 'value', nested: { a: 1 } });
  assert.ok(e.exception);
  assert.equal(e.exception.type, 'TypeError');
  assert.equal(e.exception.message, 'cannot read property X');
  assert.equal(e.exception.stack, 'at foo (bar.ts:10:5)');
  assert.equal(e.exception.fingerprint, 'abc123def456');

  const jobLine = prompt.includes('test-job-id');
  assert.ok(jobLine, 'prompt should include job id');
});

test('prompt-build: falls back to empty attributes object on parse failure', async () => {
  const { buildSoftwareMaintenancePrompt } = await import('./software-maintenance');
  const job = {
    job_id: 'test-job-id', trigger_kind: 'execution_finally' as const,
    severity_text: 'INFO' as const, base_commit: null,
  } as Parameters<typeof buildSoftwareMaintenancePrompt>[0];

  const event = {
    event_id: 1, timestamp: '2026-01-01T00:00:00.000Z',
    run_id: null, execution_id: null, task_id: null, agent_id: null,
    event_name: 'test', component: 'test', stage: null,
    severity_text: 'INFO', body: 'test',
    attributes_json: 'not-valid-json{{{',
    exception_type: null, exception_message: null,
    exception_stack: null, exception_fingerprint: null,
  };

  const prompt = buildSoftwareMaintenancePrompt(job, [event]);
  const evidenceMatch = prompt.match(/结构化运行证据：\n(\[[\s\S]*?\])\n\n结果结构：/);
  assert.ok(evidenceMatch);
  const evidence = JSON.parse(evidenceMatch![1]);
  assert.deepEqual(evidence[0].attributes, {});
  assert.equal(evidence[0].exception, null);
});

test('prompt-build: includes security contract and result schema', async () => {
  const { buildSoftwareMaintenancePrompt } = await import('./software-maintenance');
  const job = {
    job_id: 'test-job-id', trigger_kind: 'runner_error' as const,
    severity_text: 'FATAL' as const, base_commit: 'abc1234',
  } as Parameters<typeof buildSoftwareMaintenancePrompt>[0];

  const prompt = buildSoftwareMaintenancePrompt(job, []);
  assert.ok(prompt.includes('Software Maintenance Agent'), 'prompt should address maintenance agent');
  assert.ok(prompt.includes('禁止修改'), 'prompt should include safety constraints');
  assert.ok(prompt.includes('提交命令'), 'prompt should include submission command');
  assert.ok(prompt.includes('test-job-id'), 'prompt should include job id');
  assert.ok(prompt.includes('runner_error'), 'prompt should include trigger kind');
  assert.ok(prompt.includes('FATAL'), 'prompt should include severity');
  assert.ok(prompt.includes('abc1234'), 'prompt should include base commit');
  assert.ok(prompt.includes('outcome') && prompt.includes('no_issue'), 'prompt should include result schema');
  assert.ok(prompt.includes('fingerprint'), 'prompt should include fingerprint field in schema');
  assert.ok(prompt.includes('insufficient_evidence'), 'prompt should include insufficient_evidence classification');
});

test('truncates long body', async () => {
  const { sanitizeRuntimeText } = await import('./runtime-events');

  const short = sanitizeRuntimeText('hello');
  assert.equal(short, 'hello');

  const longBody = 'x'.repeat(15_000);
  const truncated = sanitizeRuntimeText(longBody);
  assert.equal(truncated.length, 12_001, 'should be 12000 chars + …');
  assert.ok(truncated.endsWith('…'));
  assert.ok(truncated.startsWith('xxx'));

  const exactlyLimit = 'y'.repeat(12_000);
  const notTruncated = sanitizeRuntimeText(exactlyLimit);
  assert.equal(notTruncated.length, 12_000);
  assert.ok(!notTruncated.endsWith('…'));

  const exceptionMessage = sanitizeRuntimeText('e'.repeat(5_000), 3000);
  assert.equal(exceptionMessage.length, 3_001);
  assert.ok(exceptionMessage.endsWith('…'));

  const nullInput = sanitizeRuntimeText(null);
  assert.equal(nullInput, '');

  const undefinedInput = sanitizeRuntimeText(undefined);
  assert.equal(undefinedInput, '');

  const numberInput = sanitizeRuntimeText(42);
  assert.equal(numberInput, '42');

  const { databaseConnection } = await import('../infrastructure/database');
  const { recordRuntimeEventInDb } = await import('./runtime-events');
  const db = await databaseConnection();

  const longBodyForDb = 'A'.repeat(15_000);
  const id = recordRuntimeEventInDb(db, {
    eventName: 'loop.test.truncation',
    component: 'test',
    body: longBodyForDb,
  });
  const event = db.prepare('SELECT body FROM runtime_events WHERE event_id = ?').get(id) as any;
  assert.equal(event.body.length, 12_001);
  assert.ok(event.body.endsWith('…'));
  assert.ok(event.body.startsWith('AAA'));
});
