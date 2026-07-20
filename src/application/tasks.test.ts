import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('updates an existing task-level document instead of inserting a duplicate NULL-story row', async () => {
  const appRoot = mkdtempSync(join(tmpdir(), 'loopwork-app-'));
  const workspaceRoot = join(appRoot, 'workspace');
  mkdirSync(workspaceRoot);
  cpSync(join(process.cwd(), 'migrations'), join(appRoot, 'migrations'), { recursive: true });
  cpSync(join(process.cwd(), 'app-migrations'), join(appRoot, 'app-migrations'), { recursive: true });
  process.env.LOOP_APP_ROOT = appRoot;
  process.env.LOOP_WORKSPACE_ROOT_OVERRIDE = workspaceRoot;

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

test('anchors file comments to document revisions and supplies them to Agent evolution', async () => {
  const { addDocumentComment, createTask, getTask, resolveDocumentComment, upsertDocument } = await import('./tasks');
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

  await resolveDocumentComment({ taskId, commentId });
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

test('requires Review to consume closure comments and asks the user to confirm the revised report', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { parseAgentResult } = await import('../domain/agent-result');
  const {
    acknowledgeClosure,
    addDocumentComment,
    getTask,
    pipelineForTask,
    resolveDocumentComment,
    submitClosureFeedback,
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
    /还有 1 条未处理评论/,
  );
  await assert.rejects(
    () => resolveDocumentComment({ taskId, commentId }),
    /必须提交给 Review Agent 处理/,
  );
  await submitClosureFeedback(taskId);
  let detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'in review');
  assert.equal(detail?.task.current_subagent, 'review-agent');
  assert.equal(detail?.task.run_state, 'runnable');
  assert.equal(detail?.task.review_revision, 1);
  assert.equal(detail?.task.review_document_id, null);
  assert.equal((await pipelineForTask(taskId))[0]?.agent, 'review-agent');

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
  await applyAgentResult('run-closure-feedback', delegation, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: '用户评论揭示兼容性实现缺陷，需要回到开发阶段修复。',
    artifact: {
      title: '结卡评论处理与回流',
      content: '评论指出旧接口不可用；现有实现证据确认需要回到开发阶段修复交付单元 1。',
    },
    verdict: 'changes_requested',
    rewindTo: 'dev',
    rewindDeliveryUnit: 1,
  })));

  detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'in dev');
  assert.equal(detail?.task.current_subagent, 'dev-agent');
  assert.equal(detail?.task.dev_index, 0);
  assert.equal(detail?.task.test_index, 0);
  assert.equal(detail?.task.review_revision, 1);
  assert.equal(detail?.documentComments.find((comment) => comment.comment_id === commentId)?.status, 'open');

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

  const detail = await getTask(taskId);
  assert.deepEqual(detail?.storySpecs.map((item) => [item.revision, item.status]), [[1, 'superseded'], [2, 'resolved']]);
  assert.equal(detail?.questions.find((item) => item.question_id === questionId)?.status, 'resolved');
  assert.equal(detail?.verificationRuns.length, 1);
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
  assert.equal(original.profile.prompt_seed_revision, 6);
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
  assert.equal(upgradedSeed.profile.prompt_seed_revision, 6);
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
  assert.equal(preservedHumanPrompt.profile.prompt_seed_revision, 6);

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
