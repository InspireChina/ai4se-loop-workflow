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
  const { acknowledgeClosure, addQuestion, getTask } = await import('./tasks');
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
    /还有 1 条修改请求尚未通过反馈闭环验证/,
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
      targetAgent: 'dev-agent',
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
    feedbackResolutions: [{ commentId, summary: '已恢复旧接口兼容性。', evidence: ['src/compatibility.ts'] }],
  })));
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

test('clears stale delivery units when Review feedback routes back to planning', async () => {
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

  await rewindTask({ taskId, actor: 'review-agent', to: 'plan', reason: '用户评论要求重新划分交付边界' });
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

test('versions Slice Specs, advances Dev without requiring a commit, and stores Harness evidence', async () => {
  const { addQuestion, answerQuestion, getTask, saveStorySpec, updateTask } = await import('./tasks');
  const { runHarnessVerification } = await import('./verifications');
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

  const outcome = await runHarnessVerification(taskId, 1, undefined, 'test-execution-spec');
  assert.equal(outcome.passed, true);
  const repeated = await runHarnessVerification(taskId, 1, undefined, 'test-execution-spec');
  assert.equal(repeated.verificationId, outcome.verificationId);

  db.prepare(`
    INSERT INTO verification_runs(
      verification_id, task_id, story_index, spec_revision, status, execution_id
    ) VALUES('verification-interrupted', ?, 1, 2, 'running', 'test-execution-interrupted')
  `).run(taskId);
  db.prepare(`
    INSERT INTO verification_evidence(
      evidence_id, verification_id, criterion_id, kind, instruction,
      command, exit_code, output_summary, passed
    ) VALUES(
      'evidence-interrupted', 'verification-interrupted', 'STALE', 'command',
      'Partial evidence from the interrupted run', 'exit 1', 1, 'stale', 0
    )
  `).run();

  const resumed = await runHarnessVerification(taskId, 1, undefined, 'test-execution-interrupted');
  assert.equal(resumed.verificationId, 'verification-interrupted');
  assert.equal(resumed.passed, true);
  const resumedRuns = db.prepare(`
    SELECT verification_id, status
    FROM verification_runs
    WHERE execution_id = 'test-execution-interrupted'
  `).all() as { verification_id: string; status: string }[];
  assert.deepEqual(resumedRuns, [{ verification_id: 'verification-interrupted', status: 'passed' }]);
  const resumedEvidence = db.prepare(`
    SELECT criterion_id, passed
    FROM verification_evidence
    WHERE verification_id = 'verification-interrupted'
    ORDER BY created_at, evidence_id
  `).all() as { criterion_id: string; passed: number }[];
  assert.deepEqual(resumedEvidence, [{ criterion_id: 'AC-1', passed: 1 }]);

  const detail = await getTask(taskId);
  assert.deepEqual(detail?.storySpecs.map((item) => [item.revision, item.status]), [[1, 'superseded'], [2, 'resolved']]);
  assert.equal(detail?.questions.find((item) => item.question_id === questionId)?.status, 'resolved');
  assert.equal(detail?.verificationRuns.length, 2);
  assert.equal(detail?.verificationEvidence[0]?.criterion_id, 'AC-1');
  assert.equal(detail?.verificationEvidence[0]?.passed, 1);
  assert.equal(detail?.verificationRuns[0]?.code_commit, null);
});

test('lets Dev and Test request runtime information and resume the same delivery unit', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { beginEvolutionRun } = await import('./agent-evolution');
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

  let detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'ready for dev');
  assert.equal(detail?.task.run_state, 'waiting_for_runtime_input');
  assert.equal(detail?.task.current_subagent, 'dev-agent');
  assert.equal(detail?.runtimeInputs[0]?.status, 'pending');
  await answerRuntimeInput({ taskId, requestId: detail!.runtimeInputs[0].request_id, answer: '#N/A' });
  await submitRuntimeInputs(taskId);
  assert.deepEqual((await pipelineForTask(taskId))[0], {
    taskId,
    pipeline: 'resume',
    agent: 'dev-agent',
    storyIndex: 1,
    resource: 'none',
    description: '读取人工输入，并安全恢复需求推进',
  });

  addExecution('execution-runtime-dev-resume', 'dev-agent', 'resume');
  await applyAgentResult('run-runtime-input', envelope('dev-agent', 'resume'), parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'Implementation completed using the supplied repository metadata.',
    changedFiles: [],
  })), { executionId: 'execution-runtime-dev-resume' });
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
  assert.equal(original.profile.prompt_seed_revision, 7);
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
  assert.equal(upgradedSeed.profile.prompt_seed_revision, 7);
  assert.equal(upgradedSeed.currentPrompt.source, 'seed');
  assert.ok(upgradedSeed.currentPrompt.version > 1);
  assert.match(upgradedSeed.currentPrompt.content, /# 输入与证据优先级/);

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
  assert.equal(preservedHumanPrompt.profile.prompt_seed_revision, 7);

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
      harness: { passed: true, summary: 'All deterministic checks passed.' },
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

  const kvMessage = '[派发] executor=agent-runner agent=dev-agent requirement=REQ-1 unit=1 flow=dev tool=harness code=main';
  recordLoopLogEventInDb(db, runId, kvMessage);
  const kvRich = db.prepare("SELECT attributes_json FROM runtime_events WHERE body = ?").get(kvMessage) as any;
  const parsed = JSON.parse(kvRich.attributes_json);
  assert.equal(parsed.executor, 'agent-runner');
  assert.equal(parsed.agent, 'dev-agent');
  assert.equal(parsed.requirement, 'REQ-1');
  assert.equal(parsed.unit, '1');
  assert.equal(parsed.flow, 'dev');
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
