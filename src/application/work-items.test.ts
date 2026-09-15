import assert from 'node:assert/strict';
import test from 'node:test';

test('preserves native dependencies and blocks dispatch while an upstream item or intervention is unfinished', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask } = await import('../test/legacy-task-fixtures');
  const { syncLegacyDeliveryWorkItemsInDb, readyWorkflowItemsForTaskInDb } = await import('./work-items');
  const { openInterventionInDb } = await import('./interventions');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Native dependency protection' });
  const insert = db.prepare(`
    INSERT INTO workflow_items(item_id, task_id, work_key, kind, title, agent, pipeline, lane, status, origin)
    VALUES(?, ?, ?, 'stage', ?, 'backlog-agent', 'backlog', 'control', ?, 'native')
  `);
  insert.run(`UP-${taskId}`, taskId, 'native:upstream', 'Upstream', 'pending');
  db.prepare("UPDATE workflow_items SET status = 'superseded' WHERE task_id = ? AND work_key = 'delivery:context'").run(taskId);
  db.prepare("UPDATE workflow_items SET work_key = 'old:context' WHERE task_id = ? AND work_key = 'delivery:context'").run(taskId);
  insert.run(`WORK-${taskId}`, taskId, 'delivery:context', 'Context', 'ready');
  db.prepare('INSERT INTO workflow_dependencies(item_id, depends_on_item_id) VALUES(?, ?)')
    .run(`WORK-${taskId}`, `UP-${taskId}`);
  syncLegacyDeliveryWorkItemsInDb(db, taskId);
  assert.equal(readyWorkflowItemsForTaskInDb(db, taskId).some((item) => item.item_id === `WORK-${taskId}`), false);
  assert.ok(db.prepare('SELECT 1 FROM workflow_dependencies WHERE item_id = ? AND depends_on_item_id = ?')
    .get(`WORK-${taskId}`, `UP-${taskId}`));
  db.prepare("UPDATE workflow_items SET status = 'completed' WHERE item_id = ?").run(`UP-${taskId}`);
  assert.equal(readyWorkflowItemsForTaskInDb(db, taskId).some((item) => item.item_id === `WORK-${taskId}`), true);
  openInterventionInDb(db, {
    taskId, itemId: `WORK-${taskId}`, dedupeKey: 'native:block', summary: 'Needs clarification',
    requestedBy: 'backlog-agent', resolverStrategy: 'human_only',
  });
  syncLegacyDeliveryWorkItemsInDb(db, taskId);
  assert.equal(readyWorkflowItemsForTaskInDb(db, taskId).some((item) => item.item_id === `WORK-${taskId}`), false);
});

test('attaches migrated human interventions when the legacy graph is first materialized', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask, addQuestion } = await import('../test/legacy-task-fixtures');
  const { syncLegacyDeliveryWorkItemsInDb } = await import('./work-items');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Lazy historical human input attachment' });
  await addQuestion({ taskId, title: 'Confirm target', question: 'What is the target?', actor: 'backlog-agent' });
  db.prepare('UPDATE interventions SET item_id = NULL WHERE task_id = ?').run(taskId);
  syncLegacyDeliveryWorkItemsInDb(db, taskId);
  const item = db.prepare(`
    SELECT item.work_key, item.status FROM interventions intervention
    JOIN workflow_items item ON item.item_id = intervention.item_id
    WHERE intervention.task_id = ?
  `).get(taskId) as { work_key: string; status: string };
  assert.equal(item.work_key, 'delivery:context');
  assert.equal(item.status, 'waiting');
});

test('maps retryable legacy executions to stable Work Item keys without capturing feedback work', async () => {
  const { legacyWorkKeyForExecution } = await import('../domain/workflow-item');
  assert.equal(legacyWorkKeyForExecution({ agent: 'story-splitter-agent', pipeline: 'split', storyIndex: null }), 'delivery:plan');
  assert.equal(legacyWorkKeyForExecution({ agent: 'analyst-agent', pipeline: 'resume', storyIndex: 2 }), 'delivery:analysis:2');
  assert.equal(legacyWorkKeyForExecution({ agent: 'dev-agent', pipeline: 'dev', storyIndex: 2 }), 'delivery:dev:2');
  assert.equal(legacyWorkKeyForExecution({ agent: 'test-agent', pipeline: 'test', storyIndex: 2 }), 'delivery:test:2');
  assert.equal(legacyWorkKeyForExecution({ agent: 'review-agent', pipeline: 'review', storyIndex: null }), 'delivery:review');
  assert.equal(legacyWorkKeyForExecution({ agent: 'review-agent', pipeline: 'feedback-report', storyIndex: null }), null);
  assert.equal(legacyWorkKeyForExecution({ agent: 'backlog-agent', pipeline: 'backlog', storyIndex: null }), 'delivery:context');
  assert.equal(legacyWorkKeyForExecution({ agent: 'idea-context-agent', pipeline: 'ba-intent', storyIndex: null }), 'ba:intent');
});

