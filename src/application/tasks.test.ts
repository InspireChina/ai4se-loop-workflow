import { beginTestExecutionAttempt, PromptCanaryDeferredError } from '../test/execution-fixtures';
import { inspectAllDispatch, inspectTaskDispatch } from '../test/dispatch-inspection-fixtures';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { deliverySpecFixture } from '../test/delivery-spec-fixture';
import { resourcesForAgent } from '../domain/resource';
import type { DelegationEnvelope } from './tasks';

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
  const { addDocumentComment, createTask, getTask, upsertDocument } = await import('./tasks');
  const { applyFeedbackTriageGroups } = await import('./feedback');
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

  const feedbackDelegation = (await inspectTaskDispatch(taskId))[0];
  assert.ok(feedbackDelegation.feedbackBatchId);
  await applyFeedbackTriageGroups({
    taskId,
    batchId: feedbackDelegation.feedbackBatchId,
    summary: 'The report was already updated; preserve the convention as learning evidence.',
    groups: [{
      groupKey: 'explicit-boundary-learning',
      commentIds: [commentId],
      workType: 'learning_only',
      affectedDeliveryUnits: [],
      reason: 'Revision 2 already states the boundary explicitly.',
      acceptance: [],
    }],
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
  const { createTask, getTaskContext, getTask, setTaskPriority } = await import('./tasks');
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
  assert.equal(titleOnlyTask?.task.priority, '5');
  assert.equal(blankDescriptionTask?.task.description, null);
  assert.equal(describedTask?.task.description, 'Keep this value for the next story.');
  await setTaskPriority({ taskId: titleOnlyTaskId, priority: '8' });
  assert.equal((await getTask(titleOnlyTaskId))?.task.priority, '8');
  await assert.rejects(() => setTaskPriority({ taskId: titleOnlyTaskId, priority: '10' }), /1 到 9/);

  const titleOnlyContext = await getTaskContext(titleOnlyTaskId);
  const describedContext = await getTaskContext(describedTaskId);
  assert.equal(titleOnlyContext.task.description, null);
  assert.equal(describedContext.task.description, 'Keep this value for the next story.');

  // Each creation path can produce the normal backlog delegation; a missing
  // description must never be interpreted as a pipeline blocker.
  assert.equal((await inspectTaskDispatch(titleOnlyTaskId))[0]?.agent, 'backlog-agent');
  assert.equal((await inspectTaskDispatch(describedTaskId))[0]?.agent, 'backlog-agent');

  // A backlog delegation consumes the browser resource, so isolate each path
  // when inspecting its serialized Agent input.
  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id NOT IN (?, ?, ?)").run(titleOnlyTaskId, blankDescriptionTaskId, describedTaskId);
  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id = ?").run(blankDescriptionTaskId);
  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id = ?").run(describedTaskId);
  const titleOnlyEnvelope = (await inspectAllDispatch()).find((item) => item.taskId === titleOnlyTaskId);
  assert.ok(titleOnlyEnvelope);

  assert.equal(titleOnlyEnvelope.taskDescription, null);

  db.prepare("UPDATE tasks SET agile_status = 'done' WHERE task_id = ?").run(titleOnlyTaskId);
  db.prepare("UPDATE tasks SET agile_status = 'backlog' WHERE task_id = ?").run(describedTaskId);
  const describedEnvelope = (await inspectAllDispatch()).find((item) => item.taskId === describedTaskId);
  assert.ok(describedEnvelope);
  assert.equal(describedEnvelope.taskDescription, 'Keep this value for the next story.');
  assert.equal(describedEnvelope.description, '澄清业务变化上下文');
});

test('always creates a new UUID requirement without title, URL, external ID, or terminal-state deduplication', async () => {
  const { cancelTask, createTask, getTask } = await import('./tasks');
  const input = {
    title: 'Repeated requirement',
    link: 'https://example.test/requirements/repeated',
    externalId: 'EXT-REPEATED',
  };

  const cancelledId = await createTask(input);
  await cancelTask({ taskId: cancelledId, reason: 'Create a fresh requirement instead' });
  const secondId = await createTask(input);
  const thirdId = await createTask(input);

  const uuidRequirement = /^REQ-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(cancelledId, uuidRequirement);
  assert.match(secondId, uuidRequirement);
  assert.match(thirdId, uuidRequirement);
  assert.equal(new Set([cancelledId, secondId, thirdId]).size, 3);
  assert.equal((await getTask(cancelledId))?.task.agile_status, 'cancelled');
  assert.equal((await getTask(secondId))?.task.agile_status, 'backlog');
  assert.equal((await getTask(thirdId))?.task.agile_status, 'backlog');
});

test('changes priority without clearing a pending resume or moving workflow state', async () => {
  const { createTask, getTask, setTaskPriority } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Priority-only update', priority: '3' });
  db.prepare(`
    UPDATE tasks
    SET current_subagent = 'backlog-agent', resume_pending = 1, next_step = '继续原有流程'
    WHERE task_id = ?
  `).run(taskId);

  await setTaskPriority({ taskId, priority: '8' });
  const detail = await getTask(taskId);
  assert.equal(detail?.task.priority, '8');
  assert.equal(detail?.task.resume_pending, 1);
  assert.equal(detail?.task.current_subagent, 'backlog-agent');
  assert.equal(detail?.task.next_step, '继续原有流程');
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle' WHERE task_id = ?").run(taskId);
});

test('persists predefined metadata independently from legacy task columns', async () => {
  const { createTask, getTask } = await import('./tasks');
  const taskId = await createTask({
    title: 'Requirement metadata',
    metadata: [{
      key: 'source.reference_url',
      value: 'https://example.test/reference/metadata',
    }, {
      key: 'tracking.requirement_card_id',
      value: 'CARD-2026-08',
    }],
  });

  const detail = await getTask(taskId);
  assert.ok(detail);
  assert.equal(detail.task.link, null);
  assert.equal(detail.task.external_id, null);
  assert.deepEqual(detail.metadata.map((item) => ({
    key: item.metadata_key,
    value: item.metadata_value,
  })), [{
    key: 'source.reference_url',
    value: 'https://example.test/reference/metadata',
  }, {
    key: 'tracking.requirement_card_id',
    value: 'CARD-2026-08',
  }]);
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
  const { answerQuestion, createTask, getTask, submitClarificationAnswers } = await import('./tasks');
  const taskId = await createTask({
    title: 'Requirement-level clarification',
    description: 'Add an export action, but the intended audience is not specified.',
  });
  const firstDelegation = (await inspectTaskDispatch(taskId))[0] as Parameters<typeof applyAgentResult>[1];
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
  assert.deepEqual(await inspectTaskDispatch(taskId), []);

  await answerQuestion({ taskId, questionId: question!.question_id, answer: '本轮只面向管理员。' });
  await submitClarificationAnswers(taskId);
  detail = await getTask(taskId);
  assert.equal(detail?.task.run_state, 'runnable');
  assert.equal(detail?.task.resume_pending, 1);
  const resumedDelegation = (await inspectTaskDispatch(taskId))[0] as Parameters<typeof applyAgentResult>[1];
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
  assert.equal((await inspectTaskDispatch(taskId))[0]?.agent, 'story-splitter-agent');
});

test('keeps an unreproduced Bug in Repro until a human aligns the missing conditions', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { parseAgentResult } = await import('../domain/agent-result');
  const { databaseConnection } = await import('../infrastructure/database');
  const { answerQuestion, createTask, getTask, submitClarificationAnswers } = await import('./tasks');
  const taskId = await createTask({ title: 'Bug must be reproduced before planning' });
  const db = await databaseConnection();
  db.prepare(`
    UPDATE tasks
    SET item_type = 'bug', agile_status = 'in repro', current_subagent = 'repro-agent'
    WHERE task_id = ?
  `).run(taskId);

  const repro = (await inspectTaskDispatch(taskId))[0] as Parameters<typeof applyAgentResult>[1];
  assert.deepEqual([repro.pipeline, repro.agent], ['repro', 'repro-agent']);
  const blocked = await applyAgentResult('run-repro-not-reproduced', repro, parseAgentResult(JSON.stringify({
    outcome: 'needs_input',
    summary: 'The reported failure did not occur with the available entry point, data, and environment.',
    artifact: {
      title: 'Unsuccessful reproduction evidence',
      content: 'Expected, actual, environment, attempted steps, observations, and excluded conditions.',
    },
    reproVerdict: 'not_reproduced',
    questions: [{
      title: '确认问题发生条件',
      question: '请确认问题发生时使用的入口、数据和环境，并指出与当前复现条件的差异。',
      why: '当前没有观察到报告中的行为，无法确认修复目标。',
      recommendation: '提供最接近问题发生时的入口、样例数据和环境信息。',
    }],
  })));
  assert.equal(blocked, 'blocked');

  let detail = await getTask(taskId);
  const question = detail?.questions.find((item) => item.source_agent === 'repro-agent');
  assert.equal(detail?.task.agile_status, 'in repro');
  assert.equal(detail?.task.run_state, 'waiting_for_answers');
  assert.equal(detail?.task.current_subagent, 'repro-agent');
  assert.equal(question?.status, 'pending');
  assert.deepEqual(await inspectTaskDispatch(taskId), []);

  await answerQuestion({
    taskId,
    questionId: question!.question_id,
    answer: '问题只出现在管理员入口，并且需要使用一条已归档的数据。',
  });
  await submitClarificationAnswers(taskId);
  const resumed = (await inspectTaskDispatch(taskId))[0] as Parameters<typeof applyAgentResult>[1];
  assert.deepEqual([resumed.pipeline, resumed.agent, resumed.storyIndex], ['resume', 'repro-agent', null]);

  await applyAgentResult('run-repro-after-alignment', resumed, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'The issue is now reproduced through the administrator entry point with archived data.',
    artifact: {
      title: 'Confirmed reproduction evidence',
      content: 'Expected, actual, exact steps, archived data condition, evidence, and root-cause scope.',
    },
    reproVerdict: 'reproduced',
    route: 'plan',
  })));
  detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'in plan');
  assert.equal(detail?.task.current_subagent, 'story-splitter-agent');
  assert.equal(detail?.questions.find((item) => item.question_id === question?.question_id)?.status, 'resolved');
  assert.ok(detail?.events.some((event) => event.event_type === 'ReproClarificationsResolved'));
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
  assert.equal(detail?.task.resume_pending, 0);
  assert.equal(detail?.task.resume_status, null);
  assert.equal(detail?.task.analysis_index, 0);
  assert.equal(detail?.task.spec_resolved_index, 0);
  assert.deepEqual(detail?.lanes.map((lane) => [lane.lane, lane.resume_pending]), [
    ['analysis', 1],
    ['delivery', 0],
  ]);
});

