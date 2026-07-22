import assert from 'node:assert/strict';
import test from 'node:test';

test('lets workflow progress without a Recovery Claim and closes the item on later Test success', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const {
    createOrReopenRecoveryItem,
    listRecoveryItemsForStage,
    resolveActiveRecoveryItems,
  } = await import('./recovery-items');
  const { getTask } = await import('./tasks');
  const { parseAgentResult } = await import('../domain/agent-result');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-recovery-claim';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Recovery claim', 'feature', 'ready for dev', 'dev-agent', 1, 0, 0, 1, 1, '')
  `).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Recover behavior', 'story-001')").run(taskId);
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json, resolved_at)
    VALUES('SPEC-recovery-claim', ?, 1, 1, 'resolved', '{}', CURRENT_TIMESTAMP)
  `).run(taskId);

  const recovery = await createOrReopenRecoveryItem({
    taskId,
    storyIndex: 1,
    kind: 'test_failure',
    sourceAgent: 'test-agent',
    targetStage: 'dev',
    summary: 'Retry behavior is not proven.',
    details: { expected: 'A later retry succeeds.', actual: 'No black-box evidence exists.' },
    sourceExecutionId: 'EXEC-test-failed-1',
  });

  const delegation = {
    taskId,
    lane: 'delivery' as const,
    pipeline: 'dev',
    agent: 'dev-agent',
    storyIndex: 1,
    resource: 'none' as const,
    description: 'Recover failed verification',
    title: 'Recovery claim',
    taskDescription: '',
    itemType: 'feature',
    priority: '',
    link: '',
    externalId: '',
    externalStatus: '',
    agileStatus: 'ready for dev',
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
  await applyAgentResult('run-recovery-without-claim', delegation, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'Inspected and corrected the retry behavior.',
    changedFiles: [],
  })), { executionId: 'EXEC-dev-recovery-1' });
  assert.equal((await getTask(taskId))?.task.dev_index, 1);
  assert.equal((await listRecoveryItemsForStage({ taskId, storyIndex: 1, stage: 'test' }))[0]?.status, 'pending');

  const resolved = await resolveActiveRecoveryItems({
    taskId,
    storyIndex: 1,
    kind: 'test_failure',
    verifier: 'test-agent',
    executionId: 'EXEC-test-passed-2',
    summary: 'Independent retry verification passed.',
  });
  assert.deepEqual(resolved, [recovery.recovery_id]);
  assert.deepEqual(await listRecoveryItemsForStage({ taskId, storyIndex: 1, stage: 'test' }), []);
  const stored = db.prepare('SELECT status, resolution_json FROM recovery_items WHERE recovery_id = ?').get(recovery.recovery_id) as { status: string; resolution_json: string };
  assert.equal(stored.status, 'resolved');
  assert.match(stored.resolution_json, /Independent retry verification passed/);
});

