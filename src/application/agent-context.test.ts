import assert from 'node:assert/strict';
import test from 'node:test';
import type { DelegationEnvelope } from './tasks';

function delegation(taskId: string, overrides: Partial<DelegationEnvelope> = {}): DelegationEnvelope {
  return {
    taskId,
    lane: 'delivery',
    pipeline: 'resume',
    agent: 'dev-agent',
    storyIndex: 1,
    resource: 'none',
    description: '继续实现当前交付单元',
    title: 'Context engineering',
    taskDescription: 'Implement one delivery unit.',
    itemType: 'feature',
    priority: '',
    link: '',
    externalId: '',
    externalStatus: '',
    agileStatus: 'in dev',
    currentSubagent: 'dev-agent',
    resumePending: 1,
    specResolvedIndex: 1,
    runState: 'runnable',
    closureStatus: 'open',
    reviewRevision: 0,
    reviewDocumentId: '',
    lastActor: 'human',
    analysisIndex: 1,
    devIndex: 0,
    testIndex: 0,
    totalStories: 2,
    nextStep: 'Resume Dev',
    blockedReason: '',
    owner: '',
    evidence: '',
    risk: '',
    ...overrides,
  };
}

test('builds a compact execution snapshot while preserving full context for just-in-time reads', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const {
    addQuestion,
    addRuntimeInputRequest,
    answerQuestion,
    answerRuntimeInput,
    createTask,
    getTaskContext,
    upsertDocument,
  } = await import('./tasks');
  const {
    buildAgentContextSnapshot,
    getExecutionAgentContextSnapshot,
    renderAgentContextList,
    renderAgentContextResource,
    renderAgentContextSearch,
  } = await import('./agent-context');
  const { beginExecutionAttempt } = await import('./executions');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Context engineering', description: 'Implement one delivery unit.' });
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Current unit', 'unit-001'), (?, 2, 'Future unit', 'unit-002')").run(taskId, taskId);
  db.prepare('UPDATE tasks SET total_stories = 2, analysis_index = 1, spec_resolved_index = 1 WHERE task_id = ?').run(taskId);
  const currentContent = `${'Current analysis details. '.repeat(20)}FULL-CONTEXT-TAIL`;
  const currentDocumentId = await upsertDocument({
    taskId, storyIndex: 1, kind: 'analysis', title: 'Current analysis', content: currentContent, actor: 'analyst-agent',
  });
  await upsertDocument({
    taskId, storyIndex: 2, kind: 'analysis', title: 'Future analysis', content: 'FUTURE-UNIT-ONLY', actor: 'analyst-agent',
  });
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json)
    VALUES('SPEC-context-unit-1', ?, 1, 1, 'resolved', ?)
  `).run(taskId, JSON.stringify({ goal: 'Implement the current unit', acceptanceCriteria: [{ id: 'AC-1', description: 'Works' }] }));
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json)
    VALUES('SPEC-context-unit-2', ?, 2, 1, 'resolved', ?)
  `).run(taskId, JSON.stringify({ goal: 'Implement the future unit', acceptanceCriteria: [{ id: 'AC-2', description: 'Works later' }] }));
  const questionId = await addQuestion({
    taskId, storyIndex: 1, actor: 'analyst-agent', kind: 'analysis', title: 'Retry policy',
    question: 'Which configuration should retry use?', decisionKey: 'retry-policy',
  });
  await answerQuestion({ taskId, questionId, answer: 'Reuse the original configuration.' });
  const requestId = await addRuntimeInputRequest({
    taskId, storyIndex: 1, sourceAgent: 'dev-agent', title: 'Local fixture',
    question: 'Which local fixture should be used?', recommendation: 'Use fixture A.',
  });
  await answerRuntimeInput({ taskId, requestId, answer: 'Use fixture B.' });

  const full = await getTaskContext(taskId);
  const snapshot = buildAgentContextSnapshot({
    delegation: delegation(taskId), full, activeFeedback: [], activeRecovery: [], repositoryBaseCommit: 'abc123',
  });
  const startup = JSON.stringify({
    authoritativeFacts: snapshot.authoritativeFacts,
    activeObligations: snapshot.activeObligations,
    startupIndex: snapshot.startupIndex,
  });
  assert.equal(startup.includes('FULL-CONTEXT-TAIL'), false);
  assert.equal(startup.includes('FUTURE-UNIT-ONLY'), false);
  assert.match(startup, /Reuse the original configuration/);
  assert.deepEqual(snapshot.authoritativeFacts.answeredDecisionKeys, ['retry-policy']);
  assert.match(startup, /Use fixture B/);
  assert.equal(snapshot.resourceCount > snapshot.startupIndex.length, true);
  assert.equal(snapshot.requiredContextRefs.includes(`DOC:${currentDocumentId}`), true);
  assert.match(renderAgentContextResource(snapshot, `DOC:${currentDocumentId}`), /FULL-CONTEXT-TAIL/);
  assert.match(renderAgentContextSearch(snapshot, 'FUTURE-UNIT-ONLY'), /Future analysis/);
  assert.doesNotMatch(renderAgentContextList(snapshot, { scope: 'current' }), /Future analysis/);

  const reviewSnapshot = buildAgentContextSnapshot({
    delegation: delegation(taskId, { agent: 'review-agent', lane: 'control', pipeline: 'review', storyIndex: null }),
    full, activeFeedback: [], activeRecovery: [], repositoryBaseCommit: 'abc123',
  });
  assert.equal(reviewSnapshot.requiredContextRefs.some((ref) => ref.startsWith('SPEC:SPEC-context-unit-1')), true);
  assert.equal(reviewSnapshot.requiredContextRefs.some((ref) => ref.startsWith('SPEC:SPEC-context-unit-2')), true);

  const started = await beginExecutionAttempt({
    runId: 'RUN-agent-context', delegation: delegation(taskId), prompt: 'compact prompt', contextSnapshot: snapshot,
  });
  const stored = await getExecutionAgentContextSnapshot(started.attempt.execution_id);
  assert.equal(stored.snapshotId, snapshot.snapshotId);
  assert.match(renderAgentContextResource(stored, `DOC:${currentDocumentId}`), /FULL-CONTEXT-TAIL/);
});