test('resumes Analysis by lane ownership when Delivery leaves test-agent at task level', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { parseAgentResult } = await import('../domain/agent-result');
  const { addQuestion, answerQuestion, getTask, submitClarificationAnswers } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-analysis-resume-with-test-owner';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Concurrent Analysis resume', 'feature', 'in dev', 'analyst-agent', 1, 1, 1, 2, 1, '')
  `).run(taskId);
  db.prepare(`
    INSERT INTO stories(task_id, story_index, title, directory)
    VALUES(?, 1, 'Completed unit', 'story-001'), (?, 2, 'Clarified unit', 'story-002')
  `).run(taskId, taskId);

  const questionId = await addQuestion({
    taskId,
    storyIndex: 2,
    actor: 'analyst-agent',
    kind: 'analysis',
    title: 'Confirm guide scope',
    question: 'Should the guide expand its scope?',
    decisionKey: 'guide-scope',
    blockTask: true,
  });
  db.prepare("UPDATE tasks SET current_subagent = 'test-agent' WHERE task_id = ?").run(taskId);
  await answerQuestion({ taskId, questionId, answer: 'Keep the existing scope.' });
  await submitClarificationAnswers(taskId);

  let detail = await getTask(taskId);
  assert.equal(detail?.task.current_subagent, 'test-agent');
  assert.equal(detail?.task.resume_pending, 0);
  assert.deepEqual(
    detail?.lanes.map((lane) => [lane.lane, lane.status, lane.current_agent, lane.resume_pending]),
    [
      ['analysis', 'runnable', 'analyst-agent', 1],
      ['delivery', 'pending', null, 0],
    ],
  );
  const resumed = (await inspectTaskDispatch(taskId))[0] as Parameters<typeof applyAgentResult>[1];
  assert.deepEqual([resumed.lane, resumed.pipeline, resumed.agent, resumed.storyIndex], ['analysis', 'resume', 'analyst-agent', 2]);

  await applyAgentResult('run-concurrent-analysis-resume', resumed, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'The answered scope decision is now reflected in the resolved specification.',
    artifact: {
      title: 'Resolved guide scope',
      content: 'The guide keeps its existing scope according to the user answer.',
    },
    spec: deliverySpecFixture({
      decisions: [{
        key: 'guide-scope',
        type: 'business',
        title: 'Guide scope',
        question: 'Should the guide expand its scope?',
        impact: 'Changes the visible guide surface.',
        options: [
          { id: 'keep', label: 'Keep scope', consequences: ['No unrelated expansion'] },
          { id: 'expand', label: 'Expand scope', consequences: ['Additional pages are included'] },
        ],
        status: 'resolved',
        selectedOption: 'keep',
        authority: 'user',
        decision: 'Keep the existing scope',
        rationale: 'User answer',
        evidence: 'The user answered: Keep the existing scope.',
      }],
    }),
  })));

  detail = await getTask(taskId);
  assert.equal(detail?.task.analysis_index, 2);
  assert.equal(detail?.task.spec_resolved_index, 2);
  assert.equal(detail?.task.resume_pending, 0);
  assert.equal(detail?.deliverySpecs.find((spec) => spec.story_index === 2)?.status, 'resolved');
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle', current_subagent = NULL
    WHERE task_id = ?
  `).run(taskId);
});

