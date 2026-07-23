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
