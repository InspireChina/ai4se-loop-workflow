import assert from 'node:assert/strict';
import test from 'node:test';

test('resource claims allow one owner and make same-owner acquisition idempotent', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const {
    CODE_WORKSPACE_RESOURCE,
    releaseResourceClaimInDb,
    resourceClaimInDb,
    tryAcquireResourceClaimInDb,
  } = await import('./resource-claims');
  const db = await databaseConnection();
  db.prepare('DELETE FROM resource_claims WHERE resource_key = ?').run(CODE_WORKSPACE_RESOURCE);
  for (const taskId of ['TASK-resource-owner-a', 'TASK-resource-owner-b']) {
    db.prepare(`
      INSERT OR IGNORE INTO tasks(task_id, title, item_type, agile_status, work_dir)
      VALUES(?, ?, 'feature', 'ready for dev', '')
    `).run(taskId, taskId);
  }

  assert.equal(tryAcquireResourceClaimInDb(db, {
    resourceKey: CODE_WORKSPACE_RESOURCE,
    taskId: 'TASK-resource-owner-a',
    lane: 'delivery',
    storyIndex: 1,
    executionId: null,
  }), true);
  assert.equal(tryAcquireResourceClaimInDb(db, {
    resourceKey: CODE_WORKSPACE_RESOURCE,
    taskId: 'TASK-resource-owner-a',
    lane: 'delivery',
    storyIndex: 1,
    executionId: null,
  }), true);
  assert.equal(tryAcquireResourceClaimInDb(db, {
    resourceKey: CODE_WORKSPACE_RESOURCE,
    taskId: 'TASK-resource-owner-b',
    lane: 'delivery',
    storyIndex: 1,
    executionId: null,
  }), false);
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE)?.owner_task_id, 'TASK-resource-owner-a');
  assert.equal(releaseResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, 'TASK-resource-owner-b'), false);
  assert.equal(releaseResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, 'TASK-resource-owner-a'), true);
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE), undefined);
});

test('a terminal task cannot retain a resource claim', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const {
    CODE_WORKSPACE_RESOURCE,
    activeResourceClaimInDb,
    resourceClaimInDb,
    tryAcquireResourceClaimInDb,
  } = await import('./resource-claims');
  const db = await databaseConnection();
  db.prepare('DELETE FROM resource_claims WHERE resource_key = ?').run(CODE_WORKSPACE_RESOURCE);
  const taskId = 'TASK-resource-terminal-owner';
  db.prepare(`
    INSERT OR IGNORE INTO tasks(task_id, title, item_type, agile_status, work_dir)
    VALUES('TASK-resource-owner-b', 'Replacement resource owner', 'feature', 'ready for dev', '')
  `).run();
  db.prepare(`
    INSERT OR REPLACE INTO tasks(
      task_id, title, item_type, agile_status, closure_status, run_state, work_dir
    ) VALUES(?, 'Terminal resource owner', 'feature', 'done', 'acknowledged', 'idle', '')
  `).run(taskId);
  db.prepare(`
    INSERT INTO resource_claims(resource_key, owner_task_id, owner_lane)
    VALUES(?, ?, 'delivery')
  `).run(CODE_WORKSPACE_RESOURCE, taskId);

  assert.equal(activeResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE), undefined);
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE), undefined);
  assert.equal(tryAcquireResourceClaimInDb(db, {
    resourceKey: CODE_WORKSPACE_RESOURCE,
    taskId: 'TASK-resource-owner-b',
    lane: 'delivery',
  }), true);
  db.prepare('DELETE FROM resource_claims WHERE resource_key = ?').run(CODE_WORKSPACE_RESOURCE);
});