test('acknowledges the current review report as read without an approval decision', async () => {
  const { acknowledgeClosure, addDocumentComment, addQuestion, getTask } = await import('./tasks');
  const { applyFeedbackTriageGroups } = await import('./feedback');
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
  const feedbackDelegation = (await inspectTaskDispatch(taskId))[0];
  assert.ok(feedbackDelegation.feedbackBatchId);
  await applyFeedbackTriageGroups({
    taskId,
    batchId: feedbackDelegation.feedbackBatchId,
    summary: '该评论是长期表述建议，不需要修改当前交付。',
    groups: [{
      groupKey: 'report-language-learning',
      commentIds: [noteId],
      workType: 'learning_only',
      affectedDeliveryUnits: [],
      reason: '已记录为可演化的长期证据。',
      acceptance: [],
    }],
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

// 评论驱动的逆向回退契约已由 forward-feedback.test.ts 中的前向追加场景取代。

test('versions delivery specs and advances Dev without requiring a commit', async () => {
  const { addQuestion, answerQuestion, getTask, saveDeliverySpec, updateTask } = await import('./tasks');
  const { AgentResultContractError } = await import('../domain/agent-result');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-versioned-slice-spec';
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, current_subagent, total_stories, work_dir)
    VALUES(?, 'Versioned slice spec', 'feature', 'ready for dev', 'analyst-agent', 1, '')
  `).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Contracted unit', 'story-001')").run(taskId);

  const baseSpec = deliverySpecFixture({
    impacts: [{
      key: 'output-contract',
      area: 'Visible output',
      finding: 'The output mode changes the visible contract.',
      disposition: 'needs_decision',
      evidence: 'The delivery unit admits two distinct output contracts.',
      decisionKey: 'output-mode',
    }],
    decisions: [{
      key: 'output-mode',
      type: 'business',
      title: 'Output mode',
      question: 'Which output mode should be used?',
      impact: 'Changes the visible output contract.',
      options: [
        { id: 'structured', label: 'Structured JSON', consequences: ['Stable machine-readable contract'] },
        { id: 'text', label: 'Readable text', consequences: ['Optimized for direct reading'] },
      ],
      status: 'needs_user_input' as const,
      authority: 'needs_user_input' as const,
      recommendationOption: 'structured',
      recommendationReason: 'The existing consumers use structured data.',
    }],
  });
  const first = await saveDeliverySpec({ taskId, storyIndex: 1, status: 'waiting_for_answers', spec: baseSpec });
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
  await assert.rejects(
    saveDeliverySpec({
      taskId,
      storyIndex: 1,
      status: 'resolved',
      spec: {
        ...baseSpec,
        impacts: [{
          ...baseSpec.impacts[0],
          disposition: 'change' as const,
          decisionKey: 'structured-output-mode',
        }],
        decisions: [{
          ...baseSpec.decisions[0],
          key: 'structured-output-mode',
          status: 'resolved' as const,
          selectedOption: 'structured',
          authority: 'user' as const,
          decision: 'Structured JSON',
          rationale: 'User answer',
          evidence: 'The user answered: Use structured JSON.',
          recommendationOption: undefined,
          recommendationReason: undefined,
        }],
      },
    }),
    (error: unknown) => error instanceof AgentResultContractError
      && /decisionKey 是跨轮次稳定 ID/.test(error.message)
      && /output-mode/.test(error.message),
  );
  const afterRenamedKey = await getTask(taskId);
  assert.deepEqual(afterRenamedKey?.deliverySpecs.map((spec) => [spec.revision, spec.status]), [[1, 'waiting_for_answers']]);
  const second = await saveDeliverySpec({
    taskId,
    storyIndex: 1,
    status: 'resolved',
    spec: {
      ...baseSpec,
      impacts: [{
        ...baseSpec.impacts[0],
        disposition: 'change' as const,
      }],
      decisions: [{
        ...baseSpec.decisions[0],
        status: 'resolved' as const,
        selectedOption: 'structured',
        authority: 'user' as const,
        decision: 'Structured JSON',
        rationale: 'User answer',
        evidence: 'The user answered: Use structured JSON.',
        recommendationOption: undefined,
        recommendationReason: undefined,
      }],
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
  assert.deepEqual(detail?.deliverySpecs.map((item) => [item.revision, item.status]), [[1, 'superseded'], [2, 'resolved']]);
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
    submitRuntimeInputs,
  } = await import('./tasks');
  const { markTestDelegationRunning } = await import('../test/dispatch-fixtures');
  const { databaseConnection } = await import('../infrastructure/database');
  const {
    BROWSER_EXCLUSIVE_RESOURCE,
    CODE_WORKSPACE_RESOURCE,
    releaseExecutionResourceClaimsInDb,
    releaseResourceClaimInDb,
    resourceClaimInDb,
  } = await import('./resource-claims');
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
    lane: 'delivery' as const,
    pipeline,
    agent,
    storyIndex: 1,
    resources: resourcesForAgent(agent),
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
  await markTestDelegationRunning(envelope('dev-agent', 'dev'), 'execution-runtime-dev-request');
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE)?.owner_execution_id, 'execution-runtime-dev-request');
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
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE), undefined);
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE), undefined);
  assert.equal(detail?.runtimeInputs[0]?.status, 'pending');

  const competingTaskId = 'TASK-runtime-input-competitor';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index,
      run_state, work_dir
    ) VALUES(?, 'Competing development', 'feature', 'ready for dev', 'analyst-agent', 1, 0, 0, 1, 1, 'runnable', '')
  `).run(competingTaskId);
  const competingDev = (await inspectAllDispatch()).find((item) => item.taskId === competingTaskId);
  assert.equal(competingDev?.agent, 'dev-agent');
  const competingExecutionId = 'execution-runtime-competing-dev';
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, story_index, agent, pipeline, lane, delegation_key,
      attempt, status, input_hash, input_json
    ) VALUES(?, 'run-runtime-input', ?, 1, 'dev-agent', 'dev', 'delivery', ?, 1, 'running', ?, '{}')
  `).run(competingExecutionId, competingTaskId, `key-${competingExecutionId}`, `hash-${competingExecutionId}`);
  await markTestDelegationRunning(competingDev!, competingExecutionId);
  db.prepare("UPDATE tasks SET agile_status = 'in dev', current_subagent = 'dev-agent' WHERE task_id = ?").run(competingTaskId);

  await answerRuntimeInput({ taskId, requestId: detail!.runtimeInputs[0].request_id, answer: '#N/A' });
  await submitRuntimeInputs(taskId);
  assert.equal((await getTask(taskId))?.task.resume_pending, 0);
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE)?.owner_task_id, competingTaskId);
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE)?.owner_execution_id, competingExecutionId);
  assert.deepEqual(await inspectTaskDispatch(taskId), []);
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle' WHERE task_id = ?").run(competingTaskId);
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE execution_id = ?").run(competingExecutionId);
  releaseExecutionResourceClaimsInDb(db, competingExecutionId);
  releaseResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, competingTaskId);

  const devResume = (await inspectTaskDispatch(taskId))[0];
  assert.deepEqual(devResume, {
    taskId,
    lane: 'delivery',
    pipeline: 'resume',
    agent: 'dev-agent',
    storyIndex: 1,
    resources: ['code:workspace', 'browser:exclusive'],
    description: '读取人工输入，并恢复开发验证通道',
  });
  addExecution('execution-runtime-dev-resume', 'dev-agent', 'resume');
  await markTestDelegationRunning(envelope('dev-agent', 'resume'), 'execution-runtime-dev-resume');
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE)?.owner_task_id, taskId);
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE)?.owner_execution_id, 'execution-runtime-dev-resume');
  await applyAgentResult('run-runtime-input', envelope('dev-agent', 'resume'), parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'Implementation completed using the supplied repository metadata.',
    changedFiles: [],
  })), { executionId: 'execution-runtime-dev-resume' });
  await completeExecution('execution-runtime-dev-resume');
  detail = await getTask(taskId);
  assert.equal(detail?.task.dev_index, 1);
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE)?.owner_task_id, taskId);
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE), undefined);
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
  await markTestDelegationRunning(envelope('test-agent', 'test'), 'execution-runtime-test-request');
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE)?.owner_execution_id, 'execution-runtime-test-request');
  await applyAgentResult('run-runtime-input', envelope('test-agent', 'test'), parseAgentResult(JSON.stringify({
    outcome: 'needs_input',
    summary: 'A target test environment is required.',
    runtimeInputs: [{ title: '测试环境', question: '应在哪个已配置环境执行黑盒验证？' }],
  })), { executionId: 'execution-runtime-test-request' });
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE), undefined);
  await completeExecution('execution-runtime-test-request');
  detail = await getTask(taskId);
  const testInput = detail!.runtimeInputs.find((input) => input.source_agent === 'test-agent')!;
  assert.equal(detail?.task.run_state, 'waiting_for_runtime_input');
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE), undefined);
  await answerRuntimeInput({ taskId, requestId: testInput.request_id, answer: '使用本地预览环境。' });
  await submitRuntimeInputs(taskId);
  assert.equal((await getTask(taskId))?.task.resume_pending, 0);
  assert.equal((await inspectTaskDispatch(taskId))[0]?.agent, 'test-agent');
  assert.equal((await inspectTaskDispatch(taskId))[0]?.pipeline, 'resume');

  addExecution('execution-runtime-test-resume', 'test-agent', 'resume');
  await markTestDelegationRunning(envelope('test-agent', 'resume'), 'execution-runtime-test-resume');
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE)?.owner_execution_id, 'execution-runtime-test-resume');
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
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE), undefined);
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE), undefined);
  assert.equal(detail?.runtimeInputs.find((input) => input.source_agent === 'test-agent')?.status, 'resolved');
});

test('persists execution input before work and recovers output without rerunning the Agent', async () => {
  const { createTask } = await import('./tasks');
  const {
    completeExecution,
    markExecutionOutput,
    recordExecutionReceipt,
  } = await import('./executions');
  const { progressDispatcher } = await import('./progress-dispatch');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Durable execution input' });
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle' WHERE task_id != ?").run(taskId);
  const delegation = (await inspectAllDispatch()).find((item) => item.taskId === taskId);
  assert.ok(delegation);

  const runtime = { executorId: 'codex', configuredModel: 'gpt-5.6-terra', reasoningEffort: 'high' };
  const started = await beginTestExecutionAttempt({ runId: 'run-durable-test', delegation, prompt: 'stable prompt', ...runtime });
  assert.equal(started.recovered, false);
  assert.equal(started.attempt.status, 'running');
  assert.equal(started.attempt.executor_id, 'codex');
  assert.equal(started.attempt.configured_model, 'gpt-5.6-terra');
  assert.equal(started.attempt.reasoning_effort, 'high');
  await markExecutionOutput(started.attempt.execution_id, { outcome: 'completed', summary: 'captured output' });
  const recoverable = await progressDispatcher.nextRecovery();
  assert.equal(recoverable?.attempt.execution_id, started.attempt.execution_id);
  assert.match(recoverable?.attempt.result_json || '', /captured output/);

  await recordExecutionReceipt(started.attempt.execution_id, 'code_commit', 'abc123', { committed: true });
  await completeExecution(started.attempt.execution_id);
  const repeated = await beginTestExecutionAttempt({ runId: 'run-durable-test-2', delegation, prompt: 'stable prompt', ...runtime });
  assert.equal(repeated.recovered, true);
  assert.equal(repeated.attempt.status, 'applied');
  const row = db.prepare('SELECT code_commit, executor_id FROM execution_attempts WHERE execution_id = ?').get(started.attempt.execution_id) as { code_commit: string; executor_id: string };
  assert.equal(row.code_commit, 'abc123');
  assert.equal(row.executor_id, 'codex');
});

test('keeps retry attempts in one logical generation even when the rebuilt prompt changes', async () => {
  const { createTask } = await import('./tasks');
  const { completeExecution, failExecutionWithRetryPolicy } = await import('./executions');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Stable retry generation' });
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle' WHERE task_id != ?").run(taskId);
  const delegation = (await inspectAllDispatch()).find((item) => item.taskId === taskId);
  assert.ok(delegation);

  const first = await beginTestExecutionAttempt({ runId: 'run-retry-1', delegation, prompt: 'prompt before execution history exists' });
  await failExecutionWithRetryPolicy(first.attempt.execution_id, 'executor failed', { kind: 'agent-execution', maxRetries: 3 });
  const second = await beginTestExecutionAttempt({ runId: 'run-retry-2', delegation, prompt: 'prompt now includes attempt one' });
  await failExecutionWithRetryPolicy(second.attempt.execution_id, 'executor failed again', { kind: 'agent-execution', maxRetries: 3 });
  const third = await beginTestExecutionAttempt({ runId: 'run-retry-3', delegation, prompt: 'prompt now includes attempts one and two' });

  assert.deepEqual([first.attempt.attempt, second.attempt.attempt, third.attempt.attempt], [1, 2, 3]);
  assert.equal(second.attempt.delegation_key, first.attempt.delegation_key);
  assert.equal(third.attempt.delegation_key, first.attempt.delegation_key);

  await completeExecution(third.attempt.execution_id);
  const rework = await beginTestExecutionAttempt({ runId: 'run-rework-1', delegation, prompt: 'new rework generation after completion' });
  assert.equal(rework.recovered, false);
  assert.equal(rework.attempt.attempt, 1);
  assert.notEqual(rework.attempt.delegation_key, first.attempt.delegation_key);
  await completeExecution(rework.attempt.execution_id);
});

test('shares one three-retry budget across every failure kind in a generation', async () => {
  const { createTask } = await import('./tasks');
  const { completeExecution, failExecutionWithRetryPolicy } = await import('./executions');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Independent CLI retry budget' });
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle' WHERE task_id != ?").run(taskId);
  const delegation = (await inspectAllDispatch()).find((item) => item.taskId === taskId);
  assert.ok(delegation);

  const first = await beginTestExecutionAttempt({ runId: 'run-kind-1', delegation, prompt: 'first failure kind' });
  const firstRetry = await failExecutionWithRetryPolicy(first.attempt.execution_id, 'evidence failed', {
    kind: 'evidence-persistence', maxRetries: 3,
  });
  const second = await beginTestExecutionAttempt({ runId: 'run-kind-2', delegation, prompt: 'second failure kind' });
  const secondRetry = await failExecutionWithRetryPolicy(second.attempt.execution_id, 'missing terminal command', {
    kind: 'agent-missing-terminal-command', maxRetries: 3,
  });
  const third = await beginTestExecutionAttempt({ runId: 'run-kind-3', delegation, prompt: 'third failure kind' });
  const thirdRetry = await failExecutionWithRetryPolicy(third.attempt.execution_id, 'CLI exit 1', {
    kind: 'agent-cli-exit', maxRetries: 3,
  });
  assert.deepEqual(
    [firstRetry, secondRetry, thirdRetry].map((retry) => ({ willRetry: retry.willRetry, failureAttempt: retry.failureAttempt })),
    [
      { willRetry: true, failureAttempt: 1 },
      { willRetry: true, failureAttempt: 2 },
      { willRetry: true, failureAttempt: 3 },
    ],
  );

  const fourth = await beginTestExecutionAttempt({ runId: 'run-kind-4', delegation, prompt: 'fourth failure blocks' });
  const blocked = await failExecutionWithRetryPolicy(fourth.attempt.execution_id, 'application failed', {
    kind: 'agent-result-application', maxRetries: 3,
  });
  assert.deepEqual(
    { willRetry: blocked.willRetry, failureAttempt: blocked.failureAttempt, globalAttempt: fourth.attempt.attempt },
    { willRetry: false, failureAttempt: 4, globalAttempt: 4 },
  );
  const rows = db.prepare(`
    SELECT failure_kind, status FROM execution_attempts
    WHERE execution_id IN (?, ?, ?, ?) ORDER BY attempt
  `).all(first.attempt.execution_id, second.attempt.execution_id, third.attempt.execution_id, fourth.attempt.execution_id);
  assert.deepEqual(rows, [
    { failure_kind: 'evidence-persistence', status: 'retryable_failed' },
    { failure_kind: 'agent-missing-terminal-command', status: 'retryable_failed' },
    { failure_kind: 'agent-cli-exit', status: 'retryable_failed' },
    { failure_kind: 'agent-result-application', status: 'system_blocked' },
  ]);
  const failureEvents = db.prepare(`
    SELECT event_type, summary FROM task_events
    WHERE task_id = ? AND event_type IN ('AgentExecutionRetryScheduled', 'AgentExecutionRetriesExhausted')
    ORDER BY rowid
  `).all(taskId) as Array<{ event_type: string; summary: string }>;
  assert.deepEqual(failureEvents.map((event) => event.event_type), [
    'AgentExecutionRetryScheduled',
    'AgentExecutionRetryScheduled',
    'AgentExecutionRetryScheduled',
    'AgentExecutionRetriesExhausted',
  ]);
  assert.match(failureEvents[0].summary, /evidence-persistence.*execution=.*evidence failed/);
  assert.match(failureEvents[1].summary, /agent-missing-terminal-command.*missing terminal command/);
  assert.match(failureEvents[2].summary, /agent-cli-exit.*CLI exit 1/);
  assert.match(failureEvents[3].summary, /第 4 次失败，3 次自动重试已耗尽.*agent-result-application.*application failed/);
  await completeExecution(fourth.attempt.execution_id);
});

test('records background Evolution evaluator failures with three retries and the exact error', async () => {
  const { createTask } = await import('./tasks');
  const { beginEvolutionRun, recordEvolutionFailureAttempt } = await import('./agent-evolution');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Evolution evaluator retry activity' });
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, agent, pipeline, delegation_key,
      attempt, status, input_hash, input_json, result_json
    ) VALUES('execution-evolution-retry', 'run-evolution-retry', ?, 'dev-agent', 'dev',
      'key-evolution-retry', 1, 'applied', 'hash-evolution-retry', '{}', '{"outcome":"completed"}')
  `).run(taskId);
  const evidence = {
    executionId: 'execution-evolution-retry',
    taskId,
    storyIndex: 1,
    agentId: 'dev-agent',
    attempt: 1,
    promptVersion: 1,
    result: { outcome: 'completed', summary: 'Primary execution completed.' },
    applicationOutcome: 'advanced',
    diagnostics: [],
  };
  const evolution = await beginEvolutionRun(evidence);
  assert.ok(evolution?.evolutionId);

  for (let failureAttempt = 1; failureAttempt <= 4; failureAttempt += 1) {
    const retry = await recordEvolutionFailureAttempt({
      evolutionId: evolution!.evolutionId,
      evidence,
      error: `evaluator failure ${failureAttempt}: exact diagnostic`,
      failureAttempt,
      maxRetries: 3,
    });
    assert.equal(retry.willRetry, failureAttempt <= 3);
  }

  assert.deepEqual(
    db.prepare('SELECT status, error FROM agent_evolution_runs WHERE evolution_id = ?').get(evolution!.evolutionId),
    { status: 'failed', error: 'evaluator failure 4: exact diagnostic' },
  );
  const events = db.prepare(`
    SELECT event_type, summary FROM task_events
    WHERE task_id = ? AND event_type IN ('AgentExecutionRetryScheduled', 'AgentExecutionRetriesExhausted')
    ORDER BY rowid
  `).all(taskId) as Array<{ event_type: string; summary: string }>;
  assert.deepEqual(events.map((event) => event.event_type), [
    'AgentExecutionRetryScheduled',
    'AgentExecutionRetryScheduled',
    'AgentExecutionRetryScheduled',
    'AgentExecutionRetriesExhausted',
  ]);
  assert.match(events[0].summary, /evolution-evaluator.*evaluator failure 1: exact diagnostic/);
  assert.match(events[3].summary, /第 4 次失败，3 次自动重试已耗尽.*evaluator failure 4: exact diagnostic/);
});