test('persists Test rewind evidence, reopens one active item, and supersedes it on task-level replanning', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { createOrReopenRecoveryItem, listRecoveryItemsForStage, recordRecoveryClaims, recoveryItemForPrompt } = await import('./recovery-items');
  const { getTask, rewindTask } = await import('./tasks');
  const { parseAgentResult } = await import('../domain/agent-result');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-recovery-rewind';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Recovery rewind', 'feature', 'in dev', 'test-agent', 1, 1, 0, 1, 1, '')
  `).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Retry behavior', 'story-001')").run(taskId);
  const delegation = {
    taskId,
    lane: 'delivery' as const,
    pipeline: 'test',
    agent: 'test-agent',
    storyIndex: 1,
    resource: 'browser' as const,
    description: 'Verify retry behavior',
    title: 'Recovery rewind',
    taskDescription: '',
    itemType: 'feature',
    priority: '',
    link: '',
    externalId: '',
    externalStatus: '',
    agileStatus: 'in dev',
    currentSubagent: 'test-agent',
    resumePending: 0,
    specResolvedIndex: 1,
    runState: 'runnable',
    closureStatus: 'none',
    reviewRevision: 0,
    reviewDocumentId: '',
    lastActor: '',
    analysisIndex: 1,
    devIndex: 1,
    testIndex: 0,
    totalStories: 1,
    nextStep: '',
    blockedReason: '',
    owner: '',
    evidence: '',
    risk: '',
  };
  await applyAgentResult('run-test-rewind', delegation, parseAgentResult(JSON.stringify({
    outcome: 'failed',
    summary: 'The retry still uses the default configuration.',
    verdict: 'failed',
    rewindTo: 'dev',
    rewindDeliveryUnit: 1,
    tests: [{ command: 'npm test -- retry-e2e', passed: false, summary: 'Expected original config, received default.' }],
  })), { executionId: 'EXEC-test-rewind-1' });
  assert.equal((await getTask(taskId))?.task.dev_index, 0);
  let active = await listRecoveryItemsForStage({ taskId, storyIndex: 1, stage: 'dev' });
  assert.equal(active.length, 1);
  assert.equal(active[0]?.kind, 'test_failure');
  assert.match(active[0]?.details_json || '', /retry-e2e/);
  assert.equal((recoveryItemForPrompt(active[0]!).details.tests as unknown[]).length, 1);
  assert.equal((await getTask(taskId))?.recoveryItems[0]?.recovery_id, active[0]?.recovery_id);

  await recordRecoveryClaims({
    taskId,
    storyIndex: 1,
    agent: 'dev-agent',
    executionId: 'EXEC-dev-recovery-2',
    claims: [{ recoveryId: active[0]!.recovery_id, summary: 'Attempted the requested fix.', evidence: ['commit:def456'] }],
  });
  await createOrReopenRecoveryItem({
    taskId,
    storyIndex: 1,
    kind: 'test_failure',
    sourceAgent: 'test-agent',
    targetStage: 'dev',
    summary: 'The independent retry still fails.',
    details: { expected: 'Original configuration', actual: 'Default configuration' },
    sourceExecutionId: 'EXEC-test-rewind-2',
  });
  active = await listRecoveryItemsForStage({ taskId, storyIndex: 1, stage: 'dev' });
  assert.equal(active.length, 1);
  assert.equal(active[0]?.status, 'reopened');
  assert.equal(active[0]?.failure_count, 2);

  await rewindTask({ taskId, actor: 'system', to: 'plan', reason: 'Requirement context changed.' });
  assert.equal((await getTask(taskId))?.task.total_stories, 0);
  const stored = db.prepare('SELECT status FROM recovery_items WHERE recovery_id = ?').get(active[0]!.recovery_id) as { status: string };
  assert.equal(stored.status, 'superseded');
});

test('does not default an unclassified Test failure to Dev', async () => {
  const { applyAgentResult } = await import('./agent-results');
  const { getTask } = await import('./tasks');
  const { parseAgentResult } = await import('../domain/agent-result');
  const { databaseConnection } = await import('../infrastructure/database');
  const db = await databaseConnection();
  const taskId = 'TASK-test-unclassified-failure';
  db.prepare(`
    INSERT INTO tasks(
      task_id, title, item_type, agile_status, current_subagent,
      analysis_index, dev_index, test_index, total_stories, spec_resolved_index, work_dir
    ) VALUES(?, 'Unclassified test failure', 'feature', 'in dev', 'test-agent', 1, 1, 0, 1, 1, '')
  `).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Verify behavior', 'story-001')").run(taskId);
  await applyAgentResult('run-test-unclassified', {
    taskId,
    lane: 'delivery',
    pipeline: 'test',
    agent: 'test-agent',
    storyIndex: 1,
    resource: 'browser',
    description: 'Verify behavior',
    title: 'Unclassified test failure',
    taskDescription: '',
    itemType: 'feature',
    priority: '', link: '', externalId: '', externalStatus: '',
    agileStatus: 'in dev', currentSubagent: 'test-agent', resumePending: 0,
    specResolvedIndex: 1, runState: 'runnable', closureStatus: 'none', reviewRevision: 0,
    reviewDocumentId: '', lastActor: '', analysisIndex: 1, devIndex: 1, testIndex: 0,
    totalStories: 1, nextStep: '', blockedReason: '', owner: '', evidence: '', risk: '',
  }, parseAgentResult(JSON.stringify({
    outcome: 'completed',
    summary: 'The test command failed before producing a usable assertion result.',
    verdict: 'failed',
    tests: [{ command: 'npm test', passed: false, summary: 'Runner stopped without a classified cause.' }],
  })));
  const detail = await getTask(taskId);
  assert.equal(detail?.task.dev_index, 1);
  assert.equal(detail?.task.test_index, 0);
  assert.equal(detail?.lanes.find((lane) => lane.lane === 'delivery')?.status, 'system_blocked');
  assert.deepEqual(detail?.recoveryItems, []);
});