test('keeps legacy analysis parallelism while serializing each Dev and Test unit in the work graph', async () => {
  const { projectLegacyDeliveryWorkflow } = await import('../domain/workflow-item');
  const cases = [
    { analysis: 0, dev: 0, test: 0, ready: ['delivery:analysis:1'] },
    { analysis: 1, dev: 0, test: 0, ready: ['delivery:analysis:2', 'delivery:dev:1'] },
    { analysis: 2, dev: 1, test: 0, ready: ['delivery:test:1'] },
    { analysis: 2, dev: 1, test: 1, ready: ['delivery:dev:2'] },
    { analysis: 2, dev: 2, test: 1, ready: ['delivery:test:2'] },
  ];
  for (const item of cases) {
    const projection = projectLegacyDeliveryWorkflow({
      taskId: 'REQ-matrix',
      taskStatus: item.dev || item.test ? 'in dev' : 'ready for dev',
      currentAgent: null,
      totalStories: 2,
      analysisIndex: item.analysis,
      devIndex: item.dev,
      testIndex: item.test,
      analysisLane: {
        status: item.analysis < 2 ? 'runnable' : 'completed',
        currentAgent: null,
        currentStoryIndex: null,
      },
      deliveryLane: {
        status: item.test < item.dev || item.dev < item.analysis ? 'runnable' : 'pending',
        currentAgent: null,
        currentStoryIndex: null,
      },
    });
    assert.deepEqual(
      projection.items.filter((work) => work.status === 'ready').map((work) => work.workKey).sort(),
      item.ready.sort(),
      `legacy cursor ${item.analysis}/${item.dev}/${item.test}`,
    );
  }
});

test('projects Direct, Business Analysis, End to End, and Bug control stages as Work Items', async () => {
  const { projectLegacyDeliveryWorkflow } = await import('../domain/workflow-item');
  const base = {
    taskId: 'REQ-control-graph',
    taskStatus: 'backlog',
    runState: 'runnable',
    currentAgent: null,
    totalStories: 0,
    analysisIndex: 0,
    devIndex: 0,
    testIndex: 0,
  };
  const direct = projectLegacyDeliveryWorkflow({ ...base, itemType: 'direct' });
  assert.deepEqual(direct.items.map((item) => [item.workKey, item.status]), [['direct:execute', 'ready']]);

  const business = projectLegacyDeliveryWorkflow({
    ...base,
    itemType: 'business-analysis',
    currentAgent: 'requirement-spec-agent',
  });
  assert.deepEqual(business.items.map((item) => [item.workKey, item.status]), [
    ['ba:intent', 'completed'],
    ['ba:design', 'completed'],
    ['ba:spec', 'ready'],
    ['ba:review', 'pending'],
    ['ba:closure', 'pending'],
  ]);

  const endToEnd = projectLegacyDeliveryWorkflow({
    ...base,
    itemType: 'end-to-end',
    currentAgent: 'backlog-agent',
  });
  assert.equal(endToEnd.items.find((item) => item.workKey === 'ba:review')?.status, 'completed');
  assert.equal(endToEnd.items.find((item) => item.workKey === 'delivery:context')?.status, 'ready');
  assert.ok(endToEnd.dependencies.some((dependency) =>
    dependency.workKey === 'delivery:context' && dependency.dependsOnWorkKey === 'ba:review'));

  const bug = projectLegacyDeliveryWorkflow({
    ...base,
    itemType: 'bug',
    taskStatus: 'in repro',
    currentAgent: 'repro-agent',
  });
  assert.equal(bug.items.find((item) => item.workKey === 'delivery:context')?.status, 'completed');
  assert.equal(bug.items.find((item) => item.workKey === 'delivery:repro')?.status, 'ready');
  assert.equal(bug.items.find((item) => item.workKey === 'delivery:plan')?.status, 'pending');
  assert.ok(bug.dependencies.some((dependency) =>
    dependency.workKey === 'delivery:plan' && dependency.dependsOnWorkKey === 'delivery:repro'));
});