test('does not let a late execution failure overwrite cancellation', async () => {
  const { createTask } = await import('./tasks');
  const {
    cancelExecution,
    failExecutionWithRetryPolicy,
  } = await import('./executions');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Cancellation wins over late failure' });
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle' WHERE task_id != ?").run(taskId);
  const delegation = (await inspectAllDispatch()).find((item) => item.taskId === taskId);
  assert.ok(delegation);

  const started = await beginTestExecutionAttempt({
    runId: 'run-cancel-before-failure',
    delegation,
    prompt: 'stable prompt',
  });
  await cancelExecution(started.attempt.execution_id, 'user cancelled');
  await failExecutionWithRetryPolicy(started.attempt.execution_id, 'late receipt failure', {
    kind: 'agent-execution',
    maxRetries: 3,
  });

  const row = db.prepare(`
    SELECT status, last_error
    FROM execution_attempts WHERE execution_id = ?
  `).get(started.attempt.execution_id) as { status: string; last_error: string };
  assert.deepEqual(row, { status: 'cancelled', last_error: 'user cancelled' });
});

test('records a late Agent result after cancellation without reopening task lanes or applying effects', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { parseAgentResult } = await import('../domain/agent-result');
  const { cancelTask, createTask, getTask } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Cancel while Agent is running' });
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle' WHERE task_id != ?").run(taskId);
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE status != 'applied'").run();
  db.prepare("UPDATE agent_results SET application_status = 'applied' WHERE application_status = 'pending'").run();
  const delegation = (await inspectAllDispatch()).find((item) => item.taskId === taskId);
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

test('cancels an active Dev requirement and automatically releases both of its resources', async () => {
  const {
    cancelExecution,
    executionCancellationRequested,
  } = await import('./executions');
  const { cancelTask, getTask } = await import('./tasks');
  const {
    acquireResourceClaimsInDb,
    BROWSER_EXCLUSIVE_RESOURCE,
    CODE_WORKSPACE_RESOURCE,
    resourceClaimInDb,
  } = await import('./resource-claims');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle'").run();
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE status != 'applied'").run();
  db.prepare("UPDATE agent_results SET application_status = 'applied' WHERE application_status = 'pending'").run();
  const taskId = 'TASK-cancel-active-dev';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Cancel active Dev', 'feature', 'in dev', 'dev-agent', 1, 0, 0, 1, 1, '')
  `).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Cancelable unit', 'story-001')").run(taskId);
  const delegation = {
    taskId,
    lane: 'delivery' as const,
    pipeline: 'dev',
    agent: 'dev-agent',
    storyIndex: 1,
    resources: resourcesForAgent('dev-agent'),
    description: 'Implement cancelable unit',
    title: 'Cancel active Dev',
    taskDescription: null,
    itemType: 'feature',
    priority: '',
    link: '',
    externalId: '',
    externalStatus: '',
    agileStatus: 'in dev',
    currentSubagent: 'dev-agent',
    resumePending: 0,
    specResolvedIndex: 1,
    runState: 'runnable',
    closureStatus: 'none',
    reviewRevision: 0,
    reviewDocumentId: '',
    lastActor: '',
    analysisIndex: 1,
    devIndex: 0,
    testIndex: 0,
    totalStories: 1,
    nextStep: '',
    blockedReason: '',
    owner: '',
    evidence: '',
    risk: '',
  };
  const execution = await beginTestExecutionAttempt({
    runId: 'run-cancel-active-dev',
    delegation,
    prompt: 'Implement until cancelled.',
  });
  acquireResourceClaimsInDb(db, {
    resourceKeys: resourcesForAgent('dev-agent'),
    taskId,
    lane: 'delivery',
    storyIndex: 1,
    executionId: execution.attempt.execution_id,
  });
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE)?.owner_task_id, taskId);
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE)?.owner_execution_id, execution.attempt.execution_id);
  db.prepare(`
    INSERT INTO agent_results(
      result_id, run_id, task_id, story_index, agent, pipeline, outcome,
      result_json, application_status, execution_id
    ) VALUES(
      'RESULT-cancel-active-dev', 'run-cancel-active-dev', ?, 1, 'dev-agent', 'dev', 'completed',
      '{"outcome":"completed","summary":"queued"}', 'pending', NULL
    )
  `).run(taskId);

  await cancelTask({ taskId, reason: 'Requirement withdrawn' });

  const detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'cancelled');
  assert.equal(detail?.task.run_state, 'idle');
  assert.deepEqual(detail?.lanes.map((lane) => lane.status), ['completed', 'completed']);
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE), undefined);
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE), undefined);
  assert.equal(await executionCancellationRequested(execution.attempt.execution_id), true);
  const pending = db.prepare(`
    SELECT application_status, effect_outcome FROM agent_results WHERE result_id = 'RESULT-cancel-active-dev'
  `).get() as { application_status: string; effect_outcome: string };
  assert.deepEqual(pending, { application_status: 'applied', effect_outcome: 'discarded' });

  await cancelExecution(execution.attempt.execution_id);
  const status = db.prepare('SELECT status FROM execution_attempts WHERE execution_id = ?').get(execution.attempt.execution_id) as { status: string };
  assert.equal(status.status, 'cancelled');
  assert.equal((await inspectAllDispatch()).some((item) => item.taskId === taskId), false);
});

test('pauses one requirement without changing its workflow state and resumes it from the same step', async () => {
  const { executionCancellationRequested } = await import('./executions');
  const { createTask, getTask, pauseTask, resumeTask } = await import('./tasks');
  const {
    acquireResourceClaimsInDb,
    BROWSER_EXCLUSIVE_RESOURCE,
    CODE_WORKSPACE_RESOURCE,
    resourceClaimInDb,
  } = await import('./resource-claims');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle'").run();
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE status != 'applied'").run();
  db.prepare("UPDATE agent_results SET application_status = 'applied' WHERE application_status = 'pending'").run();

  const taskId = await createTask({ title: 'Pause until the next planning window' });
  const delegation = (await inspectAllDispatch()).find((item) => item.taskId === taskId);
  assert.ok(delegation);
  const execution = await beginTestExecutionAttempt({
    runId: 'run-pause-requirement',
    delegation,
    prompt: 'This execution should stop when its requirement is paused.',
  });
  acquireResourceClaimsInDb(db, {
    resourceKeys: [CODE_WORKSPACE_RESOURCE, BROWSER_EXCLUSIVE_RESOURCE],
    taskId,
    lane: delegation.lane,
    storyIndex: delegation.storyIndex,
    executionId: execution.attempt.execution_id,
  });
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE)?.owner_task_id, taskId);
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE)?.owner_task_id, taskId);

  await pauseTask({ taskId, reason: '等待下周排期' });

  let detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'backlog');
  assert.equal(detail?.task.is_paused, 1);
  assert.equal(detail?.task.paused_reason, '等待下周排期');
  assert.ok(detail?.task.paused_at);
  assert.deepEqual(await inspectTaskDispatch(taskId), []);
  assert.equal((await inspectAllDispatch()).some((item) => item.taskId === taskId), false);
  assert.equal(await executionCancellationRequested(execution.attempt.execution_id), true);
  const pausedExecution = db.prepare('SELECT status, last_error FROM execution_attempts WHERE execution_id = ?').get(execution.attempt.execution_id) as { status: string; last_error: string };
  assert.deepEqual(pausedExecution, { status: 'cancelled', last_error: '需求已暂停' });
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE), undefined);
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE), undefined);
  assert.match(detail?.events[0]?.summary || '', /已立即释放资源：browser:exclusive、code:workspace/);

  await resumeTask({ taskId });

  detail = await getTask(taskId);
  assert.equal(detail?.task.agile_status, 'backlog');
  assert.equal(detail?.task.is_paused, 0);
  assert.equal(detail?.task.paused_reason, null);
  assert.equal(detail?.task.paused_at, null);
  assert.equal((await inspectAllDispatch()).some((item) => item.taskId === taskId), true);
  assert.equal(await executionCancellationRequested(execution.attempt.execution_id), true);
  assert.deepEqual(detail?.events.slice(0, 2).map((event) => event.event_type), ['TaskResumed', 'TaskPaused']);
});

test('isolates feedback scheduling per task and emits one concurrent delegation for each task queue', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { addDocumentComment, createTask, upsertDocument } = await import('./tasks');
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

  const delegations = await inspectAllDispatch();
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
  const { toPipeEnvelope } = await import('./tasks');
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

  const delegations = await inspectTaskDispatch(taskId);
  assert.deepEqual(delegations.map((item) => [item.lane, item.agent, item.storyIndex]).sort(), [
    ['analysis', 'analyst-agent', 2],
    ['delivery', 'dev-agent', 1],
  ]);
  const envelope = (await inspectAllDispatch()).find((item) => item.taskId === taskId && item.lane === 'analysis');
  assert.ok(envelope);
  const pipeColumns = toPipeEnvelope(envelope).split('|');
  assert.deepEqual(pipeColumns.slice(2, 5), ['analysis', 'analyst-agent', '2']);
  assert.equal(pipeColumns[6], 'analysis');
});

test('keeps Delivery runnable while Analysis waits for human clarification', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { getTask, setTaskLaneState } = await import('./tasks');
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

  const delegations = await inspectTaskDispatch(taskId);
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
  const whileDeliveryBlocked = await inspectTaskDispatch(taskId);
  assert.deepEqual(whileDeliveryBlocked.map((item) => [item.lane, item.agent, item.storyIndex]), [['analysis', 'analyst-agent', 2]]);
});

test('does not infer code-slot ownership from an Analysis task status', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { getTask, setTaskLaneState } = await import('./tasks');
  const { CODE_WORKSPACE_RESOURCE } = await import('./resource-claims');
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle'").run();
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE status != 'applied'").run();
  db.prepare("UPDATE agent_results SET application_status = 'applied' WHERE application_status = 'pending'").run();
  db.prepare('DELETE FROM resource_claims WHERE resource_key = ?').run(CODE_WORKSPACE_RESOURCE);

  const waitingTaskId = 'TASK-analysis-wait-without-code-claim';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index,
      run_state, work_dir
    ) VALUES(?, 'Waiting analysis', 'feature', 'in dev', 'analyst-agent', 1, 1, 1, 2, 1, 'waiting_for_answers', '')
  `).run(waitingTaskId);
  await getTask(waitingTaskId);
  await setTaskLaneState({
    taskId: waitingTaskId,
    lane: 'analysis',
    status: 'waiting_for_answers',
    currentAgent: 'analyst-agent',
    currentStoryIndex: 2,
    blockedReason: 'Need a product decision',
  });

  const competingTaskId = 'TASK-analysis-wait-independent-dev';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index,
      run_state, work_dir
    ) VALUES(?, 'Independent development', 'feature', 'ready for dev', 'analyst-agent', 1, 0, 0, 1, 1, 'runnable', '')
  `).run(competingTaskId);

  const competingDev = (await inspectAllDispatch()).find((item) => item.taskId === competingTaskId);
  assert.equal(competingDev?.agent, 'dev-agent');
});

test('blocks browser-dependent Dev and Backlog while Idea Context continues without browser', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const {
    BROWSER_EXCLUSIVE_RESOURCE,
    CODE_WORKSPACE_RESOURCE,
    acquireResourceClaimInDb,
    releaseExecutionResourceClaimsInDb,
  } = await import('./resource-claims');
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle'").run();
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE status != 'applied'").run();
  db.prepare("UPDATE agent_results SET application_status = 'applied' WHERE application_status = 'pending'").run();
  db.prepare('DELETE FROM resource_claims').run();

  const ownerTaskId = 'TASK-browser-claim-owner';
  const waitingBrowserTaskId = 'TASK-browser-claim-waiter';
  const devTaskId = 'TASK-browser-independent-dev';
  const ideaTaskId = 'TASK-browser-independent-idea-context';
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, current_subagent, work_dir)
    VALUES(?, 'Browser owner', 'feature', 'backlog', 'backlog-agent', '')
  `).run(ownerTaskId);
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, current_subagent, work_dir)
    VALUES(?, 'Browser waiter', 'feature', 'backlog', 'backlog-agent', '')
  `).run(waitingBrowserTaskId);
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Independent Dev', 'feature', 'ready for dev', 'analyst-agent', 1, 0, 0, 1, 1, '')
  `).run(devTaskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Independent unit', 'unit-001')").run(devTaskId);
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, current_subagent, work_dir)
    VALUES(?, 'Idea context without browser', 'business-analysis', 'backlog', 'idea-context-agent', '')
  `).run(ideaTaskId);
  db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, run_id, task_id, agent, pipeline, lane, delegation_key,
      attempt, status, input_hash, input_json
    ) VALUES('EXEC-browser-claim-owner', 'RUN-browser-claim', ?, 'backlog-agent', 'backlog', 'control',
      'key-browser-claim-owner', 1, 'running', 'hash-browser-claim-owner', '{}')
  `).run(ownerTaskId);
  acquireResourceClaimInDb(db, {
    resourceKey: BROWSER_EXCLUSIVE_RESOURCE,
    taskId: ownerTaskId,
    lane: 'control',
    executionId: 'EXEC-browser-claim-owner',
  });

  const whileClaimed = await inspectAllDispatch();
  assert.equal(whileClaimed.some((item) => item.resources.includes(BROWSER_EXCLUSIVE_RESOURCE)), false);
  assert.equal(whileClaimed.some((item) => item.taskId === devTaskId && item.agent === 'dev-agent'), false);
  assert.equal(whileClaimed.some((item) => item.taskId === waitingBrowserTaskId && item.agent === 'backlog-agent'), false);
  const ideaContext = whileClaimed.find((item) => item.taskId === ideaTaskId);
  assert.equal(ideaContext?.agent, 'idea-context-agent');
  assert.deepEqual(ideaContext?.resources, []);

  releaseExecutionResourceClaimsInDb(db, 'EXEC-browser-claim-owner');
  const afterRelease = await inspectAllDispatch();
  assert.equal(afterRelease.filter((item) => item.resources.includes(BROWSER_EXCLUSIVE_RESOURCE)).length, 1);
  assert.equal(afterRelease.some((item) => item.taskId === waitingBrowserTaskId && item.agent === 'backlog-agent'), true);
  assert.deepEqual((await inspectTaskDispatch(devTaskId))[0]?.resources, [
    CODE_WORKSPACE_RESOURCE,
    BROWSER_EXCLUSIVE_RESOURCE,
  ]);
});

