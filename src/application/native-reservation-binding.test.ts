import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseConnection } from '../infrastructure/database';
import { beginRun, endRun, createTaskInDb, createTaskSchema, cancelTask, type DelegationEnvelope } from './tasks';
import { planDispatchInDb } from './dispatch-planner';
import { createProgressDispatcher } from './progress-dispatch';

const defects: Record<string, (work: DelegationEnvelope) => DelegationEnvelope> = {
  'missing item identity': work => ({ ...work, workItemId: undefined }),
  'unknown item identity': work => ({ ...work, workItemId: randomUUID() }),
  'wrong revision': work => ({ ...work, workItemRevision: work.workItemRevision! + 1 }),
  'wrong dispatch epoch': work => ({ ...work, workItemEpoch: work.workItemEpoch! + 1 }),
  'wrong role': work => ({ ...work, agent: 'test-agent' }),
  'wrong pipeline': work => ({ ...work, pipeline: 'test' }),
  'wrong unit': work => ({ ...work, storyIndex: 1 }),
};

for (const [name, corrupt] of Object.entries(defects)) {
  test(`native reservation refuses ${name} without creating execution, claims or graph events`, async () => {
    const db = await databaseConnection();
    db.prepare('UPDATE tasks SET is_paused = 1').run();
    const task = db.transaction(() => createTaskInDb(db, createTaskSchema.parse({ title: 'Binding fixture' }),
      `REQ-${randomUUID()}`))();
    const work = planDispatchInDb(db).find(work => work.taskId === task.task_id)!;
    assert.ok(work.workItemId);
    const before = db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(task.task_id);
    const eventsBefore = db.prepare(`SELECT event.* FROM workflow_item_events event JOIN workflow_items item
      ON item.item_id = event.item_id WHERE item.task_id = ? ORDER BY event.rowid`).all(task.task_id);
    const dispatcher = createProgressDispatcher(() => [corrupt(work)]);
    const runId = await beginRun('native-binding-fixture');
    try {
      await assert.rejects(dispatcher.reserveNext({ runId }), /派发快照缺失或不一致/);
      assert.equal(db.prepare('SELECT 1 FROM execution_attempts WHERE task_id = ?').get(task.task_id), undefined);
      assert.equal(db.prepare('SELECT 1 FROM resource_claims WHERE owner_task_id = ?').get(task.task_id), undefined);
      assert.deepEqual(db.prepare('SELECT * FROM workflow_items WHERE task_id = ? ORDER BY item_id').all(task.task_id), before);
      assert.deepEqual(db.prepare(`SELECT event.* FROM workflow_item_events event JOIN workflow_items item
        ON item.item_id = event.item_id WHERE item.task_id = ? ORDER BY event.rowid`).all(task.task_id), eventsBefore);
    } finally {
      await cancelTask({ taskId: task.task_id, reason: 'Finish binding fixture' });
      await endRun(runId, false, { stopRunner: false });
    }
  });
}
