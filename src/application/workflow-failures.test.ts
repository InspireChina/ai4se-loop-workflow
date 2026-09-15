import assert from 'node:assert/strict';
import test from 'node:test';

test('detects the same semantic Test failure only when code and contract are unchanged', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask } = await import('../test/legacy-task-fixtures');
  const { listWorkflowItems, syncLegacyDeliveryWorkItems } = await import('./work-items');
  const { observeWorkflowFailureInDb, workflowFailureSignature } = await import('./workflow-failures');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Stagnant Test failure detection' });
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'in dev', current_subagent = 'test-agent', total_stories = 1,
        analysis_index = 1, spec_resolved_index = 1, dev_index = 1, test_index = 0
    WHERE task_id = ?
  `).run(taskId);
  db.prepare(`
    INSERT INTO stories(task_id, story_index, title, directory)
    VALUES(?, 1, 'Stable failure', 'stable-failure')
  `).run(taskId);
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json, resolved_at)
    VALUES(?, ?, 1, 1, 'resolved', '{"acceptances":["frontend-list"]}', CURRENT_TIMESTAMP)
  `).run(`SPEC-${taskId}-1`, taskId);
  await syncLegacyDeliveryWorkItems(taskId);
  const item = (await listWorkflowItems(taskId)).find((candidate) => candidate.work_key === 'delivery:test:1')!;
  const insertExecution = db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, work_item_id, run_id, task_id, story_index, agent, pipeline,
      delegation_key, attempt, status, input_hash, input_json, base_commit
    ) VALUES(?, ?, ?, ?, 1, 'test-agent', 'test', ?, 1, 'applying', 'input', '{}', ?)
  `);
  const failure = {
    taskId,
    storyIndex: 1,
    failureKind: 'implementation',
    summary: 'Six frontend scenarios failed.',
    tests: [{ command: 'npm test -- admin-tab', passed: false, summary: 'Scenario run 92d6b157-acde-4e3a-9104-10e995f1e1f7 still shows placeholder.' }],
  };
  insertExecution.run('EXEC-stagnant-1', item.item_id, 'RUN-stagnant-1', taskId, 'dispatch:stagnant:1', 'commit-a');
  const first = observeWorkflowFailureInDb(db, { executionId: 'EXEC-stagnant-1', ...failure });
  assert.equal(first?.stagnantCount, 1);
  assert.equal(first?.shouldArbitrate, false);
  assert.deepEqual(observeWorkflowFailureInDb(db, {
    executionId: 'EXEC-stagnant-1', ...failure, summary: 'Different late error', tests: [],
  }), first, 'replaying a result must not overwrite its original observation');
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE execution_id = ?").run('EXEC-stagnant-1');

  insertExecution.run('EXEC-stagnant-2', item.item_id, 'RUN-stagnant-2', taskId, 'dispatch:stagnant:2', 'commit-a');
  const second = observeWorkflowFailureInDb(db, {
    executionId: 'EXEC-stagnant-2',
    ...failure,
    tests: [{ command: 'npm test -- admin-tab', passed: false, summary: 'Scenario run c5a44f0d-b231-4c53-b437-bcc9603bb6f8 still shows placeholder.' }],
  });
  assert.equal(second?.stagnantCount, 2);
  assert.equal(second?.shouldArbitrate, true);
  assert.equal(second?.previousExecutionId, 'EXEC-stagnant-1');
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE execution_id = ?").run('EXEC-stagnant-2');

  insertExecution.run('EXEC-stagnant-3', item.item_id, 'RUN-stagnant-3', taskId, 'dispatch:stagnant:3', 'commit-b');
  const changedCode = observeWorkflowFailureInDb(db, { executionId: 'EXEC-stagnant-3', ...failure });
  assert.equal(changedCode?.stagnantCount, 1);
  assert.equal(changedCode?.shouldArbitrate, false);
  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE execution_id = ?").run('EXEC-stagnant-3');
  const { adoptNativeWorkflowInDb, rewindWorkItemsInDb } = await import('./work-item-transitions');
  const native = adoptNativeWorkflowInDb(db, taskId);
  const dev = native.find((candidate) => candidate.work_key === 'delivery:dev:1')!;
  const { replacements } = rewindWorkItemsInDb(db, { taskId, targetItemId: dev.item_id,
    eventKey: 'same-code-rewind', actor: 'test-agent', authority: 'agent', reason: 'Retry the unchanged implementation' });
  insertExecution.run('EXEC-stagnant-4', replacements[item.item_id], 'RUN-stagnant-4', taskId, 'dispatch:stagnant:4', 'commit-b');
  const unchangedNewRevision = observeWorkflowFailureInDb(db, { executionId: 'EXEC-stagnant-4', ...failure });
  assert.equal(unchangedNewRevision?.stagnantCount, 2, 'a rewind revision must not reset unchanged failure detection');
  assert.equal(unchangedNewRevision?.previousExecutionId, 'EXEC-stagnant-3');
  assert.equal(unchangedNewRevision?.shouldArbitrate, true);

  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE execution_id = ?").run('EXEC-stagnant-4');
  db.prepare(`INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json, resolved_at)
    VALUES(?, ?, 1, 2, 'resolved', ?, CURRENT_TIMESTAMP)`)
    .run(`SPEC-${taskId}-2`, taskId, '{ "acceptances" : [ "frontend-list" ] }');
  insertExecution.run('EXEC-stagnant-5', replacements[item.item_id], 'RUN-stagnant-5', taskId, 'dispatch:stagnant:5', 'commit-b');
  const republishedContract = observeWorkflowFailureInDb(db, { executionId: 'EXEC-stagnant-5', ...failure });
  assert.equal(republishedContract?.stagnantCount, 3, 'new spec identity, revision and formatting do not constitute a contract repair');
  assert.equal(republishedContract?.shouldArbitrate, true);
  assert.equal(republishedContract?.contractFingerprint, unchangedNewRevision?.contractFingerprint);

  db.prepare("UPDATE execution_attempts SET status = 'applied' WHERE execution_id = ?").run('EXEC-stagnant-5');
  db.prepare(`INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json, resolved_at)
    VALUES(?, ?, 1, 3, 'resolved', ?, CURRENT_TIMESTAMP)`)
    .run(`SPEC-${taskId}-3`, taskId, '{"acceptances":["backend-query"]}');
  insertExecution.run('EXEC-stagnant-6', replacements[item.item_id], 'RUN-stagnant-6', taskId, 'dispatch:stagnant:6', 'commit-b');
  const repairedContract = observeWorkflowFailureInDb(db, { executionId: 'EXEC-stagnant-6', ...failure });
  assert.equal(repairedContract?.stagnantCount, 1, 'a substantive contract change resets the stagnation window');
  assert.equal(repairedContract?.shouldArbitrate, false);

  assert.equal(
    workflowFailureSignature(failure),
    workflowFailureSignature({
      ...failure,
      tests: [{ command: 'npm   test -- admin-tab', passed: false, summary: 'Scenario run 92d6b157-acde-4e3a-9104-10e995f1e1f7 still shows placeholder.' }],
    }),
  );
});

test('opens arbitration instead of rewinding a second unchanged Test failure', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { parseAgentResult } = await import('../domain/agent-result');
  const { applyAgentResult } = await import('./agent-results');
  const { createTask, getTask } = await import('../test/legacy-task-fixtures');
  const { listWorkflowItems, syncLegacyDeliveryWorkItems } = await import('./work-items');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Automatic stagnant failure arbitration' });
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'in dev', current_subagent = 'test-agent', total_stories = 1,
        analysis_index = 1, spec_resolved_index = 1, dev_index = 1, test_index = 0
    WHERE task_id = ?
  `).run(taskId);
  db.prepare("INSERT INTO stories(task_id, story_index, title, directory) VALUES(?, 1, 'Admin tab', 'admin-tab')").run(taskId);
  db.prepare(`
    INSERT INTO story_specs(spec_id, task_id, story_index, revision, status, spec_json, resolved_at)
    VALUES(?, ?, 1, 1, 'resolved', '{"acceptances":["seven-columns","filter"]}', CURRENT_TIMESTAMP)
  `).run(`SPEC-${taskId}`, taskId);
  db.prepare("UPDATE task_lanes SET status = 'completed' WHERE task_id = ? AND lane = 'analysis'").run(taskId);
  db.prepare("UPDATE task_lanes SET status = 'running', current_agent = 'test-agent', current_story_index = 1 WHERE task_id = ? AND lane = 'delivery'").run(taskId);
  await syncLegacyDeliveryWorkItems(taskId);
  const testItem = (await listWorkflowItems(taskId)).find((item) => item.work_key === 'delivery:test:1')!;
  const delegation = {
    taskId,
    lane: 'delivery' as const,
    pipeline: 'test',
    agent: 'test-agent',
    storyIndex: 1,
    resources: ['code:workspace' as const, 'browser:exclusive' as const],
    description: 'Verify Admin tab',
    title: 'Automatic stagnant failure arbitration',
    taskDescription: '', itemType: 'feature', priority: '', link: '', externalId: '', externalStatus: '',
    agileStatus: 'in dev', currentSubagent: 'test-agent', resumePending: 0, specResolvedIndex: 1,
    runState: 'runnable', closureStatus: 'none', reviewRevision: 0, reviewDocumentId: '', lastActor: '',
    analysisIndex: 1, devIndex: 1, testIndex: 0, totalStories: 1, nextStep: '', blockedReason: '',
    owner: '', evidence: '', risk: '',
  };
  const result = parseAgentResult(JSON.stringify({
    outcome: 'failed',
    verdict: 'failed',
    failureKind: 'implementation',
    rewindTo: 'dev',
    rewindDeliveryUnit: 1,
    summary: 'Admin tab remains a placeholder.',
    tests: [{ command: 'npm test -- admin-tab', passed: false, summary: 'Six frontend scenarios still fail.' }],
  }));
  const insertExecution = db.prepare(`
    INSERT INTO execution_attempts(
      execution_id, work_item_id, run_id, task_id, story_index, agent, pipeline, lane,
      delegation_key, attempt, status, input_hash, input_json, base_commit
    ) VALUES(?, ?, ?, ?, 1, 'test-agent', 'test', 'delivery', ?, 1, 'applying', 'input', '{}', 'same-head')
  `);
  insertExecution.run('EXEC-arbitration-failure-1', testItem.item_id, 'RUN-arbitration-failure-1', taskId, 'dispatch:arbitration:1');
  assert.equal(await applyAgentResult('RUN-arbitration-failure-1', delegation, result, { executionId: 'EXEC-arbitration-failure-1' }), 'rewound');
  assert.equal((await getTask(taskId))?.task.dev_index, 0);

  db.prepare("UPDATE tasks SET agile_status = 'in dev', current_subagent = 'test-agent', dev_index = 1 WHERE task_id = ?").run(taskId);
  db.prepare("UPDATE task_lanes SET status = 'running', current_agent = 'test-agent', current_story_index = 1 WHERE task_id = ? AND lane = 'delivery'").run(taskId);
  await syncLegacyDeliveryWorkItems(taskId);
  const activeTest = (await listWorkflowItems(taskId)).find((item) => item.work_key === 'delivery:test:1' && item.status !== 'superseded');
  assert.equal(activeTest?.item_id, testItem.item_id);
  insertExecution.run('EXEC-arbitration-failure-2', testItem.item_id, 'RUN-arbitration-failure-2', taskId, 'dispatch:arbitration:2');
  assert.equal(await applyAgentResult('RUN-arbitration-failure-2', delegation, result, { executionId: 'EXEC-arbitration-failure-2' }), 'blocked');

  const detail = await getTask(taskId);
  assert.equal(detail?.task.dev_index, 1);
  assert.equal(detail?.task.test_index, 0);
  assert.equal(detail?.lanes.find((lane) => lane.lane === 'delivery')?.status, 'waiting_for_runtime_input');
  const arbitration = db.prepare(`
    SELECT status, authority, item_id, attempt_count, max_system_attempts, context_json
    FROM interventions WHERE task_id = ? AND authority = 'arbitration'
  `).get(taskId) as {
    status: string;
    authority: string;
    item_id: string;
    attempt_count: number;
    max_system_attempts: number;
    context_json: string;
  };
  assert.equal(arbitration.status, 'pending');
  assert.equal(arbitration.item_id, testItem.item_id);
  assert.equal(arbitration.max_system_attempts, 3);
  assert.match(arbitration.context_json, /EXEC-arbitration-failure-1/);
});