test('persists resource and lane reservations before returning work to the runner', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { beginRun, endRun } = await import('./tasks');
  const { progressDispatcher } = await import('./progress-dispatch');
  const {
    BROWSER_EXCLUSIVE_RESOURCE,
    CODE_WORKSPACE_RESOURCE,
  } = await import('./resource-claims');
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle'").run();
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE status != 'applied'").run();
  db.prepare("UPDATE agent_results SET application_status = 'applied' WHERE application_status = 'pending'").run();
  db.prepare('DELETE FROM resource_claims').run();

  const devTaskId = 'TASK-local-reservation-dev';
  const backlogTaskId = 'TASK-local-reservation-backlog';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Locally launched Dev', 'feature', 'ready for dev', 'analyst-agent', 1, 0, 0, 1, 1, '')
  `).run(devTaskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Reserved unit', 'unit-001')").run(devTaskId);
  db.prepare("UPDATE tasks SET priority = '9' WHERE task_id = ?").run(devTaskId);
  db.prepare(`
    INSERT INTO tasks(task_id, title, item_type, agile_status, current_subagent, work_dir)
    VALUES(?, 'Browser contender', 'feature', 'backlog', 'backlog-agent', '')
  `).run(backlogTaskId);
  db.prepare("UPDATE tasks SET priority = '1' WHERE task_id = ?").run(backlogTaskId);

  const dev = (await inspectTaskDispatch(devTaskId))[0];
  assert.deepEqual(dev.resources, [CODE_WORKSPACE_RESOURCE, BROWSER_EXCLUSIVE_RESOURCE]);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM resource_claims').get() as { count: number }).count, 0);

  const runId = await beginRun('dispatch-reservation-test');
  try {
    const reserved = await progressDispatcher.reserveNext({ runId });
    assert.equal(reserved.kind, 'reserved');
    const devReservation = reserved.reservations.find((item) => item.work.taskId === devTaskId);
    assert.ok(devReservation);
    assert.deepEqual(devReservation.claimedResources, [CODE_WORKSPACE_RESOURCE, BROWSER_EXCLUSIVE_RESOURCE]);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM resource_claims').get() as { count: number }).count, 2);

    const refill = await progressDispatcher.reserveNext({ runId });
    assert.equal(refill.kind, 'wait');
  } finally {
    await endRun(runId, true, { stopRunner: false });
  }
});

test('dispatches the highest numeric priority first when requirements compete for one resource', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask } = await import('./tasks');
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle'").run();
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE status != 'applied'").run();
  db.prepare("UPDATE agent_results SET application_status = 'applied' WHERE application_status = 'pending'").run();
  db.prepare('DELETE FROM resource_claims').run();

  const lowPriorityTaskId = await createTask({ title: 'Low priority resource contender', priority: '2' });
  const highPriorityTaskId = await createTask({ title: 'High priority resource contender', priority: '9' });
  const contenders = (await inspectAllDispatch()).filter((item) =>
    item.taskId === lowPriorityTaskId || item.taskId === highPriorityTaskId);

  assert.equal(contenders.length, 1);
  assert.equal(contenders[0].taskId, highPriorityTaskId);
  assert.equal(contenders[0].priority, '9');
});

test('caps Analysis concurrency at four and preserves existing task cursors when lanes are materialized', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { getTask } = await import('./tasks');
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
  const analysis = (await inspectAllDispatch()).filter((item) => taskIds.includes(item.taskId) && item.lane === 'analysis');
  assert.equal(analysis.length, 4);
  assert.equal(analysis.some((item) => item.taskId === 'TASK-analysis-cap-4'), true);
});

test('releases only the requested blocked lane and resumes its persisted delivery unit', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { getTask, releaseBlock, setTaskLaneState } = await import('./tasks');
  const {
    acquireResourceClaimInDb,
    CODE_WORKSPACE_RESOURCE,
    resourceClaimInDb,
  } = await import('./resource-claims');
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
  acquireResourceClaimInDb(db, {
    resourceKey: CODE_WORKSPACE_RESOURCE,
    taskId,
    lane: 'delivery',
    storyIndex: 1,
  });
  await setTaskLaneState({ taskId, lane: 'analysis', status: 'system_blocked', currentAgent: 'analyst-agent', currentStoryIndex: 1, blockedReason: 'analysis failed' });
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE)?.owner_task_id, taskId);
  await setTaskLaneState({ taskId, lane: 'delivery', status: 'system_blocked', currentAgent: 'dev-agent', currentStoryIndex: 1, blockedReason: 'delivery failed' });
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE), undefined);

  await releaseBlock(taskId, 'analysis');

  const detail = await getTask(taskId);
  assert.deepEqual(detail?.lanes.map((lane) => [lane.lane, lane.status, lane.resume_pending]), [
    ['analysis', 'runnable', 1],
    ['delivery', 'system_blocked', 0],
  ]);
  assert.deepEqual((await inspectTaskDispatch(taskId)).map((item) => [item.lane, item.pipeline, item.storyIndex]), [
    ['analysis', 'resume', 1],
  ]);
});

test('opens Review only after both lanes are completed and never skips a post-result lane block', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { getTask, releaseBlock, setTaskLaneState } = await import('./tasks');
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

  assert.deepEqual(await inspectTaskDispatch(taskId), []);
  await releaseBlock(taskId, 'analysis');
  assert.deepEqual((await inspectTaskDispatch(taskId)).map((item) => [item.lane, item.pipeline, item.storyIndex]), [
    ['analysis', 'resume', 1],
  ]);

  await setTaskLaneState({ taskId, lane: 'analysis', status: 'completed' });
  const review = await inspectTaskDispatch(taskId);
  assert.equal(review.length, 1);
  assert.deepEqual([review[0].lane, review[0].agent, review[0].pipeline], ['control', 'review-agent', 'review']);
});

test('does not dispatch Review when a task is manually moved to review with incomplete units', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  db.prepare("UPDATE tasks SET agile_status = 'done', closure_status = 'acknowledged', run_state = 'idle'").run();
  const taskId = 'TASK-incomplete-manual-review';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Incomplete manual review', 'feature', 'in review', 'review-agent', 1, 0, 0, 2, 1, '')
  `).run(taskId);
  assert.deepEqual(await inspectTaskDispatch(taskId), []);
});

