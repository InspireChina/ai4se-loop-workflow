import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { createTaskInDb, createTaskSchema } from './tasks';
import { progressDispatchInspector } from './progress-dispatch';
import { BROWSER_EXCLUSIVE_RESOURCE } from './resource-claims';

test('native dispatch inspection works with writes forbidden and leaves stale claims and display projections untouched', async () => {
  const db = await databaseConnection();
  const taskId = `REQ-${randomUUID()}`;
  const staleTaskId = `REQ-${randomUUID()}`;
  db.transaction(() => {
    for (const id of [taskId, staleTaskId]) createTaskInDb(db, createTaskSchema.parse({ title: 'Read-only native inspection', itemType: 'direct' }), id);
    db.prepare("UPDATE tasks SET is_paused = 1 WHERE task_id = ?").run(staleTaskId);
    db.prepare("INSERT INTO resource_claims(resource_key, owner_task_id, owner_lane) VALUES(?, ?, 'control')").run(BROWSER_EXCLUSIVE_RESOURCE, staleTaskId);
  })();
  const claim = db.prepare('SELECT * FROM resource_claims WHERE owner_task_id = ?').get(staleTaskId);
  const totalChanges = (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
  db.pragma('query_only = ON');
  try {
    const detail = await progressDispatchInspector.inspect({ requirementId: taskId });
    assert.equal(detail.requirementId, taskId);
    assert.ok(detail.decisions.length);
    await progressDispatchInspector.inspectAll();
  } finally { db.pragma('query_only = OFF'); }
  assert.equal((db.prepare('SELECT total_changes() AS count').get() as { count: number }).count, totalChanges);
  assert.deepEqual(db.prepare('SELECT * FROM resource_claims WHERE owner_task_id = ?').get(staleTaskId), claim);
});