test('projects the legacy delivery cursor and lane state into an equivalent work graph', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask } = await import('../test/legacy-task-fixtures');
  const { syncLegacyDeliveryWorkItems } = await import('./work-items');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Legacy delivery work graph projection' });
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'in dev', current_subagent = 'test-agent',
        total_stories = 2, analysis_index = 2, spec_resolved_index = 2,
        dev_index = 1, test_index = 0
    WHERE task_id = ?
  `).run(taskId);
  db.prepare(`
    INSERT INTO stories(task_id, story_index, title, directory)
    VALUES(?, 1, 'First unit', 'story-1'), (?, 2, 'Second unit', 'story-2')
  `).run(taskId, taskId);
  db.prepare(`
    INSERT INTO task_lanes(task_id, lane, status, current_agent, current_story_index)
    VALUES(?, 'analysis', 'completed', NULL, NULL)
    ON CONFLICT(task_id, lane) DO UPDATE SET
      status = excluded.status, current_agent = NULL, current_story_index = NULL
  `).run(taskId);
  db.prepare(`
    INSERT INTO task_lanes(task_id, lane, status, current_agent, current_story_index)
    VALUES(?, 'delivery', 'running', 'test-agent', 1)
    ON CONFLICT(task_id, lane) DO UPDATE SET
      status = excluded.status,
      current_agent = excluded.current_agent,
      current_story_index = excluded.current_story_index
  `).run(taskId);

  const projection = await syncLegacyDeliveryWorkItems(taskId);
  const status = new Map(projection.items.map((item) => [item.work_key, item.status]));
  assert.equal(status.get('delivery:plan'), 'completed');
  assert.equal(status.get('delivery:analysis:1'), 'completed');
  assert.equal(status.get('delivery:analysis:2'), 'completed');
  assert.equal(status.get('delivery:dev:1'), 'completed');
  assert.equal(status.get('delivery:test:1'), 'running');
  assert.equal(status.get('delivery:dev:2'), 'pending');
  assert.equal(status.get('delivery:test:2'), 'pending');
  assert.equal(status.get('delivery:review'), 'pending');
  assert.equal(status.get('delivery:closure'), 'pending');
  assert.ok(projection.dependencies.some((dependency) =>
    dependency.work_key === 'delivery:dev:2'
    && dependency.depends_on_work_key === 'delivery:test:1'
    && dependency.dependency_kind === 'ordering'));
});

test('refreshes the shadow graph idempotently and selects the same next delivery work as legacy dispatch', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask } = await import('../test/legacy-task-fixtures');
  const { syncLegacyDeliveryWorkItems } = await import('./work-items');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Idempotent work graph refresh' });
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'in dev', current_subagent = 'test-agent',
        total_stories = 2, analysis_index = 2, spec_resolved_index = 2,
        dev_index = 1, test_index = 0
    WHERE task_id = ?
  `).run(taskId);
  db.prepare(`
    INSERT INTO task_lanes(task_id, lane, status, current_agent, current_story_index)
    VALUES(?, 'analysis', 'completed', NULL, NULL)
    ON CONFLICT(task_id, lane) DO UPDATE SET status = 'completed', current_agent = NULL, current_story_index = NULL
  `).run(taskId);
  db.prepare(`
    INSERT INTO task_lanes(task_id, lane, status, current_agent, current_story_index)
    VALUES(?, 'delivery', 'runnable', NULL, NULL)
    ON CONFLICT(task_id, lane) DO UPDATE SET status = 'runnable', current_agent = NULL, current_story_index = NULL
  `).run(taskId);

  const first = await syncLegacyDeliveryWorkItems(taskId);
  assert.equal(first.items.find((item) => item.work_key === 'delivery:test:1')?.status, 'ready');
  assert.equal(first.items.filter((item) => item.status === 'ready' && item.lane === 'delivery').length, 1);

  db.prepare(`
    UPDATE tasks SET test_index = 1, current_subagent = 'dev-agent' WHERE task_id = ?
  `).run(taskId);
  const second = await syncLegacyDeliveryWorkItems(taskId);
  assert.equal(second.items.find((item) => item.work_key === 'delivery:test:1')?.status, 'completed');
  assert.equal(second.items.find((item) => item.work_key === 'delivery:dev:2')?.status, 'ready');
  assert.equal(second.items.filter((item) => item.status === 'ready' && item.lane === 'delivery').length, 1);
  assert.equal(second.items.filter((item) => item.status !== 'superseded').length, 10);
  assert.equal(new Set(second.items.filter((item) => item.status !== 'superseded').map((item) => item.revision)).size, 1);
  assert.equal(second.dependencies.length, 12);

  const third = await syncLegacyDeliveryWorkItems(taskId);
  assert.deepEqual(
    third.items.map((item) => [item.item_id, item.work_key, item.revision, item.status]),
    second.items.map((item) => [item.item_id, item.work_key, item.revision, item.status]),
  );
});