test('treats legacy task-level blocked state as an exclusive control gate', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { getTask } = await import('./tasks');
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
  assert.deepEqual(await inspectTaskDispatch(taskId), []);
  assert.equal((await inspectAllDispatch()).some((item) => item.taskId === taskId), false);
});

test('counts one active Analysis lane once when both its execution and queued result are visible', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
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
  const dispatched = (await inspectAllDispatch()).filter((item) => candidates.includes(item.taskId) && item.lane === 'analysis');
  assert.equal(dispatched.length, 3);
});

test('initializes one project-owned Prompt from the system template without overwriting project edits', async () => {
  const {
    ensureAgentRuntimeWorkspace,
    agentProfileInternals,
    getAgentProfile,
    loadAgentRuntime,
    resetAgentPromptToSystemTemplate,
    saveAgentMemory,
    saveAgentPrompt,
  } = await import('./agent-profiles');
  const { databaseConnection, hash } = await import('../infrastructure/database');
  const { AGENT_PROFILE_DEFINITIONS } = await import('../domain/agent-profile');

  const runtimeRoot = await ensureAgentRuntimeWorkspace();
  assert.ok(!runtimeRoot.startsWith(process.env.LOOP_WORKSPACE_ROOT_OVERRIDE || ''));
  const original = await getAgentProfile('dev-agent');
  assert.equal(original.profile.prompt_seed_revision, 13);
  assert.equal(original.currentPrompt.version, 1);
  assert.equal(original.currentPrompt.template_version, 13);
  assert.equal(original.currentPrompt.source, 'system');
  assert.equal(original.currentPrompt.content, AGENT_PROFILE_DEFINITIONS['dev-agent'].prompt);
  assert.equal('promptHistory' in original, false);
  assert.equal(existsSync(join(original.runtimeDirectory, 'history')), false);
  assert.equal(existsSync(join(original.runtimeDirectory, 'candidates')), false);
  assert.ok(original.currentPrompt.content.length > 800);
  assert.match(original.currentPrompt.content, /# 角色目标/);
  assert.match(original.currentPrompt.content, /# 完成条件/);

  const db = await databaseConnection();
  db.prepare(`
    UPDATE agent_prompts
    SET version = 1, template_version = 1, content = '旧系统模板', content_hash = ?, source = 'system'
    WHERE agent_id = 'review-agent'
  `).run(hash('旧系统模板'));
  db.prepare(`
    UPDATE agent_profiles
    SET current_prompt_version = 1, prompt_seed_revision = 1, candidate_prompt_version = NULL
    WHERE agent_id = 'review-agent'
  `).run();
  await ensureAgentRuntimeWorkspace();
  const upgradedSystemSeed = await getAgentProfile('review-agent');
  assert.equal(upgradedSystemSeed.profile.prompt_seed_revision, 13);
  assert.equal(upgradedSystemSeed.currentPrompt.version, 2);
  assert.equal(upgradedSystemSeed.currentPrompt.template_version, 13);
  assert.equal(upgradedSystemSeed.currentPrompt.content, AGENT_PROFILE_DEFINITIONS['review-agent'].prompt);

  const legacyPrompt = '判断需求类型并整理上下文，完成时提供分类、流程方向和需求文档。';
  db.prepare(`
    UPDATE agent_prompts SET content = ?, content_hash = ?
    WHERE agent_id = 'backlog-agent'
  `).run(legacyPrompt, hash(legacyPrompt));
  db.prepare(`
    UPDATE agent_profiles SET current_prompt_version = 1, candidate_prompt_version = NULL, prompt_seed_revision = 0
    WHERE agent_id = 'backlog-agent'
  `).run();
  agentProfileInternals.atomicWrite(join(agentProfileInternals.agentDirectory('backlog-agent'), 'PROMPT.md'), legacyPrompt);
  await ensureAgentRuntimeWorkspace();
  const upgradedSeed = await getAgentProfile('backlog-agent');
  assert.equal(upgradedSeed.profile.prompt_seed_revision, 0);
  assert.equal(upgradedSeed.currentPrompt.version, 1);
  assert.equal(upgradedSeed.currentPrompt.content, legacyPrompt);
  assert.equal(upgradedSeed.currentPrompt.source, 'system');
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM agent_prompts WHERE agent_id = 'backlog-agent'").get() as { count: number }).count,
    1,
  );
  agentProfileInternals.atomicWrite(join(agentProfileInternals.agentDirectory('backlog-agent'), 'PROMPT.md'), legacyPrompt);
  db.prepare("DELETE FROM agent_prompts WHERE agent_id = 'backlog-agent'").run();
  await ensureAgentRuntimeWorkspace();
  const resetBaseline = await getAgentProfile('backlog-agent');
  assert.equal(resetBaseline.currentPrompt.version, 1);
  assert.equal(resetBaseline.currentPrompt.template_version, 13);
  assert.match(resetBaseline.currentPrompt.content, /# 工作原则/);
  assert.doesNotMatch(resetBaseline.currentPrompt.content, /完成时提供分类、流程方向/);
  assert.match(
    readFileSync(join(resetBaseline.runtimeDirectory, 'PROMPT.md'), 'utf8'),
    /# 工作原则/,
  );
  const resumedBacklog = await loadAgentRuntime('backlog-agent', 'resume');
  assert.match(resumedBacklog.prompt, /已有用户决定必须按原 key 继承/);
  const resumedAnalyst = await loadAgentRuntime('analyst-agent', 'resume');
  assert.match(resumedAnalyst.prompt, /decision key 是跨轮次不可变的系统标识/);
  assert.match(resumedAnalyst.prompt, /逐字复用/);

  const projectPrompt = `${original.currentPrompt.content}\n\n# 当前项目约定\n\n- 在修改前先读取相关交付规格。`;
  const promptRevision = await saveAgentPrompt({ agentId: 'dev-agent', content: projectPrompt, reason: 'test project prompt' });
  const memoryRevision = await saveAgentMemory({
    agentId: 'dev-agent',
    content: '# Durable Memory\n\n- 项目使用 npm test 运行确定性测试。',
    reason: 'test memory revision',
  });
  const edited = await getAgentProfile('dev-agent');
  assert.equal(edited.currentPrompt.version, promptRevision);
  assert.equal(edited.currentPrompt.source, 'human');
  assert.equal(edited.currentPrompt.content, projectPrompt);
  assert.equal(edited.currentPrompt.content_hash, hash(projectPrompt));
  assert.equal(edited.currentMemory.revision, memoryRevision);
  assert.equal(edited.memoryHistory.length, original.memoryHistory.length + 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM agent_prompts WHERE agent_id = 'dev-agent'").get() as { count: number }).count,
    1,
  );
  assert.equal(
    readFileSync(join(edited.runtimeDirectory, 'PROMPT.md'), 'utf8').trim(),
    projectPrompt,
  );
  assert.match(readFileSync(join(edited.runtimeDirectory, 'MEMORY.md'), 'utf8'), /npm test/);

  await ensureAgentRuntimeWorkspace();
  const preserved = await getAgentProfile('dev-agent');
  assert.equal(preserved.currentPrompt.content, projectPrompt);
  assert.equal(preserved.currentPrompt.version, promptRevision);

  const localPrompt = `${projectPrompt}\n- 这条旧本地内容不得反向导入数据库。`;
  writeFileSync(join(edited.runtimeDirectory, 'PROMPT.md'), localPrompt);
  await ensureAgentRuntimeWorkspace();
  const reconciled = await getAgentProfile('dev-agent');
  assert.equal(reconciled.currentPrompt.version, promptRevision);
  assert.equal(reconciled.currentPrompt.content, projectPrompt);
  assert.doesNotMatch(readFileSync(join(reconciled.runtimeDirectory, 'PROMPT.md'), 'utf8'), /旧本地内容/);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM agent_prompts WHERE agent_id = 'dev-agent'").get() as { count: number }).count,
    1,
  );
  const runtime = await loadAgentRuntime('dev-agent', 'plan');
  assert.equal(runtime.promptVersion, reconciled.currentPrompt.version);
  assert.equal(runtime.promptTemplateVersion, 13);
  assert.equal(runtime.promptHash, hash(projectPrompt));
  assert.equal(runtime.promptStatus, 'active');
  assert.equal(runtime.evolutionCandidateId, null);
  assert.equal(runtime.prompt, projectPrompt);
  assert.match(runtime.prompt, /在修改前先读取相关交付规格/);
  assert.match(runtime.memory, /npm test/);

  const resetRevision = await resetAgentPromptToSystemTemplate({ agentId: 'dev-agent' });
  const reset = await getAgentProfile('dev-agent');
  assert.equal(resetRevision, promptRevision + 1);
  assert.equal(reset.currentPrompt.version, resetRevision);
  assert.equal(reset.currentPrompt.template_version, 13);
  assert.equal(reset.currentPrompt.source, 'system');
  assert.equal(reset.currentPrompt.reason, '用户重置为系统模板 V13');
  assert.equal(reset.currentPrompt.content, AGENT_PROFILE_DEFINITIONS['dev-agent'].prompt);
  assert.equal(reset.currentMemory.revision, memoryRevision);
  assert.equal(reset.candidatePrompt, null);
  assert.equal(
    readFileSync(join(reset.runtimeDirectory, 'PROMPT.md'), 'utf8').trim(),
    AGENT_PROFILE_DEFINITIONS['dev-agent'].prompt,
  );
  assert.match(readFileSync(join(reset.runtimeDirectory, 'MEMORY.md'), 'utf8'), /npm test/);
  assert.equal(
    await resetAgentPromptToSystemTemplate({ agentId: 'dev-agent' }),
    resetRevision,
  );
});

test('promotes repeated evolution evidence and gates Prompt changes through deterministic Canary runs', async () => {
  const { createTask } = await import('./tasks');
  const { databaseConnection, hash } = await import('../infrastructure/database');
  const { applyEvolutionResult, beginEvolutionRun, updatePromptCanary } = await import('./agent-evolution');
  const { ensureAgentRuntimeWorkspace, getAgentProfile, loadAgentRuntime } = await import('./agent-profiles');
  const { cancelExecution } = await import('./executions');
  const db = await databaseConnection();
  const taskA = await createTask({ title: 'Evolution evidence A' });
  const taskB = await createTask({ title: 'Evolution evidence B' });

  const addExecution = (executionId: string, taskId: string, candidateId: string | null = null) => {
    db.prepare(`
      INSERT INTO execution_attempts(
        execution_id, run_id, task_id, agent, pipeline, delegation_key,
        attempt, status, input_hash, input_json, result_json, evolution_candidate_id
      ) VALUES(?, 'run-evolution-test', ?, 'dev-agent', 'dev', ?, 1, 'applied', ?, '{}', '{"outcome":"completed"}', ?)
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
  assert.equal(hash(detail.candidatePrompt!.content), detail.candidatePrompt!.content_hash);
  assert.match(detail.candidatePrompt!.content, /# 角色目标/);
  assert.equal(detail.candidatePrompt!.base_prompt_revision, detail.currentPrompt.version);
  assert.ok(
    detail.candidatePrompt!.content.indexOf(detail.currentPrompt.content)
    < detail.candidatePrompt!.content.indexOf('EVOLUTION:verify-before-completion'),
  );
  const candidateId = detail.candidatePrompt!.candidate_id;
  const candidateRuntime = await loadAgentRuntime('dev-agent');
  assert.equal(candidateRuntime.evolutionCandidateId, candidateId);
  assert.equal(candidateRuntime.promptVersion, detail.candidatePrompt!.revision);
  assert.equal(candidateRuntime.promptTemplateVersion, detail.currentPrompt.template_version);
  assert.match(candidateRuntime.prompt, /# 角色目标/);
  assert.match(candidateRuntime.prompt, /EVOLUTION:verify-before-completion/);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM agent_prompts WHERE agent_id = 'dev-agent'").get() as { count: number }).count,
    1,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM agent_prompt_candidates WHERE agent_id = 'dev-agent'").get() as { count: number }).count,
    1,
  );

  const canaryDelegation = (taskId: string): DelegationEnvelope => ({
    taskId,
    lane: 'delivery',
    pipeline: 'dev',
    agent: 'dev-agent',
    storyIndex: 1,
    resources: ['code:workspace', 'browser:exclusive'],
    description: '验证 Prompt Canary 串行执行',
    title: 'Prompt Canary',
    taskDescription: null,
    itemType: 'feature',
    priority: 'P2',
    link: '',
    externalId: '',
    externalStatus: '',
    agileStatus: 'in dev',
    currentSubagent: 'dev-agent',
    resumePending: 0,
    specResolvedIndex: 1,
    runState: 'runnable',
    closureStatus: 'open',
    reviewRevision: 0,
    reviewDocumentId: '',
    lastActor: 'system',
    analysisIndex: 1,
    devIndex: 0,
    testIndex: 0,
    totalStories: 1,
    nextStep: '',
    blockedReason: '',
    owner: '',
    evidence: '',
    risk: '',
  });
  const activeCanary = await beginTestExecutionAttempt({
    runId: 'run-canary-serial-1',
    delegation: canaryDelegation(taskA),
    prompt: candidateRuntime.prompt,
    promptVersion: detail.candidatePrompt!.revision,
    promptTemplateVersion: detail.currentPrompt.template_version,
    promptHash: candidateRuntime.promptHash,
    evolutionCandidateId: candidateId,
  });
  assert.equal(activeCanary.attempt.prompt_version, detail.candidatePrompt!.revision);
  assert.equal(activeCanary.attempt.prompt_template_version, detail.currentPrompt.template_version);
  assert.equal(activeCanary.attempt.prompt_hash, candidateRuntime.promptHash);
  await assert.rejects(
    beginTestExecutionAttempt({
      runId: 'run-canary-serial-2',
      delegation: canaryDelegation(taskB),
      prompt: candidateRuntime.prompt,
      promptVersion: detail.candidatePrompt!.revision,
      promptTemplateVersion: detail.currentPrompt.template_version,
      promptHash: candidateRuntime.promptHash,
      evolutionCandidateId: candidateId,
    }),
    );
  await cancelExecution(activeCanary.attempt.execution_id, '只验证串行门禁，不计入 Canary');

  for (const index of [1, 2, 3]) {
    const executionId = `canary-success-${index}`;
    addExecution(executionId, index === 1 ? taskA : taskB, candidateId);
    if (index < 3) await updatePromptCanary('dev-agent', true, executionId);
    else await ensureAgentRuntimeWorkspace();
  }
  detail = await getAgentProfile('dev-agent');
  assert.equal(detail.candidatePrompt, null);
  assert.match(detail.currentPrompt.content, /EVOLUTION:verify-before-completion/);
  assert.equal(hash(detail.currentPrompt.content), detail.currentPrompt.content_hash);
  assert.equal(detail.observations.find((item) => item.fingerprint === 'verify-before-completion')?.status, 'promoted_prompt');
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM agent_prompts WHERE agent_id = 'dev-agent'").get() as { count: number }).count,
    1,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM agent_prompt_candidates WHERE agent_id = 'dev-agent'").get() as { count: number }).count,
    0,
  );
  const promotedPrompt = detail.currentPrompt;
  await ensureAgentRuntimeWorkspace();
  detail = await getAgentProfile('dev-agent');
  assert.equal(detail.currentPrompt.version, promotedPrompt.version);
  assert.equal(detail.currentPrompt.content_hash, promotedPrompt.content_hash);
  const upgradedRuntime = await loadAgentRuntime('dev-agent');
  assert.match(upgradedRuntime.prompt, /# 角色目标/);
  assert.match(upgradedRuntime.prompt, /EVOLUTION:verify-before-completion/);

  await evaluate('evo-rollback-1', taskA, 'avoid-ambiguous-tool-order', 'prompt');
  await evaluate('evo-rollback-2', taskB, 'avoid-ambiguous-tool-order', 'prompt');
  await evaluate('evo-rollback-3', taskB, 'avoid-ambiguous-tool-order', 'prompt');
  detail = await getAgentProfile('dev-agent');
  const currentPromptBeforeRejectedCanary = detail.currentPrompt;
  const rejectedCandidateId = detail.candidatePrompt!.candidate_id;
  for (const index of [1, 2, 3]) addExecution(`late-canary-success-${index}`, taskA, rejectedCandidateId);
  addExecution('late-canary-failure', taskB, rejectedCandidateId);
  db.prepare("UPDATE execution_attempts SET status = 'running' WHERE execution_id = 'late-canary-failure'").run();
  await ensureAgentRuntimeWorkspace();
  detail = await getAgentProfile('dev-agent');
  assert.ok(detail.candidatePrompt);
  assert.equal(detail.currentPrompt.content_hash, currentPromptBeforeRejectedCanary.content_hash);
  db.prepare("UPDATE execution_attempts SET status = 'retryable_failed' WHERE execution_id = 'late-canary-failure'").run();
  await ensureAgentRuntimeWorkspace();
  detail = await getAgentProfile('dev-agent');
  assert.equal(detail.candidatePrompt, null);
  assert.equal(detail.currentPrompt.version, currentPromptBeforeRejectedCanary.version);
  assert.equal(detail.currentPrompt.content_hash, currentPromptBeforeRejectedCanary.content_hash);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM agent_prompt_candidates WHERE agent_id = 'dev-agent'").get() as { count: number }).count,
    0,
  );
  assert.equal(detail.observations.find((item) => item.fingerprint === 'avoid-ambiguous-tool-order')?.status, 'rejected');
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

test('runtime-event-tolerance run-log: retains text log and writes a warning when its structured mirror fails', async () => {
  const { appendLoopRunLog, readLoopRunLogChunk } = await import('./tasks');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const runId = 'runtime-event-tolerance-run-log';

  db.exec('ALTER TABLE runtime_events RENAME TO runtime_events_unavailable');
  try {
    await assert.doesNotReject(appendLoopRunLog(runId, '[运行] text record must survive'));
    const log = await readLoopRunLogChunk(runId);
    assert.match(log.raw, /\[运行\] text record must survive/);
    assert.match(log.raw, /\[警告\] 结构化运行时事件写入失败/);
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
    assert.match((await readLoopRunLogChunk(runId)).raw, /\[警告\] cycle\.started 结构化事件写入失败/);
  } finally {
    db.exec('ALTER TABLE runtime_events_unavailable RENAME TO runtime_events');
  }
  const source = readFileSync(join(process.cwd(), 'scripts/loop/agent-runner.ts'), 'utf8');
  assert.match(source, /recordRuntimeEventWithFallback\([\s\S]*?cycle\.started 结构化事件写入失败[\s\S]*?recordRuntimeEvent/);
  assert.match(source, /eventFromId: number \| null/);
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