test('browser claims are execution-scoped and multi-resource acquisition is atomic', async () => {
  const { databaseConnection } = await import('../infrastructure/database');
  const {
    BROWSER_EXCLUSIVE_RESOURCE,
    CODE_WORKSPACE_RESOURCE,
    ResourceBusyError,
    acquireResourceClaimsInDb,
    releaseExecutionResourceClaimsInDb,
    releaseResourceClaimInDb,
    resourceClaimInDb,
    tryAcquireResourceClaimInDb,
  } = await import('./resource-claims');
  const db = await databaseConnection();
  db.prepare('DELETE FROM resource_claims').run();
  for (const taskId of ['TASK-browser-owner-a', 'TASK-browser-owner-b']) {
    db.prepare(`
      INSERT OR IGNORE INTO tasks(task_id, title, item_type, agile_status, work_dir)
      VALUES(?, ?, 'feature', 'ready for dev', '')
    `).run(taskId, taskId);
  }
  const insertExecution = db.prepare(`
    INSERT OR IGNORE INTO execution_attempts(
      execution_id, run_id, task_id, story_index, agent, pipeline, lane,
      delegation_key, attempt, status, input_hash, input_json
    ) VALUES(?, 'RUN-browser-resource', ?, 1, 'test-agent', 'test', 'delivery', ?, 1, 'running', ?, '{}')
  `);
  for (const [executionId, taskId] of [
    ['EXEC-browser-a-1', 'TASK-browser-owner-a'],
    ['EXEC-browser-a-2', 'TASK-browser-owner-a'],
    ['EXEC-browser-b-1', 'TASK-browser-owner-b'],
  ]) {
    insertExecution.run(executionId, taskId, `key-${executionId}`, `hash-${executionId}`);
  }

  assert.equal(tryAcquireResourceClaimInDb(db, {
    resourceKey: BROWSER_EXCLUSIVE_RESOURCE,
    taskId: 'TASK-browser-owner-a',
    lane: 'delivery',
    storyIndex: 1,
    executionId: 'EXEC-browser-a-1',
  }), true);
  assert.equal(tryAcquireResourceClaimInDb(db, {
    resourceKey: BROWSER_EXCLUSIVE_RESOURCE,
    taskId: 'TASK-browser-owner-a',
    lane: 'delivery',
    storyIndex: 1,
    executionId: 'EXEC-browser-a-1',
  }), true);
  assert.equal(tryAcquireResourceClaimInDb(db, {
    resourceKey: BROWSER_EXCLUSIVE_RESOURCE,
    taskId: 'TASK-browser-owner-a',
    lane: 'delivery',
    storyIndex: 1,
    executionId: 'EXEC-browser-a-2',
  }), false);

  releaseExecutionResourceClaimsInDb(db, 'EXEC-browser-a-1');
  assert.equal(tryAcquireResourceClaimInDb(db, {
    resourceKey: BROWSER_EXCLUSIVE_RESOURCE,
    taskId: 'TASK-browser-owner-b',
    lane: 'delivery',
    storyIndex: 1,
    executionId: 'EXEC-browser-b-1',
  }), true);
  assert.throws(() => acquireResourceClaimsInDb(db, {
    resourceKeys: [CODE_WORKSPACE_RESOURCE, BROWSER_EXCLUSIVE_RESOURCE],
    taskId: 'TASK-browser-owner-a',
    lane: 'delivery',
    storyIndex: 1,
    executionId: 'EXEC-browser-a-2',
  }), ResourceBusyError);
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE), undefined);
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE)?.owner_task_id, 'TASK-browser-owner-b');

  releaseExecutionResourceClaimsInDb(db, 'EXEC-browser-b-1');
  acquireResourceClaimsInDb(db, {
    resourceKeys: [CODE_WORKSPACE_RESOURCE, BROWSER_EXCLUSIVE_RESOURCE],
    taskId: 'TASK-browser-owner-a',
    lane: 'delivery',
    storyIndex: 1,
    executionId: 'EXEC-browser-a-2',
  });
  releaseExecutionResourceClaimsInDb(db, 'EXEC-browser-a-2');
  assert.equal(resourceClaimInDb(db, BROWSER_EXCLUSIVE_RESOURCE), undefined);
  assert.equal(resourceClaimInDb(db, CODE_WORKSPACE_RESOURCE)?.owner_task_id, 'TASK-browser-owner-a');
  releaseResourceClaimInDb(db, CODE_WORKSPACE_RESOURCE, 'TASK-browser-owner-a');
});