test('preserves completed work while cancelling only unfinished projected items', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask } = await import('../test/legacy-task-fixtures');
  const { syncLegacyDeliveryWorkItems } = await import('./work-items');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Cancelled work graph projection' });
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'cancelled', current_subagent = NULL,
        total_stories = 2, analysis_index = 1, spec_resolved_index = 1,
        dev_index = 1, test_index = 0
    WHERE task_id = ?
  `).run(taskId);

  const projection = await syncLegacyDeliveryWorkItems(taskId);
  const status = new Map(projection.items.map((item) => [item.work_key, item.status]));
  assert.equal(status.get('delivery:plan'), 'completed');
  assert.equal(status.get('delivery:analysis:1'), 'completed');
  assert.equal(status.get('delivery:dev:1'), 'completed');
  assert.equal(status.get('delivery:test:1'), 'cancelled');
  assert.equal(status.get('delivery:analysis:2'), 'cancelled');
  assert.equal(status.get('delivery:review'), 'cancelled');
  assert.equal(status.get('delivery:closure'), 'cancelled');

  const repeated = await syncLegacyDeliveryWorkItems(taskId);
  assert.deepEqual(
    repeated.items.map((item) => [item.item_id, item.work_key, item.revision, item.status]),
    projection.items.map((item) => [item.item_id, item.work_key, item.revision, item.status]),
  );
});

test('projects a legacy rewind as a new work item revision instead of erasing completion history', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const { createTask } = await import('../test/legacy-task-fixtures');
  const { syncLegacyDeliveryWorkItems } = await import('./work-items');
  const db = await databaseConnection();
  const taskId = await createTask({ title: 'Legacy rewind revision projection' });
  db.prepare(`
    UPDATE tasks
    SET agile_status = 'in dev', current_subagent = 'test-agent',
        total_stories = 1, analysis_index = 1, spec_resolved_index = 1,
        dev_index = 1, test_index = 1
    WHERE task_id = ?
  `).run(taskId);
  db.prepare(`
    INSERT INTO task_lanes(task_id, lane, status, current_agent, current_story_index)
    VALUES(?, 'analysis', 'completed', NULL, NULL)
    ON CONFLICT(task_id, lane) DO UPDATE SET status = 'completed', current_agent = NULL, current_story_index = NULL
  `).run(taskId);
  db.prepare(`
    INSERT INTO task_lanes(task_id, lane, status, current_agent, current_story_index)
    VALUES(?, 'delivery', 'completed', NULL, NULL)
    ON CONFLICT(task_id, lane) DO UPDATE SET status = 'completed', current_agent = NULL, current_story_index = NULL
  `).run(taskId);
  const before = await syncLegacyDeliveryWorkItems(taskId);
  const completedDev = before.items.find((item) => item.work_key === 'delivery:dev:1');
  const completedTest = before.items.find((item) => item.work_key === 'delivery:test:1');
  assert.equal(completedDev?.status, 'completed');
  assert.equal(completedTest?.status, 'completed');

  db.prepare(`
    UPDATE tasks
    SET current_subagent = 'dev-agent', dev_index = 0, test_index = 0
    WHERE task_id = ?
  `).run(taskId);
  db.prepare(`
    UPDATE task_lanes
    SET status = 'runnable', current_agent = NULL, current_story_index = NULL
    WHERE task_id = ? AND lane = 'delivery'
  `).run(taskId);
  const after = await syncLegacyDeliveryWorkItems(taskId);
  const devRevisions = after.items.filter((item) => item.work_key === 'delivery:dev:1');
  const testRevisions = after.items.filter((item) => item.work_key === 'delivery:test:1');
  assert.deepEqual(devRevisions.map((item) => [item.revision, item.status]), [[1, 'superseded'], [2, 'ready']]);
  assert.deepEqual(testRevisions.map((item) => [item.revision, item.status]), [[1, 'superseded'], [2, 'pending']]);
  assert.equal(devRevisions[0]?.item_id, completedDev?.item_id);
  assert.equal(testRevisions[0]?.item_id, completedTest?.item_id);
  assert.ok(devRevisions[0]?.completed_at);
  assert.ok(testRevisions[0]?.completed_at);
});