test('prioritizes the latest forward feedback group while keeping old documents as historical execution context', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const {
    addDocumentComment,
    createTask,
    getTaskContext,
    upsertDocument,
  } = await import('./tasks');
  const { buildAgentContextSnapshot } = await import('./agent-context');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Forward feedback context priority' });
  db.prepare(`
    INSERT INTO stories(task_id, story_index, title, directory, origin_type)
    VALUES(?, 1, 'Original delivery', 'story-001', 'original'),
          (?, 2, 'Keyboard-accessible empty state', 'story-002', 'feedback_behavior')
  `).run(taskId, taskId);
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'in feedback', total_stories = 2,
        analysis_index = 1, dev_index = 1, test_index = 1
    WHERE task_id = ?
  `).run(taskId);
  const documentId = await upsertDocument({
    taskId,
    storyIndex: 1,
    kind: 'review_v1',
    title: 'Historical closure report',
    content: 'OLD-HISTORICAL-CONTENT: the first delivery only supported pointer input.',
    actor: 'review-agent',
  });
  const commentId = await addDocumentComment({
    taskId,
    documentId,
    anchorType: 'file',
    content: 'The empty-state action must also support keyboard input.',
    intent: 'change_request',
  });
  const firstBatchId = 'BATCH-context-priority-1';
  const secondBatchId = 'BATCH-context-priority-2';
  const firstGroupId = 'GROUP-context-priority-1';
  const secondGroupId = 'GROUP-context-priority-2';
  db.prepare(`
    INSERT INTO feedback_batches(batch_id, task_id, batch_number, status, summary)
    VALUES(?, ?, 1, 'completed', 'First attempt'),
          (?, ?, 2, 'executing', 'Current correction')
  `).run(firstBatchId, taskId, secondBatchId, taskId);
  db.prepare(`
    INSERT INTO feedback_groups(
      group_id, batch_id, group_order, group_key, work_type, status, title, reason,
      acceptance_json, affected_story_indexes_json
    ) VALUES
      (?, ?, 1, 'empty-state-v1', 'behavior_change', 'reopened',
       'First pointer-only attempt', 'This is no longer the active correction',
       '["Pointer input works"]', '[1]'),
      (?, ?, 1, 'empty-state-v2', 'behavior_change', 'executing',
       'Add keyboard input', 'The latest user feedback requires keyboard support',
       '["Keyboard input works"]', '[1]')
  `).run(firstGroupId, firstBatchId, secondGroupId, secondBatchId);
  db.prepare(`
    INSERT INTO feedback_group_comments(group_id, comment_id)
    VALUES(?, ?), (?, ?)
  `).run(firstGroupId, commentId, secondGroupId, commentId);
  db.prepare(`
    INSERT INTO feedback_group_delivery_units(group_id, task_id, story_index)
    VALUES(?, ?, 2), (?, ?, 2)
  `).run(firstGroupId, taskId, secondGroupId, taskId);
  db.prepare(`
    UPDATE document_comments
    SET feedback_status = 'in_progress', feedback_batch_id = ?,
        triage_reason = 'The latest user feedback requires keyboard support'
    WHERE comment_id = ?
  `).run(secondBatchId, commentId);

  const full = await getTaskContext(taskId);
  const snapshot = buildAgentContextSnapshot({
    delegation: delegation(taskId, {
      agent: 'analyst-agent',
      lane: 'analysis',
      pipeline: 'analysis',
      storyIndex: 2,
      description: 'Analyze the appended keyboard correction only.',
      agileStatus: 'in feedback',
      analysisIndex: 1,
      devIndex: 1,
      testIndex: 1,
      totalStories: 2,
    }),
    full,
    activeFeedback: [],
    activeRecovery: [],
    repositoryBaseCommit: 'feedback-base',
  });

  assert.equal(snapshot.authoritativeFacts.currentDeliveryUnit?.index, 2);
  assert.doesNotMatch(JSON.stringify(snapshot.authoritativeFacts), /OLD-HISTORICAL-CONTENT/);
  assert.equal(snapshot.activeObligations.feedback.length, 1);
  assert.deepEqual(snapshot.activeObligations.feedback[0], {
    commentId,
    documentId,
    documentRevision: 1,
    content: 'The empty-state action must also support keyboard input.',
    quotedText: null,
    intent: 'change_request',
    feedbackStatus: 'in_progress',
    batchId: secondBatchId,
    groupId: secondGroupId,
    groupKey: 'empty-state-v2',
    workType: 'behavior_change',
    groupStatus: 'executing',
    affectedDeliveryUnits: [1],
    appendedDeliveryUnits: [2],
    reason: 'The latest user feedback requires keyboard support',
    acceptance: ['Keyboard input works'],
    response: null,
    verification: null,
  });
  const feedbackResource = snapshot.resources.find((resource) => resource.ref === `FEEDBACK:${commentId}`);
  assert.equal(feedbackResource?.authority, 'active_obligation');
  const oldDocument = snapshot.resources.find((resource) => resource.ref === `DOC:${documentId}`);
  assert.equal(oldDocument?.authority, 'execution_evidence');
  assert.match(JSON.stringify(oldDocument?.content), /OLD-HISTORICAL-CONTENT/);
});
